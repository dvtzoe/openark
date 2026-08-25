import type { InjectionBlock, ModuleContext, OpenArkModule } from "../core/types.js";

type PersonaResponse = { core: string; evolving: string };

export const personalityModule: OpenArkModule = {
  name: "personality",
  description: "Stable core persona plus a slowly evolving preferences layer",

  async init(ctx) {
    if (!(await ctx.service.health())) {
      throw new Error("openark service unreachable");
    }
  },

  async injections(ctx: ModuleContext): Promise<InjectionBlock[]> {
    try {
      const persona = await ctx.service.getJSON<PersonaResponse>(`/v1/agents/${ctx.agent}/persona`);
      const blocks: InjectionBlock[] = [];
      if (persona.core.trim()) {
        blocks.push({ title: "Persona (core)", body: persona.core, priority: 100 });
      }
      if (persona.evolving.trim()) {
        blocks.push({
          title: "Persona (learned preferences)",
          body: persona.evolving,
          priority: 80,
        });
      }
      return blocks;
    } catch {
      return [];
    }
  },
};
