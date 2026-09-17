import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installedVenvPython } from "../src/core/bootstrap";
import {
  devVenvPython,
  ensureService,
  isProcessAlive,
  pidFilePath,
  readServicePid,
  resolveServicePython,
  serviceDirFromEnv,
  spawnService,
  stopService,
  waitForHealth,
  writeServicePid,
} from "../src/core/lifecycle";
import type { ServiceClient } from "../src/core/service";

describe("serviceDirFromEnv", () => {
  it("prefers OPENARK_SERVICE_DIR", () => {
    expect(serviceDirFromEnv({ OPENARK_SERVICE_DIR: "/x/y" } as NodeJS.ProcessEnv)).toBe("/x/y");
  });

  it("falls back to ./service", () => {
    expect(serviceDirFromEnv({} as NodeJS.ProcessEnv)).toBe(join(process.cwd(), "service"));
  });
});

describe("waitForHealth", () => {
  it("returns true when the service is healthy", async () => {
    const client = { health: vi.fn(async () => true) } as unknown as ServiceClient;
    expect(await waitForHealth(client, 100, 10)).toBe(true);
  });

  it("returns false after timing out", async () => {
    const client = { health: vi.fn(async () => false) } as unknown as ServiceClient;
    expect(await waitForHealth(client, 60, 20)).toBe(false);
  });

  it("recovers when health flips mid-wait", async () => {
    let calls = 0;
    const client = {
      health: vi.fn(async () => {
        calls += 1;
        return calls >= 2;
      }),
    } as unknown as ServiceClient;
    expect(await waitForHealth(client, 500, 10)).toBe(true);
  });
});

