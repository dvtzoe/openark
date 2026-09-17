import { allModules } from "../modules/index.js";
import type { AgentManifest, ModuleContext, ModuleTool, OpenArkModule } from "./types.js";

// 32k fits a large core persona with drop-ins (chiai was 21.8k merged in
// Sep 2026 and silently lost 20-human-voice.md under the old 16k cap) plus
// headroom for evolving/memories/lessons/skills (~8k tokens total, safe for
// modern context windows). If personas keep growing, raise this again rather
// than letting collectInjections silently slice mid-file.
export const DEFAULT_BUDGET_CHARS = 32000;
const MIN_BLOCK_CHARS = 50;

export async function loadModules(ctx: ModuleContext): Promise<OpenArkModule[]> {
  const active: OpenArkModule[] = [];
  for (const mod of allModules) {
    if (!manifestAllows(ctx.manifest, mod.name)) continue;
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
    // Per-module isolation (MODULE_SPEC.md: failures degrade to a no-op):
    // one throwing module must not silently disable the ones after it.
    try {
      blocks.push(...(await mod.injections(ctx)));
    } catch (err) {
      warn(ctx, `module ${mod.name} injections failed: ${String(err)}`);
    }
  }
  blocks.sort((a, b) => b.priority - a.priority);
  const kept = [];
  let used = 0;
  for (const block of blocks) {
    const header = kept.length ? "\n\n" : "";
    const remaining = budgetChars - used - header.length;
    if (remaining < MIN_BLOCK_CHARS) {
      warn(
        ctx,
        `injection budget exhausted (${used}/${budgetChars} chars): dropping "${block.title}" and ${blocks.length - kept.length - 1} later block(s)`,
      );
      break;
    }
    let body = `## ${block.title}\n${block.body}`;
    if (body.length > remaining) {
      warn(
        ctx,
        `injection "${block.title}" truncated: ${body.length} chars exceeds ${remaining} remaining of ${budgetChars} budget — persona drop-ins may be missing`,
      );
      body = body.slice(0, remaining);
    }
    kept.push(body);
    used += header.length + body.length;
  }
  return kept.join("\n\n");
}

function warn(ctx: ModuleContext, message: string): void {
  try {
    (ctx as Partial<ModuleContext>)?.log?.("warn", message);
  } catch {
    // logging must never break injections (tests pass a bare {} as ctx)
  }
}

export function manifestAllows(manifest: AgentManifest, moduleName: string): boolean {
  return manifest.modules[moduleName] === true;
}

// Tool specs for registration with opencode, enumerated from every known
// module regardless of the default agent's manifest or service state. The
// per-session gate lives in the execute wrapper (index.ts) — registering
// from the startup agent's module set used to make tools unavailable for
// the whole process if that agent had a module toggled off or the service
// was briefly down at plugin init.
export function collectToolSpecs(ctx: ModuleContext): ModuleTool[] {
  const seen = new Set<string>();
  const specs: ModuleTool[] = [];
  for (const mod of allModules) {
    for (const t of mod.tools?.(ctx) ?? []) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      specs.push(t);
    }
  }
  return specs;
}
