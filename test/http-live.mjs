// Manual check of the HTTP transport against real OpenCode: node test/http-live.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../bin/opencode-mcp.mjs", import.meta.url));
const project = mkdtempSync(join(tmpdir(), "ocmcp-http-"));
const token = "x".repeat(40);
const port = 47611;
const server = spawn(process.execPath, [entry, "http"], { env: { ...process.env, OPENCODE_MCP_ALLOWED_DIRS: project, OPENCODE_MCP_TOKEN: token, OPENCODE_MCP_HTTP_PORT: String(port), OPENCODE_MCP_CONFIG: join(project, "none.json") }, stdio: ["ignore", "ignore", "inherit"] });
const url = `http://127.0.0.1:${port}/mcp`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let id = 1;
const rpc = (method, params) => fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) }).then((r) => r.json());

try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const status = await rpc("tools/call", { name: "opencode_status", arguments: {} });
  console.log("status:", status.result.isError ? "ERROR" : "ok", JSON.parse(status.result.content[0].text).opencodeVersion);
  const made = await rpc("tools/call", { name: "opencode_create_session", arguments: { directory: project, model: "opencode-go/deepseek-v4.1-flash", prompt: "Reply with just: HTTP-OK", wait_seconds: 120 } });
  const out = JSON.parse(made.result.content[0].text);
  console.log("answer:", out.answer, "| outcome:", out.status);
  await rpc("tools/call", { name: "opencode_delete_session", arguments: { session_id: out.created.id, confirm: true } });
  console.log("unauthorized without token:", (await fetch(url, { method: "POST", body: "{}" })).status);
} finally {
  server.kill();
  rmSync(project, { recursive: true, force: true });
}
