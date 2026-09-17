import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedAgentHome } from "../src/core/agent-template";
import {
  generateAgentFiles,
  installAll,
  installCommands,
  installPluginShim,
  isOpenarkLink,
  linkSkills,
  listAgents,
  opencodeConfigDir,
  removeAgentFiles,
  renderAgentFile,
  uninstallAll,
  uninstallCommands,
  uninstallPluginShim,
  unlinkSkills,
} from "../src/core/installer";

let home: string;
let configDir: string;

function makeSkill(agent: string, slug: string, draft = false): void {
  const base = join(home, "agents", agent, "skills", draft ? "drafts" : "", slug);
  mkdirSync(base, { recursive: true });
  writeFileSync(
    join(base, "SKILL.md"),
    `---\nname: ${slug}\ndescription: test skill ${slug}\n---\n\nsteps\n`,
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "openark-install-"));
  configDir = join(home, "opencode-config");
  process.env.OPENARK_HOME = home;
  process.env.OPENCODE_CONFIG_DIR = configDir;
});

afterEach(() => {
  delete process.env.OPENARK_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  rmSync(home, { recursive: true, force: true });
});

describe("listAgents", () => {
  it("lists agents with manifests", () => {
    expect(listAgents(home)).toEqual([]);
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    seedAgentHome(join(home, "agents", "other"), "other");
    mkdirSync(join(home, "agents", "not-an-agent"));
    expect(listAgents(home)).toEqual(["defoko", "other"]);
  });
});

describe("opencodeConfigDir", () => {
  it("honors OPENCODE_CONFIG_DIR", () => {
    expect(opencodeConfigDir({ OPENCODE_CONFIG_DIR: "/x" } as NodeJS.ProcessEnv)).toBe("/x");
  });

  it("falls back to XDG_CONFIG_HOME", () => {
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe(
      "/xdg/opencode",
    );
  });
});

describe("installPluginShim", () => {
  it("writes a shim pointing at the plugin dist", () => {
    const shim = installPluginShim(configDir);
    const content = readFileSync(shim, "utf8");
    expect(content).toContain("export { default } from");
    expect(content).toContain("file://");
  });
});

describe("generateAgentFiles", () => {
  it("writes one primary agent file per openark agent", () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko", "the mascot");
    const files = generateAgentFiles(configDir, home);
    expect(files).toEqual([join(configDir, "agents", "defoko.md")]);
    const content = readFileSync(files[0], "utf8");
    expect(content).toContain("description: the mascot");
    expect(content).toContain("mode: primary");
    expect(content).toContain("Managed by openark");
  });
});

describe("renderAgentFile", () => {
  it("escapes newlines in descriptions", () => {
    const content = renderAgentFile("x", "line1\nline2", home);
    expect(content).toContain("description: line1 line2");
  });
});

describe("linkSkills", () => {
  it("symlinks verified skills and skips drafts", () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    makeSkill("defoko", "release-checklist");
    makeSkill("defoko", "wip-skill", true);

    const linked = linkSkills(configDir, home);
    expect(linked).toEqual([join(configDir, "skills", "release-checklist")]);
    expect(existsSync(join(configDir, "skills", "release-checklist", "SKILL.md"))).toBe(true);
    expect(existsSync(join(configDir, "skills", "wip-skill"))).toBe(false);
  });

  it("prunes stale openark links and keeps foreign entries", () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    const skillsDir = join(configDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const stale = join(skillsDir, "gone-skill");
    symlinkSync(join(home, "agents", "defoko", "skills", "gone-skill"), stale, "dir");
    mkdirSync(join(skillsDir, "user-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "user-skill", "SKILL.md"), "user skill");

    makeSkill("defoko", "fresh-skill");
    const linked = linkSkills(configDir, home);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(skillsDir, "user-skill", "SKILL.md"))).toBe(true);
    expect(linked).toEqual([join(skillsDir, "fresh-skill")]);
  });
});

describe("installCommands", () => {
  it("copies bundled command templates", () => {
    const copied = installCommands(configDir, join(process.cwd(), "commands"));
    expect(copied.length).toBeGreaterThan(0);
    for (const file of copied) {
      expect(file.endsWith(".md")).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
  });

  it("returns empty when the commands dir is missing", () => {
    expect(installCommands(configDir, "/nonexistent")).toEqual([]);
  });
});

describe("installAll", () => {
  it("wires everything together", () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    makeSkill("defoko", "release-checklist");
    const result = installAll(configDir, home);
    expect(result.pluginPath).toContain("openark.js");
    expect(result.agentFiles).toHaveLength(1);
    expect(result.skillLinks).toHaveLength(1);
    expect(result.commandFiles.length).toBeGreaterThan(0);
  });
});

describe("uninstallPluginShim", () => {
  it("removes the managed shim", () => {
    installPluginShim(configDir);
    expect(uninstallPluginShim(configDir)).toBe(join(configDir, "plugins", "openark.js"));
    expect(existsSync(join(configDir, "plugins", "openark.js"))).toBe(false);
  });

  it("leaves a foreign shim alone", () => {
    const pluginsDir = join(configDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "openark.js"), "// user-owned");
    expect(uninstallPluginShim(configDir)).toBeNull();
    expect(existsSync(join(pluginsDir, "openark.js"))).toBe(true);
  });
});

