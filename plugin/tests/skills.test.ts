import { describe, expect, it, vi } from "vitest";
import { linkSkills } from "../src/core/installer";
import type { AgentManifest, ModuleContext, ServiceLike } from "../src/core/types";
import { skillsModule } from "../src/modules/skills";

vi.mock("../src/core/installer", () => ({
  linkSkills: vi.fn(() => []),
  opencodeConfigDir: vi.fn(() => "/tmp/opencode"),
}));

function fakeService(overrides: Record<string, unknown> = {}): ServiceLike {
  return {
    health: vi.fn(async () => true),
    getJSON: vi.fn(async () => ({ skills: [], ...overrides })),
    postJSON: vi.fn(async () => ({})),
  } as unknown as ServiceLike;
}

function ctx(service: ServiceLike): ModuleContext {
  const manifest: AgentManifest = {
    name: "defoko",
    description: "test",
    modules: { skills: true },
    channels: { subscriptions: [] },
  };
  return { agent: "defoko", manifest, service, log: () => {} };
}

describe("skillsModule", () => {
  it("init throws when service is down", async () => {
    const service = fakeService();
    (service.health as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(skillsModule.init?.(ctx(service))).rejects.toThrow("unreachable");
  });

  it("injects verified skills", async () => {
    const service = fakeService({
      skills: [{ name: "release-checklist", description: "Run the release flow" }],
    });
    const blocks = await skillsModule.injections?.(ctx(service));
    expect(blocks).toEqual([
      {
        title: "Learned skills available",
        body: "These skills exist as opencode skills; prefer them over reinventing:\n- release-checklist: Run the release flow",
        priority: 50,
      },
    ]);
  });

  it("injects nothing without skills", async () => {
    expect(await skillsModule.injections?.(ctx(fakeService()))).toEqual([]);
  });

  it("exposes skill_distill, skills_list, skill_verify tools", async () => {
    const service = fakeService();
    const context = ctx(service);
    const tools = skillsModule.tools?.(context) ?? [];
    expect(tools.map((t) => t.name)).toEqual(["skill_distill", "skills_list", "skill_verify"]);

    await tools[0]?.execute({ trace: "ran lint, tests, tagged" });
    expect(service.postJSON).toHaveBeenCalledWith("/v1/agents/defoko/skills/distill", {
      trace: "ran lint, tests, tagged",
    });
    await expect(tools[0]?.execute({ trace: "  " })).rejects.toThrow("trace is required");

    await tools[1]?.execute({ all: true });
    expect(service.getJSON).toHaveBeenCalledWith("/v1/agents/defoko/skills?drafts=true");
    await tools[1]?.execute({});
    expect(service.getJSON).toHaveBeenCalledWith("/v1/agents/defoko/skills?drafts=false");

    await tools[2]?.execute({ name: "release-checklist" });
    expect(service.postJSON).toHaveBeenCalledWith(
      "/v1/agents/defoko/skills/release-checklist/verify",
      {},
    );
    await expect(tools[2]?.execute({})).rejects.toThrow("name is required");
  });
});

describe("skill_verify materialization", () => {
  it("links the skill into opencode's skills dir after a successful verify", async () => {
    const service = fakeService();
    (service.postJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      verified: true,
      reason: null,
    });
    const tools = skillsModule.tools?.(ctx(service)) ?? [];
    await tools[2]?.execute({ name: "release-checklist" });
    expect(linkSkills).toHaveBeenCalled();

    (linkSkills as ReturnType<typeof vi.fn>).mockClear();
    (service.postJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      verified: false,
      reason: "not-found",
    });
    await tools[2]?.execute({ name: "nope" });
    expect(linkSkills).not.toHaveBeenCalled();
  });
});
