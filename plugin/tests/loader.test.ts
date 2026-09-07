import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGET_CHARS, collectInjections, manifestAllows } from "../src/core/loader";
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

  it("fits a chiai-sized core persona with drop-ins under the default budget", async () => {
    // Regression: Sep 2026 chiai merged to 21.8k chars (core 13.6k +
    // 10-operations 3.2k + 20-human-voice 5k + provenance markers) and the
    // old 16k budget sliced mid-file, dropping 20-human-voice entirely.
    const core = "c".repeat(13608);
    const dropin10 = "o".repeat(3176);
    const dropin20 = `HUMAN-VOICE-MARKER${"h".repeat(5023)}`;
    const merged = `${core}\n\n<!-- from: persona.core.md.d/10-operations.md -->\n${dropin10}\n\n<!-- from: persona.core.md.d/20-human-voice.md -->\n${dropin20}`;
    expect(merged.length).toBeGreaterThan(16000);
    expect(DEFAULT_BUDGET_CHARS).toBeGreaterThanOrEqual(merged.length);

    const mods: OpenArkModule[] = [
      {
        name: "personality",
        description: "",
        injections: async () => [{ title: "Persona (core)", body: merged, priority: 100 }],
      },
    ];
    const text = await collectInjections(mods, ctx);
    expect(text).toContain("HUMAN-VOICE-MARKER");
    expect(text.length).toBeLessThanOrEqual(DEFAULT_BUDGET_CHARS);
  });

  it("warns when truncating a block instead of silently slicing", async () => {
    const log = vi.fn();
    const warnCtx = { log } as unknown as ModuleContext;
    const mods: OpenArkModule[] = [
      {
        name: "core",
        description: "",
        injections: async () => [{ title: "core", body: "x".repeat(300), priority: 100 }],
      },
    ];
    await collectInjections(mods, warnCtx, 50);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("truncated"));
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining('"core"'));
  });

  it("warns when dropping low-priority blocks on budget exhaustion", async () => {
    const log = vi.fn();
    const warnCtx = { log } as unknown as ModuleContext;
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
    const text = await collectInjections(mods, warnCtx, 100);
    expect(text).not.toContain("## mem");
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("dropping"));
  });
});
