import { z } from "zod";
import { filteredStringArray } from "../core/args.js";
import type { InjectionBlock, ModuleContext, ModuleTool, OpenArkModule } from "../core/types.js";
import type { components } from "../generated/api-types.js";

type PersonaResponse = components["schemas"]["PersonaResponse"];
type PersonaEvolveResponse = components["schemas"]["PersonaEvolveResponse"];

const personaEvolveArgs = z
  .object({ signals: filteredStringArray() })
  .refine((v) => v.signals.length > 0, "signals is required (non-empty string array)");

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
          const { signals } = personaEvolveArgs.parse(args);
          return ctx.service.postJSON<PersonaEvolveResponse>(
            `/v1/agents/${ctx.agent}/persona/evolve`,
            { signals },
          );
        },
      },
    ];
  },
};
