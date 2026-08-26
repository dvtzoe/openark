import { describe, expect, it } from "vitest";
import { collectInjections, manifestAllows } from "../src/core/loader";
import type { AgentManifest, ModuleContext, OpenArkModule } from "../src/core/types";

function manifest(overrides: Record<string, boolean> = {}): AgentManifest {
  return {
    name: "test",
    description: "test",
    modules: { memory: false, personality: false, reflection: false, skills: false, ...overrides },
    channels: { subscriptions: [] },
  };
}

describe("manifestAllows", () => {
  it("enables only modules set to true", () => {
    const m = manifest({ memory: true });
    expect(manifestAllows(m, "memory")).toBe(true);
    expect(manifestAllows(m, "personality")).toBe(false);
  });

  it("treats missing entries as disabled", () => {
    const m = manifest();
    expect(manifestAllows(m, "memory")).toBe(false);
  });
});

describe("collectInjections", () => {
  const ctx = {} as ModuleContext;

  it("sorts blocks by priority descending", async () => {
    const mods: OpenArkModule[] = [
      {
        name: "low",
        description: "",
        injections: async () => [{ title: "low", body: "l", priority: 10 }],
      },
      {
        name: "high",
        description: "",
        injections: async () => [{ title: "high", body: "h", priority: 99 }],
      },
    ];
    const text = await collectInjections(mods, ctx);
    expect(text.indexOf("## high")).toBeLessThan(text.indexOf("## low"));
  });

  it("renders an empty string when no module injects", async () => {
    const mods: OpenArkModule[] = [{ name: "x", description: "", injections: async () => [] }];
    expect(await collectInjections(mods, ctx)).toBe("");
  });

  it("truncates low-priority blocks to stay within the budget", async () => {
    const mods: OpenArkModule[] = [
      {
        name: "core",
        description: "",
        injections: async () => [{ title: "core", body: "x".repeat(80), priority: 100 }],
      },
      {
        name: "memory",
        description: "",
        injections: async () => [{ title: "mem", body: "y".repeat(80), priority: 60 }],
      },
    ];
    const text = await collectInjections(mods, ctx, 100);
    expect(text).toContain("## core");
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text).not.toContain("## mem");
  });

  it("keeps a high-priority block that fits by truncating it", async () => {
    const mods: OpenArkModule[] = [
      {
        name: "core",
        description: "",
        injections: async () => [{ title: "core", body: "x".repeat(300), priority: 100 }],
      },
    ];
    const text = await collectInjections(mods, ctx, 50);
    expect(text.length).toBeLessThanOrEqual(50);
  });
});
