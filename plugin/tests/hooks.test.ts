import { describe, expect, it, vi } from "vitest";
import type { PluginContext, SessionEvent } from "../src/core/hooks";
import { handleSessionEvent, registerHooks } from "../src/core/hooks";
import type { Runtime } from "../src/core/runtime";

function fakeRuntime(): Runtime & {
  notedSessions: Array<[string, string]>;
  forgottenSessions: string[];
  userMessages: string[];
  toolResults: unknown[];
  ends: string[];
  injectionsText: string;
} {
  return {
    notedSessions: [],
    forgottenSessions: [],
    userMessages: [],
    toolResults: [],
    ends: [],
    injectionsText: "## Persona\nwarm",
    agent: () => "defoko",
    manifest: () => null,
    active: () => [],
    ctx: () => null,
    enabledModules: () => ["memory"],
    noteSession: vi.fn(async function (this: never, sessionID: string, agent: string) {
      (this as unknown as { notedSessions: Array<[string, string]> }).notedSessions.push([
        sessionID,
        agent,
      ]);
    }),
    forgetSession: vi.fn(function (this: never, sessionID: string) {
      (this as unknown as { forgottenSessions: string[] }).forgottenSessions.push(sessionID);
    }),
    onUserMessage: vi.fn(async function (this: never, _sessionID: string, text: string) {
      (this as unknown as { userMessages: string[] }).userMessages.push(text);
    }),
    onToolResult: vi.fn(async function (this: never, _sessionID: string, result: unknown) {
      (this as unknown as { toolResults: unknown[] }).toolResults.push(result);
    }),
    onSessionEnd: vi.fn(async function (this: never, sessionID?: string) {
      (this as unknown as { ends: string[] }).ends.push(sessionID ?? "(all)");
    }),
    injections: vi.fn(async function (this: never) {
      return (this as unknown as { injectionsText: string }).injectionsText;
    }),
  } as unknown as ReturnType<typeof fakeRuntime>;
}

type HookCallback = (event: unknown) => Promise<void> | void;

function fakeContext(
  options: {
    sessionInfo?: { agent?: string; model?: { providerID: string; id: string } };
    events?: SessionEvent[];
  } = {},
): {
  ctx: PluginContext;
  hookCallbacks: Map<string, HookCallback>;
  toolCallbacks: Map<string, HookCallback>;
  signal: () => AbortSignal | undefined;
} {
  const hookCallbacks = new Map<string, HookCallback>();
  const toolCallbacks = new Map<string, HookCallback>();
  let signal: AbortSignal | undefined;
  const sessionInfo = options.sessionInfo ?? {
    agent: "defoko",
    model: { providerID: "anthropic", id: "claude-sonnet" },
  };

  const ctx = {
    location: { directory: "/work" },
    session: {
      get: vi.fn(async () => sessionInfo),
      hook: vi.fn(async (name: string, callback: HookCallback) => {
        hookCallbacks.set(name, callback);
        return { dispose: async () => {} };
      }),
    },
    tool: {
      hook: vi.fn(async (name: string, callback: HookCallback) => {
        toolCallbacks.set(name, callback);
        return { dispose: async () => {} };
      }),
    },
    event: {
      subscribe: vi.fn((opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return (async function* () {
          for (const event of options.events ?? []) yield event;
          await new Promise<void>((resolve) => {
            const current = opts?.signal;
            if (current?.aborted) return resolve();
            current?.addEventListener("abort", () => resolve(), { once: true });
          });
        })();
      }),
    },
  };

  return {
    ctx: ctx as unknown as PluginContext,
    hookCallbacks,
    toolCallbacks,
    signal: () => signal,
  };
}

const promptEvent = (sessionID: string, text: string) => ({ sessionID, prompt: { text } });
const contextEvent = (sessionID: string, system: unknown[] = []) => ({
  sessionID,
  agent: "defoko",
  model: { providerID: "anthropic", id: "claude-sonnet" },
  system,
});

describe("handleSessionEvent", () => {
  it("flushes only the idle session", async () => {
    const runtime = fakeRuntime();
    await handleSessionEvent(runtime, { type: "session.idle", data: { sessionID: "s1" } });
    expect(runtime.ends).toEqual(["s1"]);
  });

  it("forgets a deleted session", async () => {
    const runtime = fakeRuntime();
    await handleSessionEvent(runtime, { type: "session.deleted", data: { sessionID: "s1" } });
    expect(runtime.forgottenSessions).toEqual(["s1"]);
  });

  it("ignores other events and events without a session", async () => {
    const runtime = fakeRuntime();
    await handleSessionEvent(runtime, { type: "message.updated", data: { sessionID: "s1" } });
    await handleSessionEvent(runtime, { type: "session.idle", data: {} });
    expect(runtime.ends).toEqual([]);
  });
});

