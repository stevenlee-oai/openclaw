import { describe, expect, it, vi } from "vitest";
import {
  CODEX_INFERENCE_GENERATION_KEY,
  createCodexInferenceContext,
} from "./inference-context.js";
import type { JsonObject } from "./protocol.js";

function request(threadId: string, generation?: string, extra: JsonObject = {}): JsonObject {
  return {
    instructions: "native base",
    input: [{ role: "developer", content: "native catalog collaboration" }],
    client_metadata: {
      thread_id: threadId,
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId,
        request_kind: "turn",
        ...(generation ? { [CODEX_INFERENCE_GENERATION_KEY]: generation } : {}),
        ...extra,
      }),
    },
  };
}

describe("parent-local inference context", () => {
  it("attributes concurrent request observations to the exact live admitted generation", () => {
    const context = createCodexInferenceContext(() => {});
    const register = (threadId: string) => {
      const onModelRequest = vi.fn();
      const registration = context.register({
        threadId,
        text: "",
        signal: new AbortController().signal,
        assertCurrent: () => {},
        onModelRequest,
      });
      return {
        ...registration,
        onModelRequest,
        prepared: context.prepare(request(threadId, registration.generation)),
      };
    };
    const first = register("first");
    const second = register("second");
    const observation = { url: "https://api.openai.com/v1/responses", transport: "http" as const };
    second.prepared.onModelRequest?.(observation);
    expect(first.onModelRequest).not.toHaveBeenCalled();
    expect(second.onModelRequest).toHaveBeenCalledExactlyOnceWith(observation);
    const replacement = register("first");
    expect(() => first.prepared.onModelRequest?.(observation)).toThrow();
    replacement.prepared.onModelRequest?.(observation);
    expect(replacement.onModelRequest).toHaveBeenCalledExactlyOnceWith(observation);
    expect(first.onModelRequest).not.toHaveBeenCalled();
    replacement.release();
    expect(() => replacement.prepared.onModelRequest?.(observation)).toThrow();
    second.prepared.onModelRequest?.(observation);
    expect(second.onModelRequest).toHaveBeenCalledTimes(2);
    context.close();
    expect(() => second.prepared.onModelRequest?.(observation)).toThrow();
  });

  it("refreshes and removes overlays for native input-only requests without changing history", () => {
    const context = createCodexInferenceContext(() => {});
    const register = (text: string) =>
      context.register({
        threadId: "root",
        text,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
    const inputOnly = (generation: string) => {
      const source = request("root", generation);
      delete source.instructions;
      source.input = [
        { id: "at_native_tools", type: "additional_tools", role: "developer", tools: [] },
        {
          id: "msg_native_base",
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "native base" }],
        },
      ];
      return source;
    };
    const first = register("persona A");
    const source = inputOnly(first.generation);
    const prepared = context.prepare(source);
    expect(prepared.body).toEqual({ ...source, instructions: "persona A" });
    expect(prepared.body.input).toBe(source.input);
    expect(source).not.toHaveProperty("instructions");
    const second = register("persona B");
    expect(prepared.signal?.aborted).toBe(true);
    expect(() => context.prepare(source)).toThrow("current admitted");
    const continuation = {
      ...inputOnly(second.generation),
      input: [],
      previous_response_id: "previous",
    };
    expect(context.prepare(continuation).body).toEqual({
      ...continuation,
      instructions: "persona B",
    });
    const removed = inputOnly(register("").generation);
    expect(context.prepare(removed).body).toBe(removed);
    context.close();
  });

  it.each([null, 42, false, [], {}].map((instructions) => ({ instructions })))(
    "rejects explicit non-string instructions: $instructions",
    ({ instructions }) => {
      const context = createCodexInferenceContext(() => {});
      const registration = context.register({
        threadId: "root",
        text: "persona",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      expect(() =>
        context.prepare({ ...request("root", registration.generation), instructions }),
      ).toThrow("instructions");
      context.close();
    },
  );

  it("refreshes and removes parent instructions without rewriting native history or affecting children", () => {
    const context = createCodexInferenceContext(() => {});
    const register = (text: string) =>
      context.register({
        threadId: "root",
        text,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
    const first = register("persona A");
    const source = request("root", first.generation);
    const original = structuredClone(source);
    const prepared = context.prepare(source);
    expect(prepared.body).toEqual({ ...source, instructions: "native base\n\npersona A" });
    expect(source).toEqual(original);
    const second = register("persona B");
    first.release();
    expect(prepared.signal?.aborted).toBe(true);
    expect(() => prepared.assertCurrent()).toThrow();
    expect(() => context.prepare(source)).toThrow("current admitted");
    expect(context.prepare(request("root", second.generation)).body.instructions).toBe(
      "native base\n\npersona B",
    );
    const child = request("child", second.generation, {
      parent_thread_id: "root",
      subagent_kind: "collab_spawn",
    });
    expect(context.prepare(child).body).toEqual(child);
    const removed = register("");
    const after = request("root", removed.generation);
    expect(context.prepare(after).body).toEqual(after);
    context.close();
    expect(() => context.prepare(after)).toThrow("closed");
  });

  it("requires exact physical owner, root identity and admitted generation", () => {
    let active = true;
    const context = createCodexInferenceContext(() => {});
    const register = context.register({
      threadId: "root",
      text: "private",
      signal: new AbortController().signal,
      assertCurrent: () => {
        if (!active) {
          throw new Error("owner retired");
        }
      },
    });
    const source = request("root", register.generation);
    const prepared = context.prepare(source);
    expect(() => context.prepare(request("other", register.generation))).toThrow(
      "current admitted",
    );
    expect(() => createCodexInferenceContext(() => {}).prepare(source)).toThrow("current admitted");
    expect(() => context.prepare(request("root"))).toThrow("current admitted");
    expect(() =>
      context.prepare({
        ...source,
        client_metadata: {
          thread_id: "conflicting-root",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "root",
            request_kind: "turn",
            [CODEX_INFERENCE_GENERATION_KEY]: register.generation,
          }),
        },
      }),
    ).toThrow("metadata disagrees");
    active = false;
    expect(() => prepared.assertCurrent()).toThrow("owner retired");
    expect(() => context.prepare(source)).toThrow("owner retired");
    context.close();
  });

  it("does not contaminate local compaction, memory, review or unadmitted startup prewarm", () => {
    const context = createCodexInferenceContext(() => {});
    const registration = context.register({
      threadId: "root",
      text: "persona B",
      signal: new AbortController().signal,
      assertCurrent: () => {},
      onModelRequest: vi.fn(),
    });
    const exclusions: JsonObject[] = [
      { request_kind: "compaction" },
      { request_kind: "memory" },
      { subagent_kind: "review" },
    ];
    for (const extra of exclusions) {
      const source = request("root", registration.generation, extra);
      expect(context.prepare(source).body).toEqual(source);
      expect(context.prepare(source).onModelRequest).toBeUndefined();
    }
    // Native Memory metadata intentionally omits its nested thread identity while
    // client_metadata still carries the physical thread ID (0.153.4 responses_metadata.rs).
    const memory = {
      instructions: "native memory instructions",
      input: [],
      client_metadata: {
        thread_id: "memory-thread",
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory" }),
      },
    };
    expect(context.prepare(memory).body).toEqual(memory);
    const startup = { ...request("root", undefined, { request_kind: "prewarm" }), generate: false };
    expect(context.prepare(startup).body).toEqual(startup);
    expect(context.prepare(startup).onModelRequest).toBeUndefined();
    expect(
      context.prepare(request("root", registration.generation, { request_kind: "prewarm" }))
        .onModelRequest,
    ).toBeUndefined();
    // Immediate normal continuation after compaction still reads the current snapshot.
    expect(context.prepare(request("root", registration.generation)).body.instructions).toContain(
      "persona B",
    );
    context.close();
  });

  it("bounds context and fences aborts, missing metadata and unsupported request kinds", () => {
    const context = createCodexInferenceContext(() => {});
    const controller = new AbortController();
    const params = { threadId: "root", signal: controller.signal, assertCurrent: () => {} };
    expect(() => context.register({ ...params, text: "x".repeat(256 * 1024 + 1) })).toThrow(
      "limit",
    );
    const registered = context.register({ ...params, text: "private" });
    const source = request("root", registered.generation);
    expect(() => context.prepare({ instructions: "base" })).toThrow("metadata");
    expect(() =>
      context.prepare(request("root", registered.generation, { request_kind: "other" })),
    ).toThrow("purpose");
    const prepared = context.prepare(source);
    controller.abort();
    expect(prepared.signal?.aborted).toBe(true);
    expect(() => context.prepare(source)).toThrow("current admitted");
    context.close();
  });
});
