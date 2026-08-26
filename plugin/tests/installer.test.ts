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
  linkSkills,
  listAgents,
  opencodeConfigDir,
  renderAgentFile,
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
    seedAgentHome(join(home, "agents", "chiai"), "chiai");
    seedAgentHome(join(home, "agents", "other"), "other");
    mkdirSync(join(home, "agents", "not-an-agent"));
    expect(listAgents(home)).toEqual(["chiai", "other"]);
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
    expect(content).toContain("export { plugin, default } from");
    expect(content).toContain("file://");
  });
});

describe("generateAgentFiles", () => {
  it("writes one primary agent file per openark agent", () => {
    seedAgentHome(join(home, "agents", "chiai"), "chiai", "the mascot");
    const files = generateAgentFiles(configDir, home);
    expect(files).toEqual([join(configDir, "agents", "chiai.md")]);
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
    seedAgentHome(join(home, "agents", "chiai"), "chiai");
    makeSkill("chiai", "release-checklist");
    makeSkill("chiai", "wip-skill", true);

    const linked = linkSkills(configDir, home);
    expect(linked).toEqual([join(configDir, "skills", "release-checklist")]);
    expect(existsSync(join(configDir, "skills", "release-checklist", "SKILL.md"))).toBe(true);
    expect(existsSync(join(configDir, "skills", "wip-skill"))).toBe(false);
  });

  it("prunes stale openark links and keeps foreign entries", () => {
    seedAgentHome(join(home, "agents", "chiai"), "chiai");
    const skillsDir = join(configDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const stale = join(skillsDir, "gone-skill");
    symlinkSync(join(home, "agents", "chiai", "skills", "gone-skill"), stale, "dir");
    mkdirSync(join(skillsDir, "user-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "user-skill", "SKILL.md"), "user skill");

    makeSkill("chiai", "fresh-skill");
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
    seedAgentHome(join(home, "agents", "chiai"), "chiai");
    makeSkill("chiai", "release-checklist");
    const result = installAll(configDir, home);
    expect(result.pluginPath).toContain("openark.js");
    expect(result.agentFiles).toHaveLength(1);
    expect(result.skillLinks).toHaveLength(1);
    expect(result.commandFiles.length).toBeGreaterThan(0);
  });
});
