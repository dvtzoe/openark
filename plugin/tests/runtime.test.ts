import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/core/runtime";
import { ServiceError } from "../src/core/service";
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
      throw new ServiceError(path, 404, "no such agent");
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
    defaultAgent: "defoko",
    service,
    loadModules: async () => mods,
    collectInjections: async () => "injected",
    log: () => {},
  };
}

describe("createRuntime", () => {
  it("loads the default agent and its modules", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const mod = recordingModule("memory", true);
    const runtime = await createRuntime(deps(service, [mod]));
    expect(runtime.agent()).toBe("defoko");
    expect(runtime.enabledModules()).toEqual(["memory"]);
  });

  it("handles an unavailable agent as no-op", async () => {
    const service = fakeService({});
    const runtime = await createRuntime(deps(service, []));
    expect(runtime.agent()).toBe("defoko");
    expect(runtime.active()).toEqual([]);
    expect(await runtime.injections()).toBe("");
  });

  it("flushes a session when it ends, without disturbing other sessions", async () => {
    const service = fakeService({
      "/v1/agents/defoko": manifest({ memory: true }),
      "/v1/agents/observer": manifest({ memory: true }),
    });
    const mod = recordingModule("memory", true);
    const runtime = await createRuntime(deps(service, [mod]));

    await runtime.noteSession("s1", "defoko");
    await runtime.noteSession("s2", "observer");
    await runtime.onUserMessage("s1", "hi");
    await runtime.onSessionEnd("s1");
    expect(mod.events).toEqual(["user", "end"]);
    expect(runtime.agent("s2")).toBe("observer");
  });

  it("does not re-read the manifest for repeat turns within the same session", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const runtime = await createRuntime(deps(service, []));
    const before = service.calls.filter((c) => c === "/v1/agents/defoko").length;
    await runtime.noteSession("s1", "defoko");
    await runtime.noteSession("s1", "defoko");
    await runtime.noteSession("s1", "defoko");
    const after = service.calls.filter((c) => c === "/v1/agents/defoko").length;
    expect(after - before).toBe(1);
  });

  it("re-reads the manifest at each session's first turn, per MODULE_SPEC.md's " +
    "'toggle at any time' contract", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const runtime = await createRuntime(deps(service, []));
    const before = service.calls.filter((c) => c === "/v1/agents/defoko").length;
    await runtime.noteSession("s1", "defoko");
    await runtime.noteSession("s2", "defoko");
    const after = service.calls.filter((c) => c === "/v1/agents/defoko").length;
    expect(after - before).toBe(2);
  });

  it("an unknown session falls back to the default agent", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const runtime = await createRuntime(deps(service, []));
    expect(runtime.agent("never-noted")).toBe("defoko");
  });

  it("noting a session for an unavailable agent is a passthrough no-op (no fallback)", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const runtime = await createRuntime(deps(service, []));
    await runtime.noteSession("s1", "ghost");
    // The session keeps its own agent name (for diagnostics) but gets no
    // modules/injections — it must NOT inherit the default agent's persona.
    expect(runtime.agent("s1")).toBe("ghost");
    expect(runtime.active("s1")).toEqual([]);
    expect(runtime.enabledModules("s1")).toEqual([]);
    expect(await runtime.injections("s1")).toBe("");
  });

  it("native opencode agents (build/plan) never hit the service", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const runtime = await createRuntime(deps(service, []));
    await runtime.noteSession("s1", "build");
    await runtime.noteSession("s2", "plan");
    expect(runtime.agent("s1")).toBe("build");
    expect(runtime.active("s1")).toEqual([]);
    expect(await runtime.injections("s1")).toBe("");
    expect(service.calls.filter((c) => c === "/v1/agents/build")).toEqual([]);
    expect(service.calls.filter((c) => c === "/v1/agents/plan")).toEqual([]);
  });

  it("a 404 is cached — repeat sessions for the same unknown agent skip the fetch", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const runtime = await createRuntime(deps(service, []));
    await runtime.noteSession("s1", "ghost");
    await runtime.noteSession("s2", "ghost");
    const hits = service.calls.filter((c) => c === "/v1/agents/ghost").length;
    expect(hits).toBe(1);
  });

  it("dispatches user messages, tool results, and session end", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const mod = recordingModule("memory", true);
    const runtime = await createRuntime(deps(service, [mod]));

    await runtime.onUserMessage("s1", "hello");
    await runtime.onToolResult("s1", { tool: "bash", ok: false, durationMs: 5, summary: "boom" });
    await runtime.onSessionEnd("s1");

    expect(mod.events).toEqual(["user", "tool", "end"]);
  });

  it("keeps concurrent sessions on different agents fully isolated", async () => {
    const service = fakeService({
      "/v1/agents/defoko": manifest({ memory: true }),
      "/v1/agents/observer": manifest({ memory: true }),
    });
    const defokoMod = recordingModule("memory", true);
    const observerMod = recordingModule("memory", true);
    // Two distinct module instances so each agent's dispatched events can be
    // told apart, mirroring how `loaded` caches modules per agent name.
    const runtime = await createRuntime({
      defaultAgent: "defoko",
      service,
      loadModules: async (ctx) => (ctx.agent === "defoko" ? [defokoMod] : [observerMod]),
      collectInjections: async () => "injected",
      log: () => {},
    });

    await runtime.noteSession("s1", "defoko");
    await runtime.noteSession("s2", "observer");
    await runtime.onUserMessage("s1", "for defoko");
    await runtime.onUserMessage("s2", "for observer");
    await runtime.onSessionEnd("s1");
    await runtime.onSessionEnd("s2");

    expect(defokoMod.events).toEqual(["user", "end"]);
    expect(observerMod.events).toEqual(["user", "end"]);
  });

  it("full shutdown (no sessionID) flushes every tracked session", async () => {
    const service = fakeService({
      "/v1/agents/defoko": manifest({ memory: true }),
      "/v1/agents/observer": manifest({ memory: true }),
    });
    const mod = recordingModule("memory", true);
    const runtime = await createRuntime(deps(service, [mod]));

    await runtime.noteSession("s1", "defoko");
    await runtime.noteSession("s2", "observer");
    await runtime.onUserMessage("s1", "hi");
    await runtime.onUserMessage("s2", "hi");
    await runtime.onSessionEnd();

    expect(mod.events).toEqual(["user", "user", "end", "end"]);
  });
});

