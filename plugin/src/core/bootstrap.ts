import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openarkHome } from "./config.js";

export type BootstrapOptions = {
  home?: string;
  serviceDir?: string;
  uvBin?: string;
};

export function venvPython(home: string = openarkHome()): string {
  return join(home, "venv", "bin", "python");
}

export function uvAvailable(uvBin = "uv"): boolean {
  const res = spawnSync(uvBin, ["--version"], { encoding: "utf8" });
  return res.status === 0;
}

export function bootstrapVenv(options: BootstrapOptions = {}): {
  python: string;
  created: boolean;
} {
  const home = options.home ?? openarkHome();
  const python = venvPython(home);
  if (existsSync(python)) {
    return { python, created: false };
  }

  const uv = options.uvBin ?? "uv";
  if (!uvAvailable(uv)) {
    throw new Error("uv not found — install it from https://docs.astral.sh/uv/ then re-run");
  }

  mkdirSync(join(home, "venv"), { recursive: true });
  const venvRoot = join(home, "venv");
  const create = spawnSync(uv, ["venv", venvRoot, "--python", ">=3.11"], { stdio: "inherit" });
  if (create.status !== 0) {
    throw new Error("uv venv failed");
  }

  const serviceDir = options.serviceDir ?? process.env.OPENARK_SERVICE_DIR;
  const isDev = Boolean(serviceDir && existsSync(join(serviceDir, "pyproject.toml")));
  const requirement = isDev
    ? `-e ${join(serviceDir as string)}[memory]`
    : "openark-service[memory]";

  const install = spawnSync(uv, ["pip", "install", "--python", python, requirement], {
    stdio: "inherit",
  });
  if (install.status !== 0) {
    throw new Error(`uv pip install failed for ${requirement}`);
  }
  return { python, created: true };
}
