import { describe, expect, it, vi } from "vitest";
import type { AgentManifest, ModuleContext, ServiceLike } from "../src/core/types";
import { personalityModule } from "../src/modules/personality";

function fakeService(overrides: Record<string, unknown> = {}): ServiceLike {
  return {
    health: vi.fn(async () => true),
    getJSON: vi.fn(async () => ({ core: "", evolving: "", ...overrides })),
    postJSON: vi.fn(async () => ({})),
  } as unknown as ServiceLike;
}

function ctx(service: ServiceLike): ModuleContext {
  const manifest: AgentManifest = {
    name: "defoko",
    description: "test",
    modules: { personality: true },
    channels: { subscriptions: [] },
  };
  return { agent: "defoko", manifest, service, log: () => {} };
}

describe("personalityModule", () => {
  it("injects core and evolving persona blocks", async () => {
    const service = fakeService({ core: "# Core\nwarm", evolving: "- likes tea" });
    const blocks = await personalityModule.injections?.(ctx(service));
    expect(blocks).toEqual([
      { title: "Persona (core)", body: "# Core\nwarm", priority: 100 },
      { title: "Persona (learned preferences)", body: "- likes tea", priority: 80 },
    ]);
  });

  it("injects nothing when persona is empty", async () => {
    expect(await personalityModule.injections?.(ctx(fakeService()))).toEqual([]);
  });

  it("init throws when service is down", async () => {
    const service = fakeService();
    (service.health as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(personalityModule.init?.(ctx(service))).rejects.toThrow("unreachable");
  });

  it("exposes persona_evolve tool that posts signals", async () => {
    const service = fakeService();
    const context = ctx(service);
    const tools = personalityModule.tools?.(context) ?? [];
    expect(tools.map((t) => t.name)).toEqual(["persona_evolve"]);

    await tools[0]?.execute({ signals: ["likes tea", "likes tea", "prefers dark mode"] });
    expect(service.postJSON).toHaveBeenCalledWith("/v1/agents/defoko/persona/evolve", {
      signals: ["likes tea", "likes tea", "prefers dark mode"],
    });
  });

  it("rejects empty or invalid signals", async () => {
    const tools = personalityModule.tools?.(ctx(fakeService())) ?? [];
    await expect(tools[0]?.execute({ signals: [] })).rejects.toThrow("signals is required");
    await expect(tools[0]?.execute({ signals: "not-an-array" })).rejects.toThrow(
      "signals is required",
    );
    await expect(tools[0]?.execute({ signals: ["  ", 42] })).rejects.toThrow("signals is required");
  });
});
