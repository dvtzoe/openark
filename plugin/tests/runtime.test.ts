import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/core/runtime";
import type { ModuleContext, OpenArkModule, ServiceLike } from "../src/core/types";

function fakeService(agents: Record<string, unknown> = {}): ServiceLike & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    health: vi.fn(async () => true),
    getJSON: vi.fn(async (path: string) => {
      calls.push(path);
      if (path in agents) return agents[path];
      throw new Error("not found");
    }),
    postJSON: vi.fn(async () => ({})),
  } as unknown as ServiceLike & { calls: string[] };
}

function manifest(modules: Record<string, boolean>) {
  return {
    name: "x",
    description: "x",
    modules,
    channels: { subscriptions: [] },
  };
}

function recordingModule(
  name: string,
  enabled: boolean,
): OpenArkModule & {
  events: string[];
} {
  const events: string[] = [];
  return {
    events,
    name,
    description: "",
    async init() {
      if (!enabled) throw new Error("disabled");
    },
    async onUserMessage() {
      events.push("user");
    },
    async onToolResult() {
      events.push("tool");
    },
    async onSessionEnd() {
      events.push("end");
    },
    async injections() {
      return [{ title: name, body: name, priority: 1 }];
    },
  };
}

function deps(service: ServiceLike, mods: OpenArkModule[]) {
  return {
    defaultAgent: "chiai",
    service,
    loadModules: async () => mods,
    collectInjections: async () => "injected",
    log: () => {},
  };
}

describe("createRuntime", () => {
  it("loads the default agent and its modules", async () => {
    const service = fakeService({ "/v1/agents/chiai": manifest({ memory: true }) });
    const mod = recordingModule("memory", true);
    const runtime = await createRuntime(deps(service, [mod]));
    expect(runtime.agent()).toBe("chiai");
    expect(runtime.enabledModules()).toEqual(["memory"]);
  });

  it("handles an unavailable agent as no-op", async () => {
    const service = fakeService({});
    const runtime = await createRuntime(deps(service, []));
    expect(runtime.agent()).toBe("chiai");
    expect(runtime.active()).toEqual([]);
    expect(await runtime.injections()).toBe("");
  });

  it("flushes the current agent before switching", async () => {
    const service = fakeService({
      "/v1/agents/chiai": manifest({ memory: true }),
      "/v1/agents/observer": manifest({ memory: true }),
    });
    const mod = recordingModule("memory", true);
    const runtime = await createRuntime(deps(service, [mod]));

    await runtime.onUserMessage("hi");
    await runtime.switchAgent("observer");
    expect(mod.events).toEqual(["user", "end"]);
    expect(runtime.agent()).toBe("observer");
  });

  it("reuses a previously loaded agent without reloading", async () => {
    const service = fakeService({ "/v1/agents/chiai": manifest({ memory: true }) });
    const runtime = await createRuntime(deps(service, []));
    await runtime.switchAgent("chiai");
    await runtime.switchAgent("chiai");
    expect(service.calls.filter((c) => c === "/v1/agents/chiai")).toHaveLength(1);
  });

  it("switching to an unavailable agent keeps the previous one", async () => {
    const service = fakeService({ "/v1/agents/chiai": manifest({ memory: true }) });
    const runtime = await createRuntime(deps(service, []));
    await runtime.switchAgent("ghost");
    expect(runtime.agent()).toBe("chiai");
  });

  it("dispatches user messages, tool results, and session end", async () => {
    const service = fakeService({ "/v1/agents/chiai": manifest({ memory: true }) });
    const mod = recordingModule("memory", true);
    const runtime = await createRuntime(deps(service, [mod]));

    await runtime.onUserMessage("hello");
    await runtime.onToolResult({ tool: "bash", ok: false, durationMs: 5, summary: "boom" });
    await runtime.onSessionEnd();

    expect(mod.events).toEqual(["user", "tool", "end"]);
  });
});