describe("registerHooks", () => {
  it("notes the session and forwards the prompt text", async () => {
    const runtime = fakeRuntime();
    const { ctx, hookCallbacks } = fakeContext();
    await registerHooks(ctx, runtime, () => {});
    await hookCallbacks.get("prompt")?.(promptEvent("s1", " hello "));
    expect(runtime.notedSessions).toEqual([["s1", "defoko"]]);
    expect(runtime.userMessages).toEqual(["hello"]);
  });

  it("falls back to the current agent when the session has none", async () => {
    const runtime = fakeRuntime();
    const { ctx, hookCallbacks } = fakeContext({ sessionInfo: { model: undefined } });
    await registerHooks(ctx, runtime, () => {});
    await hookCallbacks.get("prompt")?.(promptEvent("s1", "hi"));
    expect(runtime.notedSessions).toEqual([["s1", "defoko"]]);
  });

  it("skips empty prompt text", async () => {
    const runtime = fakeRuntime();
    const { ctx, hookCallbacks } = fakeContext();
    await registerHooks(ctx, runtime, () => {});
    await hookCallbacks.get("prompt")?.(promptEvent("s1", "   "));
    expect(runtime.userMessages).toEqual([]);
  });

  it("survives a prompt-handling failure", async () => {
    const runtime = fakeRuntime();
    const { ctx, hookCallbacks } = fakeContext();
    (ctx.session.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const log = vi.fn();
    await registerHooks(ctx, runtime, log);
    await hookCallbacks.get("prompt")?.(promptEvent("s1", "hi"));
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("prompt handling failed"));
  });

  it("injects into the system prompt", async () => {
    const runtime = fakeRuntime();
    const { ctx, hookCallbacks } = fakeContext();
    await registerHooks(ctx, runtime, () => {});
    const system: unknown[] = ["base"];
    await hookCallbacks.get("context")?.(contextEvent("s1", system));
    expect(system[0]).toBe("base");
    expect(system[1]).toMatchObject({ type: "text" });
    expect(JSON.stringify(system[1])).toContain("# openark");
    expect(JSON.stringify(system[1])).toContain("## Persona");
  });

  it("does not inject when empty", async () => {
    const runtime = fakeRuntime();
    runtime.injectionsText = "";
    const { ctx, hookCallbacks } = fakeContext();
    await registerHooks(ctx, runtime, () => {});
    const system: unknown[] = [];
    await hookCallbacks.get("context")?.(contextEvent("s1", system));
    expect(system).toEqual([]);
  });

  it("feeds failed tool calls to the runtime", async () => {
    const runtime = fakeRuntime();
    const { ctx, toolCallbacks } = fakeContext();
    await registerHooks(ctx, runtime, () => {});
    await toolCallbacks.get("execute.before")?.({ id: "call1" });
    await toolCallbacks.get("execute.after")?.({
      id: "call1",
      tool: "bash",
      sessionID: "s1",
      status: "error",
      error: { message: "exit 2" },
    });
    expect(runtime.toolResults).toEqual([
      { tool: "bash", ok: false, durationMs: expect.any(Number), summary: "exit 2" },
    ]);
  });

  it("ignores successful tool completions", async () => {
    const runtime = fakeRuntime();
    const { ctx, toolCallbacks } = fakeContext();
    await registerHooks(ctx, runtime, () => {});
    await toolCallbacks.get("execute.after")?.({
      id: "call1",
      tool: "bash",
      sessionID: "s1",
      status: "completed",
      result: {},
    });
    expect(runtime.toolResults).toEqual([]);
  });

  it("pumps session lifecycle events from the subscription", async () => {
    const runtime = fakeRuntime();
    const { ctx } = fakeContext({
      events: [
        { type: "session.idle", data: { sessionID: "s1" } },
        { type: "session.deleted", data: { sessionID: "s2" } },
      ],
    });
    const hooks = await registerHooks(ctx, runtime, () => {});
    await vi.waitFor(() => expect(runtime.ends).toEqual(["s1"]));
    await vi.waitFor(() => expect(runtime.forgottenSessions).toEqual(["s2"]));
    await hooks.stop();
  });

  it("flushes every session and aborts the subscription on stop", async () => {
    const runtime = fakeRuntime();
    const { ctx, signal } = fakeContext();
    const hooks = await registerHooks(ctx, runtime, () => {});
    expect(signal()?.aborted).toBe(false);
    await hooks.stop();
    expect(signal()?.aborted).toBe(true);
    expect(runtime.ends).toEqual(["(all)"]);
  });
});