describe("removeAgentFiles", () => {
  it("removes managed agent files and keeps foreign ones", () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    generateAgentFiles(configDir, home);
    const userFile = join(configDir, "agents", "user-agent.md");
    mkdirSync(join(configDir, "agents"), { recursive: true });
    writeFileSync(userFile, "---\ndescription: mine\n---\n");

    const removed = removeAgentFiles(configDir);

    expect(removed).toEqual([join(configDir, "agents", "defoko.md")]);
    expect(existsSync(join(configDir, "agents", "defoko.md"))).toBe(false);
    expect(existsSync(userFile)).toBe(true);
  });
});

describe("unlinkSkills", () => {
  it("removes openark links and keeps foreign entries", () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    makeSkill("defoko", "release-checklist");
    linkSkills(configDir, home);
    const userSkill = join(configDir, "skills", "user-skill");
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "user skill");

    const removed = unlinkSkills(configDir, home);

    expect(removed).toEqual([join(configDir, "skills", "release-checklist")]);
    expect(existsSync(join(configDir, "skills", "release-checklist"))).toBe(false);
    expect(existsSync(join(userSkill, "SKILL.md"))).toBe(true);
  });
});

describe("uninstallCommands", () => {
  it("removes bundled commands and keeps user commands", () => {
    installCommands(configDir, join(process.cwd(), "commands"));
    const userCommand = join(configDir, "commands", "user-command.md");
    writeFileSync(userCommand, "user command");

    const removed = uninstallCommands(configDir, join(process.cwd(), "commands"));

    expect(removed.length).toBeGreaterThan(0);
    for (const file of removed) expect(existsSync(file)).toBe(false);
    expect(existsSync(userCommand)).toBe(true);
  });
});

describe("uninstallAll", () => {
  it("reverses installAll", () => {
    seedAgentHome(join(home, "agents", "defoko"), "defoko");
    makeSkill("defoko", "release-checklist");
    installAll(configDir, home);

    const result = uninstallAll(configDir, home);

    expect(result.pluginPath).toBe(join(configDir, "plugins", "openark.js"));
    expect(result.agentFiles).toHaveLength(1);
    expect(result.skillLinks).toHaveLength(1);
    expect(result.commandFiles.length).toBeGreaterThan(0);
    expect(existsSync(join(home, "agents", "defoko", "agent.json"))).toBe(true);
  });

  it("is a no-op when nothing is installed", () => {
    const result = uninstallAll(configDir, home);
    expect(result.pluginPath).toBeNull();
    expect(result.agentFiles).toEqual([]);
    expect(result.skillLinks).toEqual([]);
    expect(result.commandFiles).toEqual([]);
  });
});

describe("command ownership", () => {
  it("does not clobber a user-owned command with a bundled name", () => {
    const commandsSrc = mkdtempSync(join(tmpdir(), "openark-cmds-"));
    try {
      const target = join(configDir, "commands");
      mkdirSync(target, { recursive: true });
      const userFile = join(target, "learn.md");
      writeFileSync(userFile, "user's own command\n");
      writeFileSync(join(commandsSrc, "learn.md"), "bundled command\n");

      installCommands(configDir, commandsSrc);
      expect(readFileSync(userFile, "utf8")).toBe("user's own command\n");

      // Uninstall must not delete it either.
      const removed = uninstallCommands(configDir, commandsSrc);
      expect(removed).toEqual([]);
      expect(existsSync(userFile)).toBe(true);
    } finally {
      rmSync(commandsSrc, { recursive: true, force: true });
    }
  });

  it("updates its own installed command on reinstall and removes it on uninstall", () => {
    const commandsSrc = mkdtempSync(join(tmpdir(), "openark-cmds-"));
    try {
      writeFileSync(join(commandsSrc, "learn.md"), "v1\n");
      installCommands(configDir, commandsSrc);
      const installed = join(configDir, "commands", "learn.md");
      expect(readFileSync(installed, "utf8")).toContain("v1");

      writeFileSync(join(commandsSrc, "learn.md"), "v2\n");
      installCommands(configDir, commandsSrc);
      expect(readFileSync(installed, "utf8")).toContain("v2");

      expect(uninstallCommands(configDir, commandsSrc)).toEqual([installed]);
      expect(existsSync(installed)).toBe(false);
    } finally {
      rmSync(commandsSrc, { recursive: true, force: true });
    }
  });
});

describe("generateAgentFiles pruning", () => {
  it("removes managed agent files for deleted agents and keeps foreign files", () => {
    seedAgentHome(join(home, "agents", "keep"), "keep");
    seedAgentHome(join(home, "agents", "gone"), "gone");
    generateAgentFiles(configDir, home);
    const foreign = join(configDir, "agents", "foreign.md");
    writeFileSync(foreign, "not managed by openark\n");

    rmSync(join(home, "agents", "gone"), { recursive: true, force: true });
    generateAgentFiles(configDir, home);

    expect(existsSync(join(configDir, "agents", "keep.md"))).toBe(true);
    expect(existsSync(join(configDir, "agents", "gone.md"))).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });
});

describe("isOpenarkLink", () => {
  it("recognizes links even when the home path has a trailing separator", () => {
    const target = join(home, "agents", "defoko", "skills", "demo");
    mkdirSync(target, { recursive: true });
    const link = join(configDir, "skills", "demo");
    mkdirSync(join(configDir, "skills"), { recursive: true });
    symlinkSync(target, link);

    expect(isOpenarkLink(link, home)).toBe(true);
    expect(isOpenarkLink(link, `${home}/`)).toBe(true);
  });
});
