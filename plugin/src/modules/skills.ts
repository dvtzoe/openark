import type { InjectionBlock, ModuleContext, ModuleTool, OpenArkModule } from "../core/types.js";
import type { components } from "../generated/api-types.js";

type SkillsResponse = components["schemas"]["SkillsResponse"];
type DistillResponse = components["schemas"]["DistillResponse"];
type SkillVerifyResponse = components["schemas"]["SkillVerifyResponse"];
type Skill = components["schemas"]["SkillSummary"];

export const skillsModule: OpenArkModule = {
  name: "skills",
  description: "Distilled, reusable procedures materialized as opencode skills",

  async init(ctx) {
    if (!(await ctx.service.health())) {
      throw new Error("openark service unreachable");
    }
  },

  async injections(ctx: ModuleContext): Promise<InjectionBlock[]> {
    try {
      const res = await ctx.service.getJSON<SkillsResponse>(`/v1/agents/${ctx.agent}/skills`);
      const skills = (res.skills ?? []).filter((s: Skill) => s.name?.trim());
      if (!skills.length) return [];
      const lines = skills.map((s: Skill) => `- ${s.name}: ${s.description}`).join("\n");
      return [
        {
          title: "Learned skills available",
          body: `These skills exist as opencode skills; prefer them over reinventing:\n${lines}`,
          priority: 50,
        },
      ];
    } catch {
      return [];
    }
  },

  tools(ctx: ModuleContext): ModuleTool[] {
    return [
      {
        name: "skill_distill",
        description:
          "Distill a successfully completed multi-step workflow into a reusable draft skill. " +
          "Pass the workflow trace (what you did, in order) as the trace argument.",
        execute: async (args) => {
          const trace = typeof args.trace === "string" ? args.trace.trim() : "";
          if (!trace) throw new Error("trace is required");
          return ctx.service.postJSON<DistillResponse>(`/v1/agents/${ctx.agent}/skills/distill`, {
            trace,
          });
        },
      },
      {
        name: "skills_list",
        description: "List learned skills (verified by default; pass all: true to include drafts)",
        execute: async (args) => {
          const includeDrafts = args.all === true;
          return ctx.service.getJSON<SkillsResponse>(
            `/v1/agents/${ctx.agent}/skills?drafts=${includeDrafts ? "true" : "false"}`,
          );
        },
      },
      {
        name: "skill_verify",
        description:
          "Verify a draft skill by name, promoting it so it is advertised and materialized " +
          "as an opencode skill. Use after one successful reuse or explicit user approval.",
        execute: async (args) => {
          const slug = typeof args.name === "string" ? args.name.trim() : "";
          if (!slug) throw new Error("name is required");
          return ctx.service.postJSON<SkillVerifyResponse>(
            `/v1/agents/${ctx.agent}/skills/${encodeURIComponent(slug)}/verify`,
            {},
          );
        },
      },
    ];
  },
};
