#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { serveHttp } from "../src/http.mjs";
import { install } from "../src/install.mjs";
import { createMcpServer } from "../src/protocol.mjs";
import { createRuntime } from "../src/runtime.mjs";
import { entryPoint, registerClaudeDesktop, runSetup, showToken } from "../src/setup.mjs";
import { serveStdio } from "../src/stdio.mjs";

const [command = "stdio", ...rest] = process.argv.slice(2);
const log = (text) => process.stderr.write(`${text}\n`);
const allowArgs = () => rest.flatMap((arg, i) => (rest[i - 1] === "--allow" ? [arg] : []));

const USAGE = `opencode-mcp <command>
  stdio                       serve MCP over stdin/stdout (default; for Claude Desktop and most clients)
  http                        serve MCP over http://127.0.0.1:<port>/mcp with a bearer token
  install [--allow <dir>]... [--client claude-code,claude-desktop,cursor]
                              one step: settings + authorize folders (default: current folder) + register with the
                              clients it finds
  setup [--allow <dir>]...    create or update the settings file and authorize directories
  token                       print the HTTP bearer token
  register claude-desktop     add this server to Claude Desktop's config (a backup is kept)
  path                        print the server entry point`;

async function main() {
  const config = loadConfig();
  switch (command) {
    case "stdio": {
      const runtime = createRuntime(config);
      const server = createMcpServer({ runtime, config });
      await serveStdio(server);
      server.stop();
      return runtime.stop();
    }
    case "http": {
      const runtime = createRuntime(config);
      const http = await serveHttp(createMcpServer({ runtime, config }), config);
      log(`opencode-mcp listening on http://127.0.0.1:${http.address().port}/mcp`);
      return new Promise(() => {});
    }
    case "setup": {
      const result = runSetup({ allow: allowArgs() });
      log(`settings: ${result.path}\nauthorized directories: ${result.allowedDirs.join(", ") || "(none yet)"}\nopencode: ${result.bin ?? "(not found)"}`);
      return;
    }
    case "install": {
      const flag = (name) => rest.flatMap((arg, i) => (rest[i - 1] === name ? [arg] : []));
      const allow = flag("--allow");
      const report = install({ allow: allow.length ? allow : [process.cwd()], clients: flag("--client").flatMap((c) => c.split(",")) });
      log(`settings: ${report.setup.path}\nauthorized directories: ${report.setup.allowedDirs.join(", ")}\nopencode: ${report.setup.bin ?? "(not found: install OpenCode first)"}`);
      for (const r of report.results) log(`${r.ok ? "OK  " : "skip"} ${r.client}: ${r.detail}${r.restart ? `\n     ${r.restart}` : ""}`);
      if (!report.results.some((r) => r.ok)) log(`No client was configured. Add this to your MCP client's config:\n${JSON.stringify(report.snippet, null, 2)}`);
      return;
    }
    case "token":
      return process.stdout.write(`${showToken() ?? ""}\n`);
    case "register": {
      if (rest[0] !== "claude-desktop") throw new Error("usage: register claude-desktop");
      const done = registerClaudeDesktop();
      log(`registered in ${done.path}${done.backup ? ` (backup: ${done.backup})` : ""}. Restart Claude Desktop.`);
      return;
    }
    case "path":
      return process.stdout.write(`${entryPoint}\n`);
    default:
      log(USAGE);
      process.exitCode = command === "help" || command === "--help" ? 0 : 1;
  }
}

main().catch((error) => {
  log(`opencode-mcp: ${error.message}`);
  process.exit(1);
});
