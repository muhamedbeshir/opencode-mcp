import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveHttp } from "../src/http.mjs";
import { brief, parseModel, readTurn } from "../src/format.mjs";
import { makePolicy } from "../src/policy.mjs";
import { createMcpServer } from "../src/protocol.mjs";

const root = mkdtempSync(join(tmpdir(), "ocmcp-"));
const inside = join(root, "proj");
const outside = mkdtempSync(join(tmpdir(), "ocmcp-out-"));
mkdirSync(inside);

test("policy allows the root and its children only", () => {
  const policy = makePolicy([inside]);
  assert.ok(policy.allowed(inside));
  assert.ok(policy.allowed(join(inside, "src")));
  assert.ok(!policy.allowed(inside + "-other"), "a sibling with the same prefix is not inside");
  assert.ok(!policy.allowed(outside));
  assert.ok(!policy.allowed(join(inside, "..", "x")), "dot-dot is resolved before comparing");
  assert.ok(!policy.allowed("relative/path"));
  assert.throws(() => makePolicy([]).assert(inside), /No project directory/);
  assert.throws(() => policy.assert(outside), /not authorized/);
});

test("parseModel splits on the first slash and reads variants", () => {
  assert.deepEqual(parseModel("openrouter/anthropic/claude#high"), { providerID: "openrouter", id: "anthropic/claude", variant: "high" });
  assert.deepEqual(parseModel("a/b"), { providerID: "a", id: "b" });
  assert.throws(() => parseModel("nomodel"), /provider\/model/);
  assert.throws(() => parseModel("a/"), /provider\/model/);
});

test("readTurn reports the answer only for messages after the prompt", () => {
  const items = [
    { type: "idle", outcome: "succeeded", time: { created: 5 } },
    { type: "assistant", time: { created: 4 }, content: [{ type: "text", text: "old" }] },
    { type: "assistant", time: { created: 20 }, content: [{ type: "text", text: "new" }, { type: "tool", name: "read", state: { status: "completed" } }] },
    { type: "idle", outcome: "failed", error: { type: "x", message: "boom" }, time: { created: 30 } },
  ];
  const turn = readTurn(items, 10);
  assert.equal(turn.answer, "new");
  assert.equal(turn.outcome, "failed");
  assert.equal(turn.error.message, "boom");
  assert.deepEqual(turn.tools, [{ name: "read", status: "completed" }]);
  assert.equal(readTurn(items.slice(1, 3), 10).finished, false);
});

test("brief cuts long text", () => {
  const entry = brief({ id: "m", type: "user", text: "x".repeat(50), time: { created: 1 } }, 10);
  assert.match(entry.text, /40 more characters/);
});

function fakeServer(sessionDir) {
  const calls = [];
  const client = {
    "/v2/session/ses_1": { data: { id: "ses_1", location: { directory: sessionDir }, title: "t", time: {} } },
  };
  const runtime = {
    isPrivate: true,
    getServer: async () => ({ url: "http://127.0.0.1:1", password: "x" }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const body = client[path] ?? { data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { runtime, calls, restore: () => (globalThis.fetch = originalFetch) };
}

const rpc = (server, method, params) => server.handle({ jsonrpc: "2.0", id: 1, method, params });
const config = (dirs) => ({ allowedDirs: dirs, maxWaitSeconds: 5, allowedHosts: [], allowedOrigins: [], httpToken: "t".repeat(32), httpPort: 0 });

test("protocol: initialize, ping, unknown method, notification, batch", async () => {
  const fake = fakeServer(inside);
  try {
    const server = createMcpServer({ runtime: fake.runtime, config: config([inside]) });
    const init = await rpc(server, "initialize", { protocolVersion: "1999-01-01" });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual((await rpc(server, "ping")).result, {});
    assert.equal((await rpc(server, "nope")).error.code, -32601);
    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    const batch = await server.handle([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }]);
    assert.equal(batch.length, 2);
    assert.equal((await server.handle({ nope: true })).error.code, -32600);
    const tools = (await rpc(server, "tools/list")).result.tools;
    assert.equal(tools.length, 18);
    assert.ok(tools.every((t) => t.inputSchema.type === "object" && t.annotations));
    assert.equal(tools.find((t) => t.name === "opencode_delete_session").annotations.destructiveHint, true);
  } finally {
    fake.restore();
  }
});

test("tools refuse directories and sessions outside the allowlist", async () => {
  const fake = fakeServer(outside);
  try {
    const server = createMcpServer({ runtime: fake.runtime, config: config([inside]) });
    const call = (name, args) => rpc(server, "tools/call", { name, arguments: args }).then((r) => r.result);
    const create = await call("opencode_create_session", { directory: outside });
    assert.equal(create.isError, true);
    assert.match(create.content[0].text, /not authorized/);
    const send = await call("opencode_send", { session_id: "ses_1", text: "hi" });
    assert.equal(send.isError, true, "a session located outside the allowlist cannot be driven");
    const del = await call("opencode_delete_session", { session_id: "ses_1", confirm: true });
    assert.equal(del.isError, true);
    assert.ok(!fake.calls.some((p) => p.endsWith("/prompt")), "no prompt request was sent");
    assert.equal((await call("opencode_nope", {})).isError, true);
    const noConfirm = await call("opencode_delete_session", { session_id: "ses_1" });
    assert.match(noConfirm.content[0].text, /confirm/);
  } finally {
    fake.restore();
  }
});

test("http transport: token, host, origin, method and size checks", async () => {
  const real = globalThis.fetch;
  const fake = fakeServer(inside);
  const cfg = config([inside]);
  const server = createMcpServer({ runtime: fake.runtime, config: cfg });
  fake.restore();
  const http = await serveHttp(server, cfg, { port: 0 });
  const port = http.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const auth = { authorization: `Bearer ${cfg.httpToken}`, "content-type": "application/json" };
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  try {
    assert.equal((await real(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await real(url, { method: "POST", body: ping })).status, 401, "no token");
    assert.equal((await real(url, { method: "POST", body: ping, headers: { authorization: "Bearer wrong" } })).status, 401);
    const ok = await real(url, { method: "POST", body: ping, headers: auth });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).result, {});
    assert.equal((await real(url, { method: "POST", body: ping, headers: { ...auth, origin: "http://evil.example" } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const req = request({ port, host: "127.0.0.1", path: "/mcp", method: "POST", headers: { ...auth, host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end(ping);
    });
    assert.equal(hostStatus, 403, "a foreign Host header (DNS rebinding) is refused");
    assert.equal((await real(url, { headers: auth })).status, 405);
    assert.equal((await real(url, { method: "POST", body: "{", headers: auth })).status, 400);
    const note = await real(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), headers: auth });
    assert.equal(note.status, 202);
    await assert.rejects(async () => serveHttp(server, { ...cfg, httpToken: "short" }, { port: 0 }), /token/);
  } finally {
    http.close();
  }
});
