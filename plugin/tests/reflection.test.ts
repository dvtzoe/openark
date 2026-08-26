import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManifest, ModuleContext, ServiceLike } from "../src/core/types";
import { reflectionModule, resetBuffers } from "../src/modules/reflection";

function fakeService(overrides: Record<string, unknown> = {}): ServiceLike {
  return {
    health: vi.fn(async () => true),
    getJSON: vi.fn(async () => ({ lessons: [], ...overrides })),
    postJSON: vi.fn(async () => ({})),
  } as unknown as ServiceLike;
}

function ctx(service: ServiceLike, sessionID?: string): ModuleContext {
  const manifest: AgentManifest = {
    name: "chiai",
    description: "test",
    modules: { reflection: true },
    channels: { subscriptions: [] },
  };
  return {
    agent: "chiai",
    manifest,
    service,
    log: () => {},
    ...(sessionID ? { session: { id: sessionID } } : {}),
  };
}

beforeEach(() => {
  resetBuffers();
});

describe("reflectionModule", () => {
  it("init throws when service is down", async () => {
    const service = fakeService();
    (service.health as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(reflectionModule.init?.(ctx(service))).rejects.toThrow("unreachable");
  });

  it("queues failures and flushes with post-failure messages on session end", async () => {
    const service = fakeService();
    const context = ctx(service);

    await reflectionModule.onUserMessage?.(context, {
      role: "user",
      text: "ignored, no failure yet",
    });
    await reflectionModule.onToolResult?.(context, {
      tool: "bash",
      ok: true,
      durationMs: 10,
      summary: "fine",
    });
    await reflectionModule.onToolResult?.(context, {
      tool: "bash",
      ok: false,
      durationMs: 20,
      summary: "exit 1: tests failed",
    });
    await reflectionModule.onUserMessage?.(context, {
      role: "user",
      text: "no, run the linter first",
    });

    await reflectionModule.onSessionEnd?.(context);

    expect(service.postJSON).toHaveBeenCalledWith("/v1/agents/chiai/lessons/reflect", {
      failures: [{ tool: "bash", ok: false, duration_ms: 20, summary: "exit 1: tests failed" }],
      messages: ["no, run the linter first"],
    });

    await reflectionModule.onSessionEnd?.(context);
    expect(service.postJSON).toHaveBeenCalledTimes(1);
  });

  it("flushes incrementally across multiple idle events", async () => {
    const service = fakeService();
    const context = ctx(service);
    await reflectionModule.onToolResult?.(context, {
      tool: "edit",
      ok: false,
      durationMs: 0,
      summary: "reverted edit",
    });
    await reflectionModule.onUserMessage?.(context, { role: "user", text: "wrong file!" });
    await reflectionModule.onSessionEnd?.(context);

    await reflectionModule.onToolResult?.(context, {
      tool: "bash",
      ok: false,
      durationMs: 0,
      summary: "exit 1",
    });
    await reflectionModule.onUserMessage?.(context, { role: "user", text: "again?" });
    await reflectionModule.onSessionEnd?.(context);

    const calls = (service.postJSON as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1].failures[0].summary).toBe("reverted edit");
    expect(calls[1][1].failures[0].summary).toBe("exit 1");
    expect(calls[1][1].messages).toEqual(["again?"]);
  });

  it("does not flush when only messages buffered without failures", async () => {
    const service = fakeService();
    const context = ctx(service);
    await reflectionModule.onUserMessage?.(context, { role: "user", text: "just chatting" });
    await reflectionModule.onSessionEnd?.(context);
    expect(service.postJSON).not.toHaveBeenCalled();
  });

  it("injects lessons and registers hits once per session", async () => {
    const service = fakeService({
      lessons: [
        { id: "abc", rule: "Run make lint", hits: 3, status: "active", source: "reflection:bash" },
      ],
    });

    const contextA = ctx(service, "session-1");
    const blocks = await reflectionModule.injections?.(contextA);
    expect(blocks).toEqual([{ title: "Lessons learned", body: "- Run make lint", priority: 90 }]);

    await reflectionModule.injections?.(ctx(service, "session-1"));
    await reflectionModule.injections?.(ctx(service, "session-2"));

    const calls = (service.postJSON as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      (c[0] as string).includes("/hits"),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual({ ids: ["abc"], session_id: "session-1" });
    expect(calls[1][1]).toEqual({ ids: ["abc"], session_id: "session-2" });
  });

  it("does not register hits without a session", async () => {
    const service = fakeService({
      lessons: [{ id: "abc", rule: "rule", hits: 0, status: "active", source: "x" }],
    });
    await reflectionModule.injections?.(ctx(service));
    expect(service.postJSON).not.toHaveBeenCalled();
  });

  it("injects nothing when no lessons", async () => {
    expect(await reflectionModule.injections?.(ctx(fakeService()))).toEqual([]);
  });

  it("exposes reflect, lessons_list, lessons_retire tools", async () => {
    const service = fakeService();
    const context = ctx(service);
    const tools = reflectionModule.tools?.(context) ?? [];
    expect(tools.map((t) => t.name)).toEqual(["reflect", "lessons_list", "lessons_retire"]);

    await tools[0]?.execute({
      failures: ["I committed without running tests"],
      messages: ["run tests first"],
    });
    expect(service.postJSON).toHaveBeenCalledWith("/v1/agents/chiai/lessons/reflect", {
      failures: [
        { tool: "manual", ok: false, duration_ms: 0, summary: "I committed without running tests" },
      ],
      messages: ["run tests first"],
    });

    await expect(tools[0]?.execute({ failures: [] })).rejects.toThrow("required");

    await tools[1]?.execute({ all: true });
    expect(service.getJSON).toHaveBeenCalledWith("/v1/agents/chiai/lessons?active=false");

    await tools[2]?.execute({ id: "abc123" });
    expect(service.postJSON).toHaveBeenCalledWith("/v1/agents/chiai/lessons/abc123/retire", {});
    await expect(tools[2]?.execute({})).rejects.toThrow("id is required");
  });
});
