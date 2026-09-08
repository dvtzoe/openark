import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openarkHome } from "./config.js";

export type PluginLogger = (level: "info" | "warn" | "error", message: string) => void;

// The opencode TUI owns stdout/stderr while it renders — a single
// console.log from the plugin paints over the interface (and lingers
// until the next redraw). So the plugin runtime never touches stdio:
// all logs go to ~/.openark/logs/plugin.log, best-effort. Set
// OPENARK_DEBUG=1 to also mirror to stderr while debugging outside
// the TUI.
export function createPluginLogger(
  home: string = openarkHome(),
  env: NodeJS.ProcessEnv = process.env,
): PluginLogger {
  const debug = env.OPENARK_DEBUG === "1" || env.OPENARK_DEBUG === "true";
  return (level, message) => {
    const line = `${new Date().toISOString()} [openark:${level}] ${message}\n`;
    try {
      mkdirSync(join(home, "logs"), { recursive: true });
      appendFileSync(join(home, "logs", "plugin.log"), line);
    } catch {
      // Logging must never break a session.
    }
    if (debug) {
      try {
        process.stderr.write(line);
      } catch {
        // ignore — file log already captured it
      }
    }
  };
}

export function noopLogger(): PluginLogger {
  return () => {};
}
