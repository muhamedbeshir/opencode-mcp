import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Where the setup command writes the settings. Override with OPENCODE_MCP_CONFIG. */
export function configPath(env = process.env) {
  return env.OPENCODE_MCP_CONFIG ?? join(env.APPDATA ?? join(homedir(), ".config"), "opencode-mcp", "config.json");
}

const readFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

/**
 * Settings come from the config file, and environment variables win over it.
 * `allowedDirs` is the list of project directories the server may touch; empty means nothing is allowed.
 */
export function loadConfig(env = process.env) {
  const file = readFile(configPath(env));
  const dirs = env.OPENCODE_MCP_ALLOWED_DIRS ? env.OPENCODE_MCP_ALLOWED_DIRS.split(delimiter).filter(Boolean) : file.allowedDirs ?? [];
  return {
    allowedDirs: dirs,
    bin: env.OPENCODE_MCP_BIN ?? file.bin ?? null,
    serverUrl: env.OPENCODE_MCP_SERVER_URL ?? file.serverUrl ?? null,
    serverPassword: env.OPENCODE_MCP_SERVER_PASSWORD ?? file.serverPassword ?? null,
    httpPort: Number(env.OPENCODE_MCP_HTTP_PORT ?? file.httpPort ?? 47600),
    httpToken: env.OPENCODE_MCP_TOKEN ?? file.httpToken ?? null,
    maxWaitSeconds: Number(file.maxWaitSeconds ?? 900),
    // Extra Host and Origin values the HTTP transport accepts, for use behind a tunnel or from a browser client.
    allowedHosts: (env.OPENCODE_MCP_ALLOWED_HOSTS?.split(",") ?? file.allowedHosts ?? []).map((h) => h.trim()).filter(Boolean),
    allowedOrigins: (env.OPENCODE_MCP_ALLOWED_ORIGINS?.split(",") ?? file.allowedOrigins ?? []).map((o) => o.trim()).filter(Boolean),
  };
}
