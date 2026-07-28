import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureCodexSettledTurnFinalizationContext } from "./settled-turn-context.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const mocks = vi.hoisted(() => ({
  readHistory: vi.fn(),
}));

vi.mock("./session-history.js", () => ({
  readCodexMirroredSessionHistoryMessages: mocks.readHistory,
}));

function message(value: unknown, identity: string): AgentMessage {
  return attachCodexMirrorIdentity(value as AgentMessage, identity);
}

function settledTurn() {
  return [
    message({ role: "user", content: "Send it." }, "turn-2:prompt"),
    message(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-2", name: "message", arguments: {} }],
      },
      "turn-2:tool:call-2:call",
    ),
    message(
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "message",
        content: [{ type: "text", text: "sent" }],
      },
      "turn-2:tool:call-2:result",
    ),
  ];
}

async function captureContext(params: {
  historyMessages: AgentMessage[];
  mirroredMessages: AgentMessage[];
  settledMessages: AgentMessage[];
  turnId?: string;
}) {
  mocks.readHistory.mockResolvedValue(params.historyMessages);
  return captureCodexSettledTurnFinalizationContext({
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-1",
    mirroredMessages: params.mirroredMessages,
    settledMessages: params.settledMessages,
    turnId: params.turnId ?? "turn-2",
  });
}

