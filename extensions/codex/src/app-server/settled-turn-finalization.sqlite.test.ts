import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentMessage,
  EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { captureCodexSettledTurnFinalizationContext } from "./settled-turn-context.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const mocks = vi.hoisted(() => ({
  runBounded: vi.fn(),
}));

vi.mock("./bounded-turn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bounded-turn.js")>()),
  runBoundedCodexAppServerTurn: mocks.runBounded,
}));

const { runCodexSettledTurnFinalization } = await import("./settled-turn-finalizer.js");

const tempDirs: string[] = [];

afterEach(async () => {
  mocks.runBounded.mockReset();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function message(value: unknown, identity: string): AgentMessage {
  return attachCodexMirrorIdentity(value as AgentMessage, identity);
}

describe("Codex settled-turn finalization with historical SQLite prompt pairs", () => {
  it("returns one visible reply without replaying the settled side effect", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-settled-sqlite-"));
    tempDirs.push(root);
    const target = {
      agentId: "main",
      sessionId: "session-historical-pair",
      sessionKey: "agent:main:session-historical-pair",
      storePath: path.join(root, "openclaw-agent.sqlite"),
    };
    const sessionFile = `sqlite:${target.agentId}:${target.sessionId}:${target.storePath}`;
    await upsertSessionEntry({
      ...target,
      entry: { sessionFile, sessionId: target.sessionId, updatedAt: 1 },
    });

    const idempotencyKey = "run-side-effect:user";
    const mirroredPrompt = message(
      { role: "user", content: "Send the update.", idempotencyKey, timestamp: 1 },
      "turn-side-effect:prompt",
    );
    const canonicalPrompt = structuredClone(mirroredPrompt);
    const toolCall = message(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-side-effect",
            name: "message",
            arguments: { target: "alice" },
          },
        ],
        timestamp: 2,
      },
      "turn-side-effect:tool:call-side-effect:call",
    );
    const toolResult = message(
      {
        role: "toolResult",
        toolCallId: "call-side-effect",
        toolName: "message",
        content: [{ type: "text", text: "sent once" }],
        timestamp: 3,
      },
      "turn-side-effect:tool:call-side-effect:result",
    );
    const seeded = [
      { eventId: "mirror-prompt", parentId: null, message: mirroredPrompt },
      {
        eventId: "canonical-prompt",
        parentId: "mirror-prompt",
        message: canonicalPrompt,
        idempotencyLookup: "caller-checked" as const,
      },
      { eventId: "tool-call", parentId: "canonical-prompt", message: toolCall },
      { eventId: "tool-result", parentId: "tool-call", message: toolResult },
    ];
    for (const entry of seeded) {
      await appendSessionTranscriptMessageByIdentity({ ...target, ...entry, cwd: root });
    }

    const settledMessages = [canonicalPrompt, toolCall, toolResult];
    const context = await captureCodexSettledTurnFinalizationContext({
      ...target,
      sessionFile,
      mirroredMessages: settledMessages,
      settledMessages,
      turnId: "turn-side-effect",
    });
    expect(context?.messages).toEqual(settledMessages);

    mocks.runBounded.mockResolvedValue({
      text: "FINALIZED-WITHOUT-REPLAY",
      items: [],
      model: "gpt-5.4",
      usage: { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, total: 9 },
    });
    const attempt = {
      prompt: "Produce the final user-visible answer now.",
      ...target,
      sessionFile,
      sessionTarget: { storePath: target.storePath },
      workspaceDir: root,
      runId: "run-side-effect",
      timeoutMs: 5_000,
      provider: "codex",
      modelId: "gpt-5.4",
      model: {
        id: "gpt-5.4",
        provider: "codex",
        api: "openai-chatgpt-responses",
      } as Model,
      authStorage: {} as never,
      authProfileStore: { version: 1, profiles: {} },
      modelRegistry: {} as never,
      thinkLevel: "low",
    } as EmbeddedRunAttemptParams;
    const settledAttempt = {
      terminal: { kind: "ok" },
      sessionIdUsed: target.sessionId,
      messagesSnapshot: settledMessages,
      settledTurnFinalizationContext: context,
      lastAssistant: undefined,
      assistantTexts: [],
      toolMetas: [{ toolName: "message", replaySafe: false }],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["update"],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      toolMediaUrls: [],
      toolAudioAsVoice: false,
      hasToolMediaBlockReply: false,
      successfulCronAdds: 0,
      cloudCodeAssistFormatError: false,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    } as EmbeddedRunAttemptResult;

    const result = await runCodexSettledTurnFinalization(
      { attempt, settledAttempt },
      { pluginConfig: {} },
    );

    expect(result.assistant.content).toEqual([{ type: "text", text: "FINALIZED-WITHOUT-REPLAY" }]);
    expect(mocks.runBounded).toHaveBeenCalledOnce();
    expect(mocks.runBounded).toHaveBeenCalledWith(
      expect.objectContaining({
        requireNoExternalCapabilities: true,
        historyItems: [
          expect.objectContaining({ type: "message", role: "user" }),
          expect.objectContaining({ type: "function_call", call_id: "call-side-effect" }),
          expect.objectContaining({ type: "function_call_output", call_id: "call-side-effect" }),
        ],
      }),
    );

    const events = (await readSessionTranscriptEvents(target)) as Array<{
      id?: string;
      parentId?: string | null;
      message?: AgentMessage;
      type?: string;
    }>;
    const messages = events.filter((event) => event.type === "message");
    expect(messages.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
      { id: "mirror-prompt", parentId: null },
      { id: "canonical-prompt", parentId: "mirror-prompt" },
      { id: "tool-call", parentId: "canonical-prompt" },
      { id: "tool-result", parentId: "tool-call" },
      { id: expect.any(String), parentId: "tool-result" },
    ]);
    expect(messages.filter((event) => event.message?.role === "toolResult")).toHaveLength(1);
    expect(messages.at(-1)?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "FINALIZED-WITHOUT-REPLAY" }],
    });
  });
});