describe("createRuntime selected model forwarding", () => {
  it("scopes the service client to the session's selected model", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const scoped = { ...service, withModel: vi.fn() };
    const withModel = vi.fn(() => scoped);
    (service as unknown as { withModel?: unknown }).withModel = withModel;
    const runtime = await createRuntime(deps(service, []));

    await runtime.noteSession("s1", "defoko", "opencode-go/deepseek-v4.1-flash");

    const context = runtime.ctx("s1");
    expect(withModel).toHaveBeenCalledWith("opencode-go/deepseek-v4.1-flash");
    expect(context?.service).toBe(scoped);
    expect(context?.session?.model).toBe("opencode-go/deepseek-v4.1-flash");
    // A session without a model keeps the plain service.
    await runtime.noteSession("s2", "defoko");
    expect(runtime.ctx("s2")?.service).toBe(service);
  });

  it("dispatches onSessionDeleted to active modules so buffers are freed", async () => {
    const service = fakeService({ "/v1/agents/defoko": manifest({ memory: true }) });
    const deleted: string[] = [];
    const mod: OpenArkModule = {
      name: "memory",
      description: "",
      onSessionDeleted: (context) => {
        deleted.push(context.session?.id ?? "");
      },
    };
    const runtime = await createRuntime(deps(service, [mod]));
    await runtime.noteSession("s1", "defoko");
    runtime.forgetSession("s1");
    expect(deleted).toEqual(["s1"]);
  });
});