describe("captureCodexSettledTurnFinalizationContext", () => {
  beforeEach(() => {
    mocks.readHistory.mockReset();
  });

  it("freezes the complete active branch exactly through the current tool-result boundary", async () => {
    const prior = message({ role: "user", content: "Alice is the recipient." }, "turn-1:prompt");
    const settledMessages = settledTurn();
    const later = message({ role: "user", content: "later message" }, "turn-3:prompt");
    const historyMessages = [prior, ...settledMessages, later];

    const context = await captureContext({
      historyMessages,
      mirroredMessages: settledMessages,
      settledMessages,
      turnId: "turn-2",
    });

    expect(context).toEqual({
      source: "openclaw-transcript",
      messages: [prior, ...settledMessages],
    });
    expect(Object.isFrozen(context?.messages)).toBe(true);
    expect(context?.messages).not.toBe(historyMessages);
  });

  it("keeps the later canonical prompt from an exact historical prompt pair", async () => {
    const prior = message({ role: "user", content: "Earlier context." }, "turn-1:prompt");
    const settledMessages = settledTurn();
    const mirroredPrompt = message(
      {
        role: "user",
        content: "Send it.",
        idempotencyKey: "run-2:user",
        __openclaw: { rowOwner: "codex-mirror" },
      },
      "turn-2:prompt",
    );
    const canonicalPrompt = message(
      {
        role: "user",
        content: "Send it.",
        idempotencyKey: "run-2:user",
        __openclaw: { rowOwner: "session-manager" },
      },
      "turn-2:prompt",
    );
    const historyMessages = [
      prior,
      mirroredPrompt,
      canonicalPrompt,
      settledMessages[1]!,
      settledMessages[2]!,
    ];

    const context = await captureContext({
      historyMessages,
      mirroredMessages: settledMessages,
      settledMessages,
      turnId: "turn-2",
    });

    expect(context).toEqual({
      source: "openclaw-transcript",
      messages: [prior, canonicalPrompt, settledMessages[1]!, settledMessages[2]!],
    });
  });

  it.each([
    {
      name: "missing idempotency key",
      pair: [
        message({ role: "user", content: "Send it." }, "turn-2:prompt"),
        message({ role: "user", content: "Send it." }, "turn-2:prompt"),
      ],
    },
    {
      name: "different idempotency keys",
      pair: [
        message(
          { role: "user", content: "Send it.", idempotencyKey: "run-2:user" },
          "turn-2:prompt",
        ),
        message(
          { role: "user", content: "Send it.", idempotencyKey: "other:user" },
          "turn-2:prompt",
        ),
      ],
    },
    {
      name: "payload drift",
      pair: [
        message(
          { role: "user", content: "Send it.", idempotencyKey: "run-2:user" },
          "turn-2:prompt",
        ),
        message(
          { role: "user", content: "Send something else.", idempotencyKey: "run-2:user" },
          "turn-2:prompt",
        ),
      ],
    },
    {
      name: "non-prompt identity",
      pair: [
        message({ role: "user", content: "Send it.", idempotencyKey: "run-2:user" }, "turn-2:user"),
        message({ role: "user", content: "Send it.", idempotencyKey: "run-2:user" }, "turn-2:user"),
      ],
    },
  ])("fails closed for a canonical-looking pair with $name", async ({ pair }) => {
    const settledMessages = settledTurn();
    await expect(
      captureContext({
        historyMessages: [...pair, settledMessages[1]!, settledMessages[2]!],
        mirroredMessages: settledMessages,
        settledMessages,
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed for non-adjacent or repeated canonical prompt identities", async () => {
    const settledMessages = settledTurn();
    const prompt = () =>
      message({ role: "user", content: "Send it.", idempotencyKey: "run-2:user" }, "turn-2:prompt");
    const separator = message({ role: "assistant", content: "unrelated" }, "turn-1:assistant");

    for (const historyMessages of [
      [prompt(), separator, prompt(), settledMessages[1]!, settledMessages[2]!],
      [prompt(), prompt(), prompt(), settledMessages[1]!, settledMessages[2]!],
    ]) {
      await expect(
        captureContext({
          historyMessages,
          mirroredMessages: settledMessages,
          settledMessages,
          turnId: "turn-2",
        }),
      ).resolves.toBeUndefined();
    }
  });

  it.each([
    {
      name: "missing current prompt",
      settledMessages: settledTurn().slice(1),
      historyMessages: settledTurn(),
    },
    {
      name: "missing current tool call",
      settledMessages: settledTurn(),
      historyMessages: [settledTurn()[0]!, settledTurn()[2]!],
    },
    {
      name: "duplicate persisted identity",
      settledMessages: settledTurn(),
      historyMessages: [...settledTurn(), settledTurn()[2]!],
    },
    {
      name: "foreign boundary turn",
      settledMessages: settledTurn(),
      historyMessages: settledTurn(),
      turnId: "turn-3",
    },
  ])("fails closed for $name", async ({ settledMessages, historyMessages, turnId }) => {
    await expect(
      captureContext({
        historyMessages,
        mirroredMessages: settledMessages,
        settledMessages,
        turnId: turnId ?? "turn-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when a persisted payload drifts under the same mirror identity", async () => {
    const settledMessages = settledTurn();
    const historyMessages = settledTurn();
    historyMessages[2] = message(
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "message",
        content: [{ type: "text", text: "different result" }],
      },
      "turn-2:tool:call-2:result",
    );

    await expect(
      captureContext({
        historyMessages,
        mirroredMessages: settledMessages,
        settledMessages,
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when current mirrored messages are reordered", async () => {
    const settledMessages = settledTurn();
    await expect(
      captureContext({
        historyMessages: settledMessages,
        mirroredMessages: [settledMessages[1]!, settledMessages[0]!, settledMessages[2]!],
        settledMessages,
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("contains transcript read failures after tools have settled", async () => {
    mocks.readHistory.mockRejectedValue(new Error("read failed"));

    await expect(
      captureCodexSettledTurnFinalizationContext({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        mirroredMessages: settledTurn(),
        settledMessages: settledTurn(),
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("contains transcript clone failures after tools have settled", async () => {
    const historyMessages = settledTurn();
    Object.assign(historyMessages[2]!, { uncloneable: () => undefined });
    mocks.readHistory.mockResolvedValue(historyMessages);

    await expect(
      captureCodexSettledTurnFinalizationContext({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        mirroredMessages: historyMessages,
        settledMessages: historyMessages,
        turnId: "turn-2",
      }),
    ).resolves.toBeUndefined();
  });
});
