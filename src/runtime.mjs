import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

/** Finds the real opencode executable behind the npm shim, since a .cmd shim cannot be spawned without a shell. */
export function findOpenCodeBin(configured) {
  if (configured && existsSync(configured)) return configured;
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" });
  for (const line of (lookup.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
    const shimDir = dirname(line);
    const exe = join(shimDir, "node_modules", "opencode-ai", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
    if (existsSync(exe)) return exe;
    if (!line.toLowerCase().endsWith(".cmd") && !line.toLowerCase().endsWith(".ps1") && existsSync(line)) return line;
  }
  throw new Error("Could not find the opencode executable. Set OPENCODE_MCP_BIN to its full path.");
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Starts `opencode serve` on loopback with its own random password, and reads both back from its output. */
async function startPrivateServer(bin) {
  const port = await freePort();
  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("opencode serve did not start within 30 seconds")), 30_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const password = /server password (\S+)/.exec(output)?.[1];
      if (password && /server listening on/.test(output)) {
        clearTimeout(timer);
        resolve({ url: `http://127.0.0.1:${port}`, password });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`opencode serve exited early (code ${code})`));
    });
  });
  return { child, ready };
}

/**
 * Gives the tools a server to talk to: the one named in the config, or a private one started on first use and
 * stopped when this process ends. A private server listens on loopback only and its password never leaves memory.
 */
export function createRuntime(config) {
  let pending = null;
  let child = null;
  const getServer = () => {
    if (config.serverUrl && config.serverPassword) return Promise.resolve({ url: config.serverUrl, password: config.serverPassword });
    pending ??= startPrivateServer(findOpenCodeBin(config.bin)).then(({ child: started, ready }) => {
      child = started;
      child.once("exit", () => (pending = null));
      return ready;
    });
    return pending.catch((error) => {
      pending = null;
      throw error;
    });
  };
  const stop = () => child?.kill();
  process.once("exit", stop);
  return { getServer, stop, isPrivate: !(config.serverUrl && config.serverPassword) };
}
