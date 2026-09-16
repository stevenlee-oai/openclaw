import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  getCoreTtsAttemptResultMediaUrls,
  markCoreTtsAttemptResult,
} from "../../tools/tts-tool-result-provenance.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const harnessMocks = vi.hoisted(() => ({
  runAttempt: vi.fn(),
  settleRequester: vi.fn(),
}));

vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessAttempt: harnessMocks.runAttempt,
  runAgentHarnessSettledTurnFinalization: vi.fn(),
}));

vi.mock("../../subagents/registry/subagent-registry.js", () => ({
  settleRequesterAfterSessionSpawns: harnessMocks.settleRequester,
}));

describe("embedded attempt backend", () => {
  beforeEach(() => {
    harnessMocks.runAttempt.mockReset();
    harnessMocks.settleRequester.mockReset();
  });

  it("retains the latest sanitized dispatch and ignores callbacks after settlement", async () => {
    let report: EmbeddedRunAttemptParams["onModelRequest"];
    const observed = vi.fn(() => {
      throw new Error("diagnostic sink failed");
    });
    harnessMocks.runAttempt.mockImplementationOnce(async (params: EmbeddedRunAttemptParams) => {
      report = params.onModelRequest;
      report?.({ url: "https://example.test/private-key/responses?key=secret", transport: "http" });
      report?.({
        url: "wss://chatgpt.com/backend-api/codex/responses?secret=hidden",
        transport: "websocket",
        model: "wire-model",
      });
      return makeEmbeddedRunnerAttempt({});
    });
    const result = await runEmbeddedAttemptWithBackend(
      {
        provider: "openai",
        model: { id: "selected-model" },
      } as EmbeddedRunAttemptParams,
      undefined,
      observed,
    );
    expect(result.lastModelRequest).toEqual({
      provider: "openai",
      model: "wire-model",
      endpoint: "wss://chatgpt.com/backend-api/codex/responses",
      transport: "websocket",
      timestamp: expect.any(Number),
    });
    report?.({ url: "https://other.test/v1/responses", transport: "http" });
    expect(result.lastModelRequest?.endpoint).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(JSON.stringify(result.lastModelRequest)).not.toContain("secret");
    expect(observed).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a prepared route or retained harness result for a dispatched request", async () => {
    harnessMocks.runAttempt.mockResolvedValueOnce({
      ...makeEmbeddedRunnerAttempt({}),
      lastModelRequest: { endpoint: "https://stale.test/private-key" },
    });
    const result = await runEmbeddedAttemptWithBackend({
      provider: "openai",
      model: { id: "selected-model", baseUrl: "https://api.openai.com/v1" },
    } as EmbeddedRunAttemptParams);
    expect(result.lastModelRequest).toBeUndefined();
  });

  it("reports a dispatched request even when the harness throws", async () => {
    const observed = vi.fn();
    harnessMocks.runAttempt.mockImplementationOnce(async (params: EmbeddedRunAttemptParams) => {
      params.onModelRequest?.({ url: "https://api.openai.com/v1/responses", transport: "http" });
      throw new Error("upstream failed");
    });
    await expect(
      runEmbeddedAttemptWithBackend(
        {
          provider: "openai",
          model: { id: "selected-model" },
        } as EmbeddedRunAttemptParams,
        undefined,
        observed,
      ),
    ).rejects.toThrow("upstream failed");
    expect(observed).toHaveBeenCalledExactlyOnceWith({
      provider: "openai",
      model: "selected-model",
      endpoint: "https://api.openai.com/v1/responses",
      transport: "http",
      timestamp: expect.any(Number),
    });
  });

  it.each([
    { yielded: true, settled: true, accepted: true, expected: true },
    { yielded: true, settled: false, accepted: true, expected: undefined },
    { yielded: false, settled: true, accepted: true, expected: undefined },
    { yielded: true, settled: false, accepted: false, expected: undefined },
  ])(
    "requires core settlement before acknowledging continuation ($yielded/$settled/$accepted)",
    async ({ yielded, settled, accepted, expected }) => {
      harnessMocks.settleRequester.mockReturnValue(settled);
      harnessMocks.runAttempt.mockResolvedValueOnce(
        makeEmbeddedRunnerAttempt({
          agentHarnessId: "codex",
          yieldDetected: yielded,
          // A harness-supplied value must not manufacture core settlement.
          requesterContinuationSettled: true,
          acceptedSessionSpawns: accepted
            ? [{ runId: "child", childSessionKey: "agent:main:subagent:child" }]
            : [],
        }),
      );
      const result = await runEmbeddedAttemptWithBackend({
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "parent",
      } as never);
      expect(result.requesterContinuationSettled).toBe(expected);
    },
  );

  it("does not return a continuation acknowledgment when registry persistence throws", async () => {
    harnessMocks.settleRequester.mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    harnessMocks.runAttempt.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        agentHarnessId: "codex",
        yieldDetected: true,
        acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:subagent:child" }],
      }),
    );
    await expect(
      runEmbeddedAttemptWithBackend({
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "parent",
      } as never),
    ).rejects.toThrow("storage unavailable");
  });

  it("preserves the built-in runner's completed settlement", async () => {
    harnessMocks.runAttempt.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        agentHarnessId: "openclaw",
        yieldDetected: true,
        requesterContinuationSettled: true,
      }),
    );
    const result = await runEmbeddedAttemptWithBackend({} as never);
    expect(result.requesterContinuationSettled).toBe(true);
    expect(harnessMocks.settleRequester).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps runtime model selection only for prepared ownership (%s)",
    async (runtimeOwned) => {
      const selection = { provider: "native-provider", model: "native-model" };
      harnessMocks.runAttempt.mockResolvedValueOnce({
        agentHarnessId: "native-runtime",
        runtimeModelSelection: selection,
      });
      const nativeRuntime: NonNullable<Parameters<typeof runEmbeddedAttemptWithBackend>[1]> = {
        harness: {
          id: "native-runtime",
          label: "Native runtime",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unexpected direct harness call");
          },
        },
        auth: "native",
        assertCurrent: async () => {},
      };
      const result = await runEmbeddedAttemptWithBackend(
        {} as never,
        runtimeOwned ? nativeRuntime : undefined,
      );
      if (runtimeOwned) {
        expect(result).toMatchObject({ runtimeModelSelection: selection });
      } else {
        expect(result).not.toHaveProperty("runtimeModelSelection");
      }
    },
  );

  it("preserves core TTS delivery provenance through backend projection", async () => {
    const operationalRunInstance = {};
    const attempt = markCoreTtsAttemptResult(
      {
        agentHarnessId: "openclaw",
        toolMediaUrls: ["/tmp/reply.opus"],
      },
      ["/tmp/reply.opus"],
      operationalRunInstance,
    );
    harnessMocks.runAttempt.mockResolvedValueOnce(attempt);

    const result = await runEmbeddedAttemptWithBackend({} as never);

    expect(
      getCoreTtsAttemptResultMediaUrls(result, result.toolMediaUrls, operationalRunInstance),
    ).toEqual(["/tmp/reply.opus"]);
  });

  it.each([
    {
      name: "replaces stale harness provenance",
      credentialSource: {
        kind: "direct" as const,
        evidence: "environment" as const,
        authorization: "ambient" as const,
      },
      expected: {
        provider: "groq",
        model: "openai/gpt-oss-120b",
        credentialSource: {
          kind: "direct",
          evidence: "environment",
          authorization: "ambient",
        },
      },
    },
    {
      name: "clears provenance when the runtime does not own auth selection",
      credentialSource: undefined,
      expected: undefined,
    },
  ])("$name", async ({ credentialSource, expected }) => {
    harnessMocks.runAttempt.mockResolvedValueOnce({
      agentHarnessId: "openclaw",
      modelAttempt: {
        provider: "stale-provider",
        model: "stale-model",
        credentialSource: { kind: "profile" },
      },
    });

    const result = await runEmbeddedAttemptWithBackend({
      runtimePlan: {
        resolvedRef: { provider: "groq", modelId: "openai/gpt-oss-120b" },
        auth: credentialSource ? { credentialSource } : {},
      },
    } as never);

    expect(result.modelAttempt).toEqual(expected);
  });
});
