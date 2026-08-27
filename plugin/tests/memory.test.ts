import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManifest, ModuleContext, ServiceLike } from "../src/core/types";
import { memoryModule, resetTranscript } from "../src/modules/memory";

function fakeService(overrides: Record<string, unknown> = {}): ServiceLike {
  return {
    health: vi.fn(async () => true),
    getJSON: vi.fn(async () => ({ memories: [], ...overrides })),
    postJSON: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as ServiceLike;
}

function ctx(service: ServiceLike): ModuleContext {
  const manifest: AgentManifest = {
    name: "defoko",
    description: "test",
    modules: { memory: true },
    channels: { subscriptions: [] },
  };
  return { agent: "defoko", manifest, service, log: () => {} };
}

beforeEach(() => {
  resetTranscript();
});

describe("memoryModule", () => {
  it("init throws when service is down", async () => {
    const service = fakeService();
    (service.health as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(memoryModule.init?.(ctx(service))).rejects.toThrow("unreachable");
  });

  it("buffers user messages and flushes them on session end", async () => {
    const service = fakeService();
    const context = ctx(service);

    await memoryModule.onUserMessage?.(context, { role: "user", text: "I use neovim" });
    await memoryModule.onUserMessage?.(context, { role: "user", text: "  " });
    await memoryModule.onUserMessage?.(context, { role: "user", text: "I have a dog" });

    await memoryModule.onSessionEnd?.(context);

    expect(service.postJSON).toHaveBeenCalledWith(
      "/v1/agents/defoko/memory/ingest",
      expect.objectContaining({ text: "user: I use neovim\nuser: I have a dog" }),
    );

    await memoryModule.onSessionEnd?.(context);
    expect(service.postJSON).toHaveBeenCalledTimes(1);
  });

  it("survives ingest failures", async () => {
    const service = fakeService();
    (service.postJSON as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
    const context = ctx(service);
    await memoryModule.onUserMessage?.(context, { role: "user", text: "hello" });
    await expect(memoryModule.onSessionEnd?.(context)).resolves.toBeUndefined();
  });

  it("caps the transcript buffer", async () => {
    const service = fakeService();
    const context = ctx(service);
    for (let i = 0; i < 210; i++) {
      await memoryModule.onUserMessage?.(context, { role: "user", text: `msg ${i}` });
    }
    await memoryModule.onSessionEnd?.(context);
    const call = (service.postJSON as ReturnType<typeof vi.fn>).mock.calls[0];
    const text = call[1].text as string;
    expect(text.split("\n")).toHaveLength(200);
    expect(text.split("\n")[0]).toBe("user: msg 10");
    expect(text).toContain("user: msg 209");
  });

  it("injects remembered facts", async () => {
    const service = fakeService({
      memories: [{ id: "m1", text: "likes neovim", score: 0.9 }],
    });
    const blocks = await memoryModule.injections?.(ctx(service));
    expect(blocks).toEqual([
      { title: "Remembered about you", body: "- likes neovim", priority: 60 },
    ]);
  });

  it("injects nothing when memory is empty", async () => {
    const blocks = await memoryModule.injections?.(ctx(fakeService()));
    expect(blocks).toEqual([]);
  });

  it("exposes memory and channel tools", async () => {
    const service = fakeService({ memories: [{ id: "m1", text: "x", score: 1 }] });
    const context = ctx(service);
    const tools = memoryModule.tools?.(context) ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "memory_search",
      "memory_add",
      "channel_share",
      "channel_items",
      "channel_subscribe",
    ]);

    await tools[0]?.execute({ q: "editor" });
    expect(service.getJSON).toHaveBeenCalledWith(
      "/v1/agents/defoko/memory/recall?q=editor&limit=10",
    );

    await tools[1]?.execute({ text: "likes tea" });
    expect(service.postJSON).toHaveBeenCalledWith("/v1/agents/defoko/memory", {
      text: "likes tea",
      project: expect.any(String),
    });

    await expect(tools[1]?.execute({})).rejects.toThrow("text is required");
  });

  it("channel tools validate and call the service", async () => {
    const service = fakeService();
    const context = ctx(service);
    const tools = memoryModule.tools?.(context) ?? [];
    const byName = (name: string) => {
      const found = tools.find((t) => t.name === name);
      if (!found) throw new Error(`tool not found: ${name}`);
      return found;
    };
    const share = byName("channel_share");
    const items = byName("channel_items");
    const subscribe = byName("channel_subscribe");

    await share.execute({ text: "User prefers vitest", channel: "#team", kind: "memory" });
    expect(service.postJSON).toHaveBeenCalledWith("/v1/agents/defoko/channels/%23team", {
      text: "User prefers vitest",
      kind: "memory",
    });

    await expect(share.execute({ text: "x" })).rejects.toThrow("channel is required");
    await expect(share.execute({ channel: "team" })).rejects.toThrow("text is required");

    await items.execute({ channel: "team" });
    expect(service.getJSON).toHaveBeenCalledWith("/v1/channels/team");

    await subscribe.execute({ channel: "team" });
    expect(service.postJSON).toHaveBeenCalledWith("/v1/agents/defoko/channels/team/subscribe", {});
    await subscribe.execute({ channel: "team", subscribe: false });
    expect(service.postJSON).toHaveBeenCalledWith(
      "/v1/agents/defoko/channels/team/unsubscribe",
      {},
    );
  });

  it("renders channel provenance in injections", async () => {
    const service = fakeService({
      memories: [
        { id: "m1", text: "private fact", score: 0.9 },
        { id: "c1", text: "shared fact", score: 0.0, source_agent: "defoko" },
      ],
    });
    const blocks = await memoryModule.injections?.(ctx(service));
    expect(blocks?.[0]?.body).toContain("- private fact");
    expect(blocks?.[0]?.body).toContain("- shared fact (shared by defoko)");
  });
});
