import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bootstrapVenv, installedVenvPython } from "./bootstrap.js";
import { agentHome, openarkHome, readGlobalConfig, serviceBaseUrl } from "./config.js";
import {
  installCommands,
  installPluginShim,
  isManagedFile,
  isOpenarkLink,
  linkSkills,
  listAgents,
  opencodeConfigDir,
  packageRoot,
  pluginDistPath,
  readAgentDescription,
  renderAgentFile,
} from "./installer.js";
import { ServiceClient } from "./service.js";

export type CheckStatus = "ok" | "warn" | "error";

export type DoctorCheck = {
  id: string;
  status: CheckStatus;
  message: string;
  hint?: string;
  fix?: () => string;
};

export type DoctorOptions = {
  home?: string;
  configDir?: string;
  serviceDir?: string;
};

function linkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}

function checkPluginDist(): DoctorCheck {
  const dist = pluginDistPath();
  return existsSync(dist)
    ? { id: "plugin-dist", status: "ok", message: `plugin dist: ${dist}` }
    : {
        id: "plugin-dist",
        status: "error",
        message: `plugin dist missing: ${dist}`,
        hint: "run `npm run build` in the plugin checkout (or reinstall the openark package)",
      };
}

function checkPluginShim(configDir: string, distOk: boolean): DoctorCheck {
  const id = "plugin-shim";
  const shim = join(configDir, "plugins", "openark.js");
  if (!existsSync(shim)) {
    return {
      id,
      status: "error",
      message: "plugin shim not installed",
      hint: shim,
      fix: () => `plugin shim written: ${installPluginShim(configDir)}`,
    };
  }
  if (!isManagedFile(shim)) {
    return {
      id,
      status: "error",
      message: `plugin shim is not managed by openark: ${shim}`,
      hint: "rename or remove it, then re-run doctor --fix",
    };
  }
  if (distOk && !readFileSync(shim, "utf8").includes(new URL(`file://${pluginDistPath()}`).href)) {
    return {
      id,
      status: "warn",
      message: "plugin shim points at a different plugin dist",
      hint: shim,
      fix: () => `plugin shim rewritten: ${installPluginShim(configDir)}`,
    };
  }
  return { id, status: "ok", message: `plugin shim: ${shim}` };
}

function checkAgentFile(name: string, configDir: string, home: string): DoctorCheck {
  const id = `agent-file:${name}`;
  const path = join(configDir, "agents", `${name}.md`);
  if (!existsSync(path)) {
    return {
      id,
      status: "error",
      message: `agent file missing for ${name}`,
      hint: path,
      fix: () => {
        mkdirSync(join(configDir, "agents"), { recursive: true });
        writeFileSync(path, renderAgentFile(name, readAgentDescription(name, home), home));
        return `agent file written: ${path}`;
      },
    };
  }
  if (!isManagedFile(path)) {
    return {
      id,
      status: "error",
      message: `agent file for ${name} is not managed by openark: ${path}`,
      hint: "rename or remove it, then re-run doctor --fix",
    };
  }
  return { id, status: "ok", message: `agent file: ${path}` };
}

function checkAgentManifest(name: string, home: string): DoctorCheck {
  const id = `agent-manifest:${name}`;
  const path = join(agentHome(name, home), "agent.json");
  try {
    JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {
      id,
      status: "error",
      message: `agent manifest is not valid JSON: ${path}`,
      hint: "fix it by hand (backups live in git, not here)",
    };
  }
  return { id, status: "ok", message: `agent manifest: ${path}` };
}

