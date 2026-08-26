import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentManifest } from "./types.js";

export const DEFAULT_MANIFEST: AgentManifest = {
  name: "",
  description: "An openark agent",
  modules: {
    memory: true,
    personality: true,
    reflection: true,
    skills: true,
  },
  channels: { subscriptions: [] },
};

const CORE_TEMPLATE = `# Core persona

This file is yours. The agent never rewrites it — describe who they are,
how they talk, and what they care about. See personas/ in the openark repo
for a full example (defoko).
`;

const EVOLVING_TEMPLATE = `# Learned preferences

Managed by the agent. Every change is appended to logs/audit.log.
Preference updates only land here after crossing a confidence threshold.
`;

const LESSONS_TEMPLATE = `# Lessons

Rules this agent learned from failures and corrections.
Format: "- [status] rule (source, hits)" — managed by openark.
`;

export function seedAgentHome(dir: string, name: string, description?: string): void {
  if (existsSync(dir)) throw new Error(`agent directory already exists: ${dir}`);
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });

  const manifest: AgentManifest = {
    ...structuredClone(DEFAULT_MANIFEST),
    name,
    description: description ?? DEFAULT_MANIFEST.description,
  };
  writeFileSync(join(dir, "agent.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "persona.core.md"), CORE_TEMPLATE);
  writeFileSync(join(dir, "persona.evolving.md"), EVOLVING_TEMPLATE);
  writeFileSync(join(dir, "lessons.md"), LESSONS_TEMPLATE);
  writeFileSync(join(dir, "logs", "audit.log"), "");
}
