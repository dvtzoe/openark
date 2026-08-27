import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentHome, openarkHome } from "./config.js";

const MANAGED_NOTE = "Managed by openark.";

export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function pluginDistPath(): string {
  return join(packageRoot(), "dist", "index.js");
}

export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "opencode");
  return join(env.HOME ?? "", ".config", "opencode");
}

export type InstallResult = {
  pluginPath: string;
  agentFiles: string[];
  skillLinks: string[];
  commandFiles: string[];
};

export type UninstallResult = {
  pluginPath: string | null;
  agentFiles: string[];
  skillLinks: string[];
  commandFiles: string[];
};

export function listAgents(home: string = openarkHome()): string[] {
  const dir = join(home, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, "agent.json")));
}

export function installPluginShim(configDir: string): string {
  const pluginsDir = join(configDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const shim = join(pluginsDir, "openark.js");
  const dist = pluginDistPath();
  if (!existsSync(dist)) {
    throw new Error(`plugin dist not found at ${dist} — run \`npm run build\` first`);
  }
  const url = new URL(`file://${dist}`).href;
  writeFileSync(
    shim,
    `// ${MANAGED_NOTE} Loads the openark plugin from its installed package.\n` +
      `export { plugin, default } from "${url}"\n`,
  );
  return shim;
}

export function renderAgentFile(name: string, description: string, home: string): string {
  return [
    "---",
    `description: ${description.replace(/\n/g, " ")}`,
    "mode: primary",
    "---",
    "",
    `${MANAGED_NOTE} The persona, memories, lessons, and learned skills for "${name}"`,
    "are injected at runtime by the openark plugin — edit them under",
    `${join(home, "agents", name)} instead of this file.`,
    "",
  ].join("\n");
}

export function readAgentDescription(name: string, home: string = openarkHome()): string {
  const manifestPath = join(agentHome(name, home), "agent.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { description?: string };
    if (manifest.description) return manifest.description;
  } catch {
    // keep default description
  }
  return `openark agent ${name}`;
}

export function isManagedFile(path: string): boolean {
  try {
    return existsSync(path) && readFileSync(path, "utf8").includes(MANAGED_NOTE);
  } catch {
    return false;
  }
}

export function generateAgentFiles(configDir: string, home: string = openarkHome()): string[] {
  const agentsDir = join(configDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const written: string[] = [];
  for (const name of listAgents(home)) {
    const path = join(agentsDir, `${name}.md`);
    writeFileSync(path, renderAgentFile(name, readAgentDescription(name, home), home));
    written.push(path);
  }
  return written;
}

export function linkSkills(configDir: string, home: string = openarkHome()): string[] {
  const skillsDir = join(configDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  for (const entry of readdirSync(skillsDir)) {
    const linkPath = join(skillsDir, entry);
    if (isOpenarkLink(linkPath, home)) {
      rmSync(linkPath, { force: true, recursive: true });
    }
  }

  const linked: string[] = [];
  for (const agent of listAgents(home)) {
    const agentSkills = join(agentHome(agent, home), "skills");
    if (!existsSync(agentSkills)) continue;
    for (const entry of readdirSync(agentSkills)) {
      if (entry === "drafts") continue;
      const skillDir = join(agentSkills, entry);
      if (!existsSync(join(skillDir, "SKILL.md"))) continue;
      const linkPath = join(skillsDir, entry);
      if (existsSync(linkPath)) continue;
      symlinkSync(skillDir, linkPath, "dir");
      linked.push(linkPath);
    }
  }
  return linked;
}

export function isOpenarkLink(linkPath: string, home: string): boolean {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    const target = readlinkSync(linkPath);
    return target === home || target.startsWith(home + sep);
  } catch {
    return false;
  }
}

export function installCommands(
  configDir: string,
  commandsDir = join(packageRoot(), "commands"),
): string[] {
  const targetDir = join(configDir, "commands");
  mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];
  if (!existsSync(commandsDir)) return copied;
  for (const entry of readdirSync(commandsDir)) {
    if (!entry.endsWith(".md")) continue;
    const source = join(commandsDir, entry);
    const target = join(targetDir, entry);
    writeFileSync(target, readFileSync(source, "utf8"));
    copied.push(target);
  }
  return copied;
}

function removeIfManaged(path: string): boolean {
  if (!isManagedFile(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function uninstallPluginShim(configDir: string): string | null {
  const shim = join(configDir, "plugins", "openark.js");
  return removeIfManaged(shim) ? shim : null;
}

export function removeAgentFiles(configDir: string): string[] {
  const agentsDir = join(configDir, "agents");
  const removed: string[] = [];
  if (!existsSync(agentsDir)) return removed;
  for (const entry of readdirSync(agentsDir)) {
    const path = join(agentsDir, entry);
    if (entry.endsWith(".md") && removeIfManaged(path)) removed.push(path);
  }
  return removed;
}

export function unlinkSkills(configDir: string, home: string = openarkHome()): string[] {
  const skillsDir = join(configDir, "skills");
  const removed: string[] = [];
  if (!existsSync(skillsDir)) return removed;
  for (const entry of readdirSync(skillsDir)) {
    const linkPath = join(skillsDir, entry);
    if (isOpenarkLink(linkPath, home)) {
      rmSync(linkPath, { force: true, recursive: true });
      removed.push(linkPath);
    }
  }
  return removed;
}

export function uninstallCommands(
  configDir: string,
  commandsDir = join(packageRoot(), "commands"),
): string[] {
  const targetDir = join(configDir, "commands");
  const removed: string[] = [];
  if (!existsSync(targetDir) || !existsSync(commandsDir)) return removed;
  for (const entry of readdirSync(commandsDir)) {
    if (!entry.endsWith(".md")) continue;
    const target = join(targetDir, entry);
    if (existsSync(target)) {
      rmSync(target, { force: true });
      removed.push(target);
    }
  }
  return removed;
}

export function uninstallAll(
  configDir: string = opencodeConfigDir(),
  home: string = openarkHome(),
): UninstallResult {
  return {
    pluginPath: uninstallPluginShim(configDir),
    agentFiles: removeAgentFiles(configDir),
    skillLinks: unlinkSkills(configDir, home),
    commandFiles: uninstallCommands(configDir),
  };
}

export function installAll(
  configDir: string = opencodeConfigDir(),
  home: string = openarkHome(),
): InstallResult {
  return {
    pluginPath: installPluginShim(configDir),
    agentFiles: generateAgentFiles(configDir, home),
    skillLinks: linkSkills(configDir, home),
    commandFiles: installCommands(configDir),
  };
}
