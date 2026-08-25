import type { InjectionBlock, ModuleContext, OpenArkModule } from "../core/types.js";

type SkillsResponse = { skills: { name: string; description: string }[] };

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
      if (!res.skills.length) return [];
      const lines = res.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
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
};
