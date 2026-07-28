// Compares the former four-load Codex attempt shape with one snapshot plus a delta refresh.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FIXTURE_EVENT_COUNT = 7_365;
const FIXTURE_CONTENT_BYTES = 3_200;

type BenchmarkMode = "baseline" | "candidate";
type BenchmarkScope = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};
type BenchmarkTarget = BenchmarkScope & { sessionFile: string };
type SessionHistoryRuntime = typeof import("../src/app-server/session-history.js");
type RssTracker = ReturnType<typeof createRssTracker>;

function parseMode(): BenchmarkMode {
  const mode = process.argv[2];
  if (mode === "baseline" || mode === "candidate") {
    return mode;
  }
  throw new Error("usage: bench-session-history.ts <baseline|candidate>");
}

function hashMessages(messages: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function createRssTracker() {
  const initialBytes = process.memoryUsage().rss;
  let peakBytes = initialBytes;
  return {
    sample() {
      peakBytes = Math.max(peakBytes, process.memoryUsage().rss);
    },
    peakGrowthKb() {
      return Math.round((peakBytes - initialBytes) / 1024);
    },
  };
}

async function seedFixture(scope: BenchmarkScope): Promise<void> {
  const { upsertSessionEntry } = await import("openclaw/plugin-sdk/session-store-runtime");
  const { appendSessionTranscriptMessageByIdentity } =
    await import("openclaw/plugin-sdk/session-transcript-runtime");
  const marker = `sqlite:${scope.agentId}:${scope.sessionId}:${scope.storePath}`;
  await upsertSessionEntry({
    ...scope,
    entry: {
      sessionFile: marker,
      sessionId: scope.sessionId,
      updatedAt: 1,
    },
  });
  for (let index = 0; index < FIXTURE_EVENT_COUNT; index += 1) {
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      eventId: `fixture-${index}`,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${String(index).padStart(5, "0")}:${"x".repeat(FIXTURE_CONTENT_BYTES)}`,
        timestamp: index + 1,
      },
    });
  }
}

async function appendSettledTurn(scope: BenchmarkScope): Promise<void> {
  const { appendSessionTranscriptMessageByIdentity } =
    await import("openclaw/plugin-sdk/session-transcript-runtime");
  await appendSessionTranscriptMessageByIdentity({
    ...scope,
    eventId: "settled-user",
    message: { role: "user", content: "settled user", timestamp: FIXTURE_EVENT_COUNT + 1 },
  });
  await appendSessionTranscriptMessageByIdentity({
    ...scope,
    eventId: "settled-assistant",
    message: {
      role: "assistant",
      content: "settled assistant",
      timestamp: FIXTURE_EVENT_COUNT + 2,
    },
  });
}

async function runBaseline(
  target: BenchmarkTarget,
  scope: BenchmarkScope,
  history: SessionHistoryRuntime,
  rss: RssTracker,
) {
  let fullLoadCount = 0;
  const load = async () => {
    fullLoadCount += 1;
    const messages = (await history.readCodexMirroredSessionHistoryMessages(target)) ?? [];
    rss.sample();
    return messages;
  };
  await load();
  await load();
  await appendSettledTurn(scope);
  rss.sample();
  const settledMessages = await load();
  const finalizeMessages = await load();
  return { finalMessages: finalizeMessages, fullLoadCount, settledMessages };
}

async function runCandidate(
  target: BenchmarkTarget,
  scope: BenchmarkScope,
  history: SessionHistoryRuntime,
  rss: RssTracker,
) {
  const hadHistory = await history.hasCodexMirroredSessionHistory(target);
  rss.sample();
  const snapshot = await history.readCodexMirroredSessionHistorySnapshot(target);
  rss.sample();
  if (!hadHistory || !snapshot) {
    throw new Error("candidate fixture history was unavailable");
  }
  await appendSettledTurn(scope);
  rss.sample();
  const refreshed = await history.refreshCodexMirroredSessionHistorySnapshot(target, snapshot);
  rss.sample();
  if (!refreshed) {
    throw new Error("candidate snapshot refresh failed");
  }
  return {
    finalMessages: refreshed.messages,
    fullLoadCount: 1,
    settledMessages: refreshed.messages,
  };
}

async function main(): Promise<void> {
  const mode = parseMode();
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-history-bench-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const scope = {
    agentId: "benchmark",
    sessionId: "codex-history-benchmark",
    sessionKey: "agent:benchmark:codex-history-benchmark",
    storePath: path.join(stateDir, "openclaw-agent.sqlite"),
  };
  const target = {
    ...scope,
    sessionFile: `sqlite:${scope.agentId}:${scope.sessionId}:${scope.storePath}`,
  };
  try {
    await seedFixture(scope);
    const { readTranscriptStatsSync } = await import("openclaw/plugin-sdk/session-store-runtime");
    const transcriptStats = readTranscriptStatsSync(scope);
    const history = await import("../src/app-server/session-history.js");
    const rss = createRssTracker();
    const startedAt = performance.now();
    const result =
      mode === "baseline"
        ? await runBaseline(target, scope, history, rss)
        : await runCandidate(target, scope, history, rss);
    const elapsedMs = performance.now() - startedAt;
    console.log(
      JSON.stringify({
        mode,
        fixture: {
          appendedMessages: 2,
          databaseBytes: (await fs.stat(scope.storePath)).size,
          initialMessages: FIXTURE_EVENT_COUNT,
          transcriptBytes: transcriptStats.sizeBytes,
        },
        result: {
          elapsedMs: Number(elapsedMs.toFixed(3)),
          finalMessageCount: result.finalMessages.length,
          fullLoadCount: result.fullLoadCount,
          maxRssKb: process.resourceUsage().maxRSS,
          measuredPeakRssGrowthKb: rss.peakGrowthKb(),
          semanticHash: hashMessages(result.finalMessages),
          settledHash: hashMessages(result.settledMessages),
        },
      }),
    );
  } finally {
    await fs.rm(stateDir, { force: true, recursive: true });
  }
}

await main();
