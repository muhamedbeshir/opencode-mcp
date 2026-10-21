import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "./config.mjs";
import { findOpenCodeBin } from "./runtime.mjs";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "opencode-mcp.mjs");

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

/** Creates or updates the settings file. Existing values stay; `allow` directories are added; a token is made once. */
export function runSetup({ allow = [], env = process.env } = {}) {
  const path = configPath(env);
  const file = readJson(path);
  const allowedDirs = [...new Set([...(file.allowedDirs ?? []), ...allow.map((d) => resolve(d))])];
  const next = { ...file, allowedDirs, httpPort: file.httpPort ?? 47600, httpToken: file.httpToken ?? randomBytes(32).toString("base64url") };
  try {
    next.bin ??= findOpenCodeBin(null);
  } catch (error) {
    process.stderr.write(`warning: ${error.message}\n`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { path, allowedDirs, bin: next.bin ?? null };
}

export const showToken = (env = process.env) => readJson(configPath(env)).httpToken ?? null;

/** Adds this server to Claude Desktop's config, keeping every other setting and saving a backup copy first. */
export function registerClaudeDesktop({ env = process.env } = {}) {
  const path = join(env.APPDATA ?? "", "Claude", "claude_desktop_config.json");
  if (!env.APPDATA || !existsSync(dirname(path))) throw new Error("Claude Desktop does not look installed (no %APPDATA%\\Claude folder).");
  const current = existsSync(path) ? readJson(path) : {};
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const servers = { ...(current.mcpServers ?? {}), opencode: { command: process.execPath, args: [entry] } };
  writeFileSync(path, `${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`);
  return { path, backup: existsSync(`${path}.bak`) ? `${path}.bak` : null };
}

export const entryPoint = entry;
