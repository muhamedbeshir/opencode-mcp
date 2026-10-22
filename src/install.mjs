import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { entryPoint, runSetup } from "./setup.mjs";

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

/** Adds the server to a JSON file that has an `mcpServers` object, keeping everything else and a `.bak` copy. */
function addToJsonConfig(path) {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  mkdirSync(dirname(path), { recursive: true });
  const current = readJson(path);
  const servers = { ...(current.mcpServers ?? {}), opencode: { command: process.execPath, args: [entryPoint] } };
  writeFileSync(path, `${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`);
  return path;
}

/** Claude Desktop keeps its config in %APPDATA%\Claude, or inside the package folder for the Microsoft Store build. */
function claudeDesktopFolders(env) {
  const folders = [];
  if (env.APPDATA) folders.push(join(env.APPDATA, "Claude"));
  const packages = join(env.LOCALAPPDATA ?? "", "Packages");
  if (env.LOCALAPPDATA && existsSync(packages)) {
    for (const name of readdirSync(packages).filter((n) => n.startsWith("Claude_"))) folders.push(join(packages, name, "LocalCache", "Roaming", "Claude"));
  }
  return folders.filter((folder) => existsSync(folder));
}

function installClaudeCode() {
  const args = ["mcp", "add", "--scope", "user", "opencode", "--", process.execPath, entryPoint];
  const quote = (value) => `"${value}"`;
  let run = spawnSync("claude", args, { encoding: "utf8" });
  if (run.error) run = spawnSync(["claude", ...args.map(quote)].join(" "), { encoding: "utf8", shell: true });
  if (run.error || (run.status !== 0 && !/already exists/i.test(`${run.stderr}${run.stdout}`))) return { ok: false, detail: run.error?.message ?? (run.stderr || run.stdout).trim().slice(0, 200) };
  return { ok: true, detail: "registered with `claude mcp add --scope user`", restart: "Start a new Claude Code session." };
}

function installClaudeDesktop(env) {
  const folders = claudeDesktopFolders(env);
  if (!folders.length) return { ok: false, detail: "Claude Desktop does not look installed" };
  const written = folders.map((folder) => addToJsonConfig(join(folder, "claude_desktop_config.json")));
  return { ok: true, detail: written.join(", "), restart: "Quit Claude Desktop completely (tray icon too) and open it again." };
}

function installCursor() {
  const folder = join(homedir(), ".cursor");
  if (!existsSync(folder)) return { ok: false, detail: "Cursor does not look installed" };
  return { ok: true, detail: addToJsonConfig(join(folder, "mcp.json")), restart: "Restart Cursor." };
}

export const CLIENTS = { "claude-code": installClaudeCode, "claude-desktop": installClaudeDesktop, cursor: installCursor };

/**
 * One command that makes the server usable: writes the settings, authorizes the folders, and registers the server
 * with every client it finds (or only the ones named). Returns a report; nothing is printed here.
 */
export function install({ allow = [], clients = [], env = process.env } = {}) {
  const setup = runSetup({ allow, env });
  const wanted = clients.length ? clients : Object.keys(CLIENTS);
  const results = wanted.map((name) => {
    if (!CLIENTS[name]) return { client: name, ok: false, detail: `unknown client (known: ${Object.keys(CLIENTS).join(", ")})` };
    return { client: name, ...CLIENTS[name](env) };
  });
  const snippet = { mcpServers: { opencode: { command: process.execPath, args: [entryPoint] } } };
  return { setup, results, snippet };
}
