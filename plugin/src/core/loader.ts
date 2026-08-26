import { allModules } from "../modules/index.js";
import type { AgentManifest, ModuleContext, OpenArkModule } from "./types.js";

const DEFAULT_BUDGET_CHARS = 16000;
const MIN_BLOCK_CHARS = 50;

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
  budgetChars = DEFAULT_BUDGET_CHARS,
): Promise<string> {
  const blocks = [];
  for (const mod of active) {
    if (!mod.injections) continue;
    blocks.push(...(await mod.injections(ctx)));
  }
  blocks.sort((a, b) => b.priority - a.priority);
  const kept = [];
  let used = 0;
  for (const block of blocks) {
    const header = kept.length ? "\n\n" : "";
    const remaining = budgetChars - used - header.length;
    if (remaining < MIN_BLOCK_CHARS) break;
    let body = `## ${block.title}\n${block.body}`;
    if (body.length > remaining) body = body.slice(0, remaining);
    kept.push(body);
    used += header.length + body.length;
  }
  return kept.join("\n\n");
}

export function manifestAllows(manifest: AgentManifest, moduleName: string): boolean {
  return manifest.modules[moduleName] === true;
}