function checkOrphanAgentDirs(home: string): DoctorCheck[] {
  const agentsDir = join(home, "agents");
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((entry) => {
      try {
        return lstatSync(join(agentsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((entry) => !existsSync(join(agentsDir, entry, "agent.json")))
    .map((entry) => ({
      id: `agent-dir:${entry}`,
      status: "warn" as const,
      message: `directory has no agent.json, openark ignores it: ${join(agentsDir, entry)}`,
      hint: "delete it, or add an agent.json to make it an agent",
    }));
}

function verifiedSkills(agent: string, home: string): string[] {
  const agentSkills = join(agentHome(agent, home), "skills");
  if (!existsSync(agentSkills)) return [];
  return readdirSync(agentSkills).filter(
    (entry) => entry !== "drafts" && existsSync(join(agentSkills, entry, "SKILL.md")),
  );
}

function checkSkillLinks(configDir: string, home: string, agents: string[]): DoctorCheck {
  const id = "skill-links";
  const skillsDir = join(configDir, "skills");
  const missing: string[] = [];
  const collisions: string[] = [];
  const taken: string[] = [];
  const stale: string[] = [];

  for (const agent of agents) {
    for (const skill of verifiedSkills(agent, home)) {
      const linkPath = join(skillsDir, skill);
      const target = linkTarget(linkPath);
      if (target === null && !existsSync(linkPath)) {
        missing.push(skill);
      } else if (target !== join(agentHome(agent, home), "skills", skill)) {
        (isOpenarkLink(linkPath, home) ? collisions : taken).push(skill);
      }
    }
  }

  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir)) {
      const linkPath = join(skillsDir, entry);
      if (isOpenarkLink(linkPath, home) && !existsSync(linkPath)) {
        stale.push(entry);
      }
    }
  }

  if (!missing.length && !collisions.length && !taken.length && !stale.length) {
    return { id, status: "ok", message: `skill links: ${skillsDir}` };
  }

  const parts: string[] = [];
  if (missing.length) parts.push(`missing links: ${missing.join(", ")}`);
  if (stale.length) parts.push(`stale links: ${stale.join(", ")}`);
  if (collisions.length) parts.push(`shared name across agents: ${collisions.join(", ")}`);
  if (taken.length) parts.push(`names taken by non-openark entries: ${taken.join(", ")}`);
  const check: DoctorCheck = {
    id,
    status: missing.length || stale.length ? "error" : "warn",
    message: `skill links need attention (${parts.join("; ")})`,
    hint: skillsDir,
  };
  if (missing.length || stale.length) {
    check.fix = () => {
      const linked = linkSkills(configDir, home);
      return `skill links refreshed (${linked.length} linked)`;
    };
  }
  return check;
}

function checkCommands(configDir: string): DoctorCheck {
  const id = "commands";
  const commandsDir = join(packageRoot(), "commands");
  const bundled = existsSync(commandsDir)
    ? readdirSync(commandsDir).filter((entry) => entry.endsWith(".md"))
    : [];
  const missing = bundled.filter((entry) => !existsSync(join(configDir, "commands", entry)));
  if (!bundled.length) return { id, status: "ok", message: "commands: none bundled" };
  if (missing.length) {
    return {
      id,
      status: "error",
      message: `slash commands missing: ${missing.join(", ")}`,
      hint: join(configDir, "commands"),
      fix: () => {
        const copied = installCommands(configDir);
        return `slash commands copied (${copied.length})`;
      },
    };
  }
  return { id, status: "ok", message: `slash commands: ${bundled.length} installed` };
}

function checkVenv(home: string, serviceDir?: string): DoctorCheck {
  const id = "venv";
  const python = installedVenvPython(home);
  if (!existsSync(python)) {
    return {
      id,
      status: "error",
      message: "service venv missing",
      hint: python,
      fix: () => {
        const result = bootstrapVenv(serviceDir ? { home, serviceDir } : { home });
        return `bootstrapped service venv: ${result.python}`;
      },
    };
  }
  return { id, status: "ok", message: `service venv: ${python}` };
}

function checkGlobalConfig(home: string): DoctorCheck {
  const id = "global-config";
  const path = join(home, "openark.json");
  if (!existsSync(path)) {
    return { id, status: "ok", message: "global config: defaults (no openark.json)" };
  }
  let parsed: { servicePort?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { servicePort?: unknown };
  } catch {
    return {
      id,
      status: "error",
      message: `global config is not valid JSON: ${path}`,
      hint: "fix it by hand, or delete it to fall back to defaults",
    };
  }
  if (
    parsed.servicePort !== undefined &&
    (typeof parsed.servicePort !== "number" ||
      !Number.isInteger(parsed.servicePort) ||
      parsed.servicePort < 1 ||
      parsed.servicePort > 65535)
  ) {
    return {
      id,
      status: "error",
      message: `servicePort must be an integer 1-65535: ${path}`,
      hint: "fix it by hand, or delete it to fall back to defaults",
    };
  }
  return { id, status: "ok", message: `global config: ${path}` };
}

async function checkService(home: string): Promise<DoctorCheck> {
  const config = readGlobalConfig(home);
  const client = new ServiceClient(serviceBaseUrl(config));
  return (await client.health())
    ? { id: "service", status: "ok", message: "service: up" }
    : {
        id: "service",
        status: "warn",
        message: "service: down",
        hint: "start it with: openark start",
      };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const home = options.home ?? openarkHome();
  const configDir = options.configDir ?? opencodeConfigDir();

  const distCheck = checkPluginDist();
  const agents = listAgents(home);
  const checks: DoctorCheck[] = [
    distCheck,
    checkPluginShim(configDir, distCheck.status === "ok"),
    checkGlobalConfig(home),
    checkVenv(home, options.serviceDir),
    ...agents.map((name) => checkAgentFile(name, configDir, home)),
    ...agents.map((name) => checkAgentManifest(name, home)),
    ...checkOrphanAgentDirs(home),
    checkSkillLinks(configDir, home, agents),
    checkCommands(configDir),
    await checkService(home),
  ];
  return checks;
}