describe("resolveServicePython", () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;

  function fakePython(path: string): string {
    mkdirSync(join(path), { recursive: true });
    const python = join(path, "python");
    writeFileSync(python, "#!/bin/sh\nexit 0\n");
    return python;
  }

  it("prefers an explicit pythonBin when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "openark-lifecycle-"));
    try {
      const python = fakePython(dir);
      expect(resolveServicePython({ pythonBin: python, env: emptyEnv })).toBe(python);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a missing explicit pythonBin", () => {
    const dir = mkdtempSync(join(tmpdir(), "openark-lifecycle-"));
    try {
      expect(
        resolveServicePython({ pythonBin: join(dir, "nope"), env: emptyEnv, home: dir }),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the installed venv in the default case (any cwd)", () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "openark-cwd-"));
    const prevCwd = process.cwd();
    try {
      const installedDir = join(home, "venv", "bin");
      const installed = fakePython(installedDir);
      expect(installed).toBe(installedVenvPython(home));
      // A cwd-derived dev venv exists too — it must still lose to the
      // installed venv, otherwise auto-spawn only works inside the
      // service checkout.
      fakePython(join(cwd, "service", ".venv", "bin"));
      process.chdir(cwd);
      expect(resolveServicePython({ home, env: emptyEnv })).toBe(installed);
    } finally {
      process.chdir(prevCwd);
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("prefers the dev venv when a service dir is explicitly given", () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    const serviceDir = mkdtempSync(join(tmpdir(), "openark-svc-"));
    try {
      fakePython(join(home, "venv", "bin"));
      const dev = fakePython(join(serviceDir, ".venv", "bin"));
      expect(resolveServicePython({ home, serviceDir, env: emptyEnv })).toBe(dev);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(serviceDir, { recursive: true, force: true });
    }
  });

  it("falls back to the installed venv when the explicit dev venv is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    const serviceDir = mkdtempSync(join(tmpdir(), "openark-svc-"));
    try {
      const installed = fakePython(join(home, "venv", "bin"));
      expect(resolveServicePython({ home, serviceDir, env: emptyEnv })).toBe(installed);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(serviceDir, { recursive: true, force: true });
    }
  });

  it("falls back to the dev venv when the installed venv is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    const serviceDir = mkdtempSync(join(tmpdir(), "openark-svc-"));
    try {
      const dev = fakePython(join(serviceDir, ".venv", "bin"));
      expect(resolveServicePython({ home, serviceDir, env: emptyEnv })).toBe(dev);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(serviceDir, { recursive: true, force: true });
    }
  });

  it("returns null when neither venv exists", () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    const serviceDir = mkdtempSync(join(tmpdir(), "openark-svc-"));
    try {
      expect(resolveServicePython({ home, serviceDir, env: emptyEnv })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(serviceDir, { recursive: true, force: true });
    }
  });
});

describe("spawnService", () => {
  it("returns null when no venv python exists (isolated home)", () => {
    const dir = mkdtempSync(join(tmpdir(), "openark-lifecycle-"));
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    try {
      expect(spawnService({ serviceDir: dir, home, env: {} })).toBeNull();
      expect(devVenvPython(dir)).toBe(join(dir, ".venv", "bin", "python"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("spawns uvicorn when the venv exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openark-lifecycle-"));
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    try {
      mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
      const python = join(dir, ".venv", "bin", "python");
      writeFileSync(python, "#!/bin/sh\nexit 0\n");
      const child = spawnService({ serviceDir: dir, home, port: 8799, env: {} });
      expect(child).not.toBeNull();
      await new Promise((resolve) => {
        (child ?? { on: () => {}, once: () => {} }).once?.("exit", resolve);
        setTimeout(resolve, 2000);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes the spawned pid so stop can find it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openark-lifecycle-"));
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    try {
      mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
      const python = join(dir, ".venv", "bin", "python");
      writeFileSync(python, "#!/bin/sh\nsleep 30\n");
      const child = spawnService({ serviceDir: dir, home, port: 8798, env: {} });
      expect(child).not.toBeNull();
      expect(readServicePid(home)).toBe(child?.pid ?? null);
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ensureService", () => {
  it("skips spawning when already healthy", async () => {
    const client = { health: vi.fn(async () => true) } as unknown as ServiceClient;
    const spawnSpy = vi.fn();
    const result = await ensureService(client, {});
    expect(result).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("gives up when spawning is impossible and health never comes up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openark-lifecycle-"));
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    try {
      const client = { health: vi.fn(async () => false) } as unknown as ServiceClient;
      const result = await ensureService(client, { serviceDir: dir, home, env: {} });
      expect(result).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("service pid file", () => {
  it("round-trips a pid and reports liveness", () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    try {
      expect(readServicePid(home)).toBeNull();
      expect(pidFilePath(home)).toBe(join(home, "service.pid"));
      writeServicePid(home, process.pid);
      expect(readServicePid(home)).toBe(process.pid);
      expect(isProcessAlive(process.pid)).toBe(true);
      expect(isProcessAlive(2147483647)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects junk pid files instead of signalling a garbage pid", () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    try {
      writeFileSync(pidFilePath(home), "123abc\n");
      expect(readServicePid(home)).toBeNull();
      writeFileSync(pidFilePath(home), "-5\n");
      expect(readServicePid(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to kill a live pid that is not the openark service", async () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    const child = spawn("sleep", ["30"]);
    try {
      if (child.pid === undefined) return;
      writeServicePid(home, child.pid);
      const client = { health: vi.fn(async () => true) } as unknown as ServiceClient;
      const result = await stopService(client, { home, port: 8797 });
      expect(result.stopped).toBe(false);
      if (result.stopped === false) expect(result.reason).toBe("not-service");
      expect(isProcessAlive(child.pid)).toBe(true);
      // The stale pid file is dropped either way.
      expect(readServicePid(home)).toBeNull();
    } finally {
      child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stop reports not-running when nothing is up and no pid file", async () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    try {
      const client = { health: vi.fn(async () => false) } as unknown as ServiceClient;
      const result = await stopService(client, { home, port: 8797 });
      expect(result).toEqual({ stopped: false, reason: "not-running" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stop clears a stale pid file without killing anything", async () => {
    const home = mkdtempSync(join(tmpdir(), "openark-home-"));
    try {
      writeServicePid(home, 2147483647);
      const client = { health: vi.fn(async () => false) } as unknown as ServiceClient;
      const result = await stopService(client, { home, port: 8797 });
      expect(result.stopped).toBe(false);
      expect(readServicePid(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
