import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventHub, sseParser } from "../src/events.mjs";
import { makePolicy } from "../src/policy.mjs";
import { followTurn } from "../src/turn.mjs";
import { createViewer } from "../src/viewer.mjs";

const encode = (text) => new TextEncoder().encode(text);

test("sseParser: splits events across chunks and skips heartbeats and bad JSON", () => {
  const seen = [];
  const parse = sseParser((event) => seen.push(event));
  parse(encode(': heartbeat\n\ndata: {"type":"a"}\n\nda'));
  parse(encode('ta: {"type":"b"}\r\n\r\ndata: not json\n\n'));
  assert.deepEqual(seen.map((e) => e.type), ["a", "b"]);
});

test("hub: turnEnded wakes on the end event of that session only, and times out otherwise", async () => {
  const hub = createEventHub({ stream: () => new Promise(() => {}) });
  let emit;
  hub.subscribe = ((orig) => (fn) => ((emit = fn), orig(fn)))(hub.subscribe.bind(hub));
  const started = Date.now();
  const waiting = hub.turnEnded("ses_1", 5000);
  emit({ type: "session.execution.succeeded", data: { sessionID: "ses_other" } });
  emit({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  setTimeout(() => emit({ type: "session.execution.failed", data: { sessionID: "ses_1" } }), 30);
  await waiting;
  assert.ok(Date.now() - started < 1000, "woke on the event, not on the timeout");
  const t0 = Date.now();
  await hub.turnEnded("ses_1", 60);
  assert.ok(Date.now() - t0 >= 50);
});

test("followTurn: with a connected hub it returns as soon as the turn is finished", async () => {
  let reads = 0;
  const finished = [{ type: "user", time: { created: 10 } }, { type: "assistant", time: { created: 11 }, content: [{ type: "text", text: "ok" }] }, { type: "idle", time: { created: 12 }, outcome: "succeeded" }];
  const client = { messages: async () => ({ data: (++reads, reads < 3 ? [] : finished).slice().reverse() }) };
  const hub = { connected: true, turnEnded: async () => {} };
  const turn = await followTurn(client, "ses_1", 5, { timeoutMs: 2000, hub });
  assert.equal(turn.finished, true);
  assert.equal(reads, 3);
});

test("viewer: loopback, secret token in the path, host check, and only authorized sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocmcp-view-"));
  const inside = join(root, "proj");
  mkdirSync(inside);
  const outside = mkdtempSync(join(tmpdir(), "ocmcp-view-out-"));
  const sessions = { ses_in: { id: "ses_in", title: "<b>mine</b>", location: { directory: inside } }, ses_out: { id: "ses_out", title: "other", location: { directory: outside } } };
  const client = {
    getSession: async (id) => ({ data: sessions[id] }),
    listSessions: async () => ({ data: Object.values(sessions) }),
    messages: async () => ({ data: [] }),
    activeSessions: async () => ({ data: {} }),
  };
  const viewer = createViewer({ hub: { ensure() {}, subscribe: () => () => {} }, client, policy: makePolicy([inside]), config: { viewerPort: 0, viewer: "off" } });
  const url = new URL(await viewer.urlFor("ses_in"));
  const get = (path, host = url.host) => new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: url.port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject).end();
  });
  try {
    assert.equal(url.hostname, "127.0.0.1");
    const page = await get(url.pathname);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes("&lt;b&gt;mine"), "titles are escaped");
    assert.equal((await get(`/wrong-token/s/ses_in`)).status, 404);
    assert.equal((await get(url.pathname, "evil.example")).status, 403, "wrong Host header");
    assert.equal((await get(`/${viewer.token}/s/ses_out`)).status, 404, "a session outside the allowlist is invisible");
    const index = await get(`/${viewer.token}/`);
    assert.ok(index.body.includes("mine") && !index.body.includes("other"));
    assert.deepEqual(JSON.parse((await get(`${url.pathname}/history`)).body), { messages: [], running: false });
  } finally {
    viewer.stop();
  }
});

test("install: writes settings, registers Claude Desktop without touching other servers, reports unknown clients", async () => {
  const { install } = await import("../src/install.mjs");
  const base = mkdtempSync(join(tmpdir(), "ocmcp-install-"));
  const appdata = join(base, "Roaming");
  mkdirSync(join(appdata, "Claude"), { recursive: true });
  const configFile = join(appdata, "Claude", "claude_desktop_config.json");
  const { writeFileSync, readFileSync } = await import("node:fs");
  writeFileSync(configFile, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
  const env = { ...process.env, APPDATA: appdata, LOCALAPPDATA: join(base, "none"), OPENCODE_MCP_CONFIG: join(base, "oc", "config.json") };
  const project = join(base, "proj");
  mkdirSync(project);
  const report = install({ allow: [project], clients: ["claude-desktop", "nope"], env });
  assert.equal(report.results[0].ok, true);
  assert.equal(report.results[1].ok, false);
  const written = JSON.parse(readFileSync(configFile, "utf8"));
  assert.equal(written.theme, "dark");
  assert.ok(written.mcpServers.other && written.mcpServers.opencode.args[0].endsWith("opencode-mcp.mjs"));
  const settings = JSON.parse(readFileSync(env.OPENCODE_MCP_CONFIG, "utf8"));
  assert.equal(settings.allowedDirs.length, 1);
  assert.ok(settings.httpToken.length >= 24);
});
