// Runs against the real OpenCode installed on this machine. Uses a throwaway project directory and deletes what it creates.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../bin/opencode-mcp.mjs", import.meta.url));
const MODEL = process.env.OPENCODE_MCP_TEST_MODEL ?? "opencode-go/deepseek-v4.1-flash";
const OTHER_MODEL = process.env.OPENCODE_MCP_TEST_MODEL_2 ?? "opencode-go/minimax-m3.1-flash-free";
const project = mkdtempSync(join(tmpdir(), "ocmcp-live-"));
const outside = mkdtempSync(join(tmpdir(), "ocmcp-live-out-"));
const created = [];
let child;
let nextId = 1;
const waiting = new Map();

before(() => {
  child = spawn(process.execPath, [entry], {
    env: { ...process.env, OPENCODE_MCP_ALLOWED_DIRS: project, OPENCODE_MCP_CONFIG: join(project, "none.json") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const reply = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(reply.id)?.(reply);
    }
  });
});

after(async () => {
  for (const id of created.reverse()) await call("opencode_delete_session", { session_id: id, confirm: true }).catch(() => {});
  child.stdin.end();
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

async function call(name, args = {}) {
  const reply = await rpc("tools/call", { name, arguments: args });
  const text = reply.result.content[0].text;
  if (reply.result.isError) throw new Error(text);
  return JSON.parse(text);
}

test("initialize and status", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live", version: "1" } });
  assert.equal(init.result.serverInfo.name, "opencode-mcp");
  const status = await call("opencode_status");
  assert.match(status.opencodeVersion, /\S/);
  assert.equal(status.authorizedDirectories.length, 1);
});

test("providers, models and agents are listed", async () => {
  const providers = await call("opencode_list_providers", { directory: project });
  assert.ok(JSON.stringify(providers).length > 10);
  const models = await call("opencode_list_models", { directory: project, limit: 200 });
  assert.ok(models.models.some((m) => m.ref === MODEL), `${MODEL} should be available`);
  assert.ok(models.models.some((m) => m.ref === OTHER_MODEL), `${OTHER_MODEL} should be available`);
  const agents = await call("opencode_list_agents", { directory: project });
  assert.ok(agents.agents.length > 0);
});

test("a session keeps its history across follow-ups, in the background", async () => {
  const first = await call("opencode_create_session", { directory: project, title: "mcp-live", model: MODEL, prompt: "Remember the secret word BANANA-42. Reply with just: OK", wait_seconds: 120 });
  created.push(first.created.id);
  assert.equal(first.status, "succeeded", JSON.stringify(first));
  assert.equal(first.created.model, MODEL);
  assert.match(first.answer, /OK/i);

  const second = await call("opencode_send", { session_id: first.created.id, text: "What was the secret word? Reply with just the word.", wait_seconds: 120 });
  assert.equal(second.status, "succeeded", JSON.stringify(second));
  assert.match(second.answer, /BANANA-42/, "the follow-up can see the first turn");

  const history = await call("opencode_history", { session_id: first.created.id, limit: 50, order: "asc" });
  const users = history.messages.filter((m) => m.type === "user");
  assert.equal(users.length, 2);
  const listed = await call("opencode_list_sessions", { directory: project });
  assert.ok(listed.sessions.some((s) => s.id === first.created.id));
  const info = await call("opencode_get_session", { session_id: first.created.id });
  assert.equal(info.running, false);
});

test("the model can be switched in an existing session", async () => {
  const id = created[0];
  const switched = await call("opencode_switch_model", { session_id: id, model: OTHER_MODEL });
  assert.equal(switched.model, OTHER_MODEL);
  const turn = await call("opencode_send", { session_id: id, text: "Reply with just: SWITCHED", wait_seconds: 120 });
  assert.equal(turn.status, "succeeded", JSON.stringify(turn));
  assert.match(turn.answer, /SWITCHED/i);
  await assert.rejects(call("opencode_switch_model", { session_id: id, model: "nope/not-a-model" }), /Unknown model/);
});

test("rename, fork and delete work", async () => {
  const id = created[0];
  assert.equal((await call("opencode_rename_session", { session_id: id, title: "mcp-live-renamed" })).title, "mcp-live-renamed");
  const fork = await call("opencode_fork_session", { session_id: id });
  created.push(fork.forked.id);
  assert.notEqual(fork.forked.id, id);
  await assert.rejects(call("opencode_delete_session", { session_id: fork.forked.id }), /confirm/);
  assert.deepEqual(await call("opencode_delete_session", { session_id: fork.forked.id, confirm: true }), { deleted: fork.forked.id });
  created.pop();
});

test("a project outside the allowlist is refused", async () => {
  await assert.rejects(call("opencode_create_session", { directory: outside }), /not authorized/);
  await assert.rejects(call("opencode_list_sessions", { directory: outside }), /not authorized/);
  await assert.rejects(call("opencode_list_models", { directory: outside }), /not authorized/);
});

test("a long instruction can be started without waiting, then collected", async () => {
  const started = await call("opencode_create_session", { directory: project, title: "mcp-live-async", model: MODEL, prompt: "Reply with just: ASYNC-DONE", wait_seconds: 1 });
  created.push(started.created.id);
  const result = await call("opencode_result", { session_id: started.created.id, wait_seconds: 120 });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.match(result.answer, /ASYNC-DONE/);
});
