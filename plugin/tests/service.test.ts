import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceClient, ServiceError } from "../src/core/service";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ServiceClient", () => {
  it("attaches a timeout signal to getJSON/postJSON/delete so a hung service can't hang a session", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServiceClient("http://localhost:4000");

    await client.getJSON("/v1/agents/defoko");
    await client.postJSON("/v1/agents/defoko/memory", { text: "x" });
    await client.delete("/v1/agents/defoko");

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects with ServiceError when the service responds with a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "not found" }, false, 404)),
    );
    const client = new ServiceClient("http://localhost:4000");
    await expect(client.getJSON("/v1/agents/ghost")).rejects.toThrow(ServiceError);
  });

  it("propagates a fetch-level abort as a rejection rather than hanging", async () => {
    // Simulates what a real AbortSignal.timeout firing looks like from
    // fetch's perspective, without waiting out the real timeout duration.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );
    const client = new ServiceClient("http://localhost:4000");
    await expect(client.getJSON("/v1/agents/defoko")).rejects.toThrow("aborted");
  });
});

describe("ServiceClient.withModel", () => {
  it("attaches the selected model as x-openark-model on every request", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(init ?? {});
        return jsonResponse({ ok: true });
      }),
    );
    const client = new ServiceClient("http://localhost:4000").withModel(
      "opencode-go/deepseek-v4.1-flash",
    );
    await client.getJSON("/v1/agents/defoko");
    await client.postJSON("/v1/agents/defoko/memory", { text: "x" });
    expect(calls).toHaveLength(2);
    for (const init of calls) {
      expect((init.headers as Record<string, string>)["x-openark-model"]).toBe(
        "opencode-go/deepseek-v4.1-flash",
      );
    }
    // The original client is unchanged.
    const plain = new ServiceClient("http://localhost:4000");
    calls.length = 0;
    await plain.getJSON("/v1/agents/defoko");
    expect((calls[0].headers as Record<string, string> | undefined)?.["x-openark-model"]).toBe(
      undefined,
    );
  });
});
