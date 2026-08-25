import { allModules } from "../modules/index.js";
import type { AgentManifest, ModuleContext, OpenArkModule } from "./types.js";

export type LoadedModules = {
  active: OpenArkModule[];
  ctx: ModuleContext;
};

export async function loadModules(ctx: ModuleContext): Promise<OpenArkModule[]> {
  const active: OpenArkModule[] = [];
  for (const mod of allModules) {
    if (!ctx.manifest.modules[mod.name]) continue;
    try {
      await mod.init?.(ctx);
      active.push(mod);
    } catch (err) {
      ctx.log("warn", `module ${mod.name} disabled: ${String(err)}`);
    }
  }
  return active;
}

export async function collectInjections(
  active: OpenArkModule[],
  ctx: ModuleContext,
): Promise<string> {
  const blocks = [];
  for (const mod of active) {
    if (!mod.injections) continue;
    blocks.push(...(await mod.injections(ctx)));
  }
  blocks.sort((a, b) => b.priority - a.priority);
  return blocks.map((b) => `## ${b.title}\n${b.body}`).join("\n\n");
}

export function manifestAllows(manifest: AgentManifest, moduleName: string): boolean {
  return manifest.modules[moduleName] === true;
}
