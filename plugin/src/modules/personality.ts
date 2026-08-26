import type { InjectionBlock, ModuleContext, ModuleTool, OpenArkModule } from "../core/types.js";
import type { components } from "../generated/api-types.js";

type PersonaResponse = components["schemas"]["PersonaResponse"];
type PersonaEvolveResponse = components["schemas"]["PersonaEvolveResponse"];

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

  tools(ctx: ModuleContext): ModuleTool[] {
    return [
      {
        name: "persona_evolve",
        description:
          "Propose updates to your learned preferences from distinct user feedback signals. " +
          "Pass each distinct signal (a separate instance of feedback) as an item in the signals array.",
        execute: async (args) => {
          const signals = Array.isArray(args.signals)
            ? args.signals.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
            : [];
          if (!signals.length) throw new Error("signals is required (non-empty string array)");
          return ctx.service.postJSON<PersonaEvolveResponse>(
            `/v1/agents/${ctx.agent}/persona/evolve`,
            { signals },
          );
        },
      },
    ];
  },
};
