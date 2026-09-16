import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAccountingPersistenceFixtures,
  diagnostic,
  modelRequest,
} from "./agent-runner-result-accounting.persistence.test-support.js";

vi.mock("../../agents/live-model-switch.js", () => ({
  consolidateLiveModelSwitchAfterRun: vi.fn(async () => {}),
}));

const fixtures = createAccountingPersistenceFixtures();
const { createFixture } = fixtures;
beforeAll(fixtures.setup);
afterAll(fixtures.teardown);
afterEach(fixtures.cleanupTempDirs);
afterEach(fixtures.cleanupOperations);

describe.each(["ordinary", "followup"] as const)("%s model endpoint accounting", (lane) => {
  it("persists a dispatched request from a rejected turn without provider result metadata", async () => {
    const fixture = await createFixture();
    const before = fixture.read();
    await fixture.accountRejected(lane, modelRequest);
    expect(fixture.context.execution.result.meta.agentMeta).toBeUndefined();
    expect(fixture.read()).toMatchObject({
      model: before?.model,
      modelProvider: before?.modelProvider,
      estimatedCostUsd: before?.estimatedCostUsd,
      lastModelRequest: modelRequest,
    });
  });

  it.each(["closed operation", "replacement session"])(
    "does not persist a rejected request after %s",
    async (replacement) => {
      const fixture = await createFixture();
      if (replacement === "closed operation") {
        fixture.context.replyOperation.complete();
      } else {
        await fixture.replace({
          ...fixture.context.activeSessionEntry!,
          sessionId: `${fixture.sessionId}-replacement`,
        });
      }
      const before = fixture.read();
      await fixture.accountRejected(lane, modelRequest);
      expect(fixture.read()).toEqual(before);
    },
  );

  it("prefers the turn's request fact over the terminal candidate's older result", async () => {
    const fixture = await createFixture();
    fixture.context.execution.lastModelRequest = modelRequest;
    await fixture.account(lane, {
      lastModelRequest: { ...modelRequest, endpoint: "https://older.example", timestamp: 10 },
    });
    expect(fixture.read()?.lastModelRequest).toEqual(modelRequest);
  });

  it("records the fallback request without replacing the session's selected model", async () => {
    const fixture = await createFixture();
    const request = { ...modelRequest, model: "fallback-model" };
    fixture.context.execution.resolved = { provider: request.provider, model: request.model };
    fixture.context.execution.fallback.attempts = [
      { provider: diagnostic.provider, model: diagnostic.model, reason: "auth", error: "No login" },
    ];

    await fixture.account(lane, {
      provider: request.provider,
      model: request.model,
      lastModelRequest: request,
    });

    expect(fixture.read()).toMatchObject({
      modelProvider: diagnostic.provider,
      model: diagnostic.model,
      lastModelRequest: request,
    });
  });

  it.each([
    { next: "unobserved", request: undefined },
    {
      next: "older",
      request: { ...modelRequest, timestamp: 10, endpoint: "https://older.example/v1/responses" },
    },
  ])("retains the newer endpoint when the next result is $next", async ({ request }) => {
    const fixture = await createFixture();
    await fixture.account(lane, { lastModelRequest: modelRequest });
    expect(fixture.read()?.lastModelRequest).toEqual(modelRequest);

    await fixture.account(lane, { lastModelRequest: request });

    expect(fixture.read()?.lastModelRequest).toEqual(modelRequest);
  });
});
