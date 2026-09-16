import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { mintSecretSentinel, sealSecretSentinel } from "../secrets/sentinel.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

describe("guarded model fetch secret sentinel integration", () => {
  afterEach(() => {
    resetSecretRedactionRegistryForTest();
  });

  it("observes exact redirect destinations while injecting and redacting the real header", async () => {
    let receivedAuthorization: string | undefined;
    const dispatchedUrls: string[] = [];
    let receivedRequests = 0;
    let observedBeforeRequest = true;
    const server = createServer((request, response) => {
      receivedRequests += 1;
      observedBeforeRequest &&= dispatchedUrls.length === receivedRequests;
      receivedAuthorization = request.headers.authorization;
      if (request.url === "/v1/responses") {
        response.writeHead(307, { location: "/v1/redirected" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      const model = {
        id: "integration-model",
        provider: "sentinel-integration",
        api: "openai-responses",
        baseUrl,
      } as unknown as Model<"openai-responses">;
      const secret = "integration-provider-secret";
      const sentinel = mintSecretSentinel(secret, { label: "model-auth:integration" });

      const response = await buildGuardedModelFetch(model, undefined, {
        onRequest: (url) => {
          dispatchedUrls.push(url);
        },
      })(`${baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sentinel}` },
        body: "{}",
      });
      await response.text();

      expect(receivedAuthorization).toBe(`Bearer ${secret}`);
      expect(observedBeforeRequest).toBe(true);
      expect(dispatchedUrls).toEqual([`${baseUrl}/responses`, `${baseUrl}/redirected`]);
      expect(redactSensitiveText(`upstream used ${secret}`, { mode: "off" })).toBe(
        "upstream used integr…cret",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("keeps a hostname assembled with a short secret and its redirects out of observations", async () => {
    const onRequest = vi.fn();
    const receivedPaths: string[] = [];
    const server = createServer((request, response) => {
      receivedPaths.push(request.url ?? "");
      if (request.url === "/v1/responses") {
        response.writeHead(307, { location: "/v1/redirected" });
      } else {
        response.writeHead(200, { "content-type": "application/json" });
      }
      response.end("{}");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const model = {
        id: "integration-model",
        provider: "sentinel-integration",
        api: "openai-responses",
        baseUrl: `http://127.0.0.1:${port}/v1`,
      } as unknown as Model<"openai-responses">;
      // A one-byte secret is intentionally too short for registry-based redaction.
      const sentinel = sealSecretSentinel("1", { label: "model-host:integration" });
      const response = await buildGuardedModelFetch(model, undefined, { onRequest })(
        `http://127.0.0.${sentinel}:${port}/v1/responses`,
        { method: "POST", body: "{}" },
      );
      await response.text();

      expect(response.status).toBe(200);
      expect(receivedPaths).toEqual(["/v1/responses", "/v1/redirected"]);
      expect(onRequest).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
