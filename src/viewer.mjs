import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { brief, summarizeSession } from "./format.mjs";
import { indexPage, sessionPage } from "./viewer-page.mjs";

const opened = new Set();

/** Opens a URL in the default browser. Failure is harmless: the URL is also returned to the assistant. */
function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    // No browser available.
  }
}

/**
 * A read-only live page for watching a session work. It listens on loopback only, every URL carries a random token
 * that exists only in this process, and a session is shown only if it lives in an authorized directory.
 * Watching costs the assistant nothing: the page talks to this process, not to the model.
 */
export function createViewer({ hub, client, policy, config }) {
  const token = randomBytes(24).toString("hex");
  let server = null;
  let port = 0;

  const send = (res, status, type, body) => {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
    res.end(body);
  };

  async function loadSession(id) {
    const info = (await client.getSession(id)).data;
    if (!policy.allowed(info.location?.directory)) throw new Error("not allowed");
    return info;
  }

  function stream(req, res, id) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": open\n\n");
    const off = hub.subscribe((event) => event.data?.sessionID === id && event.type.startsWith("session.") && res.write(`data: ${JSON.stringify({ type: event.type, data: event.data })}\n\n`));
    const beat = setInterval(() => res.write(": beat\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      off();
    });
  }

  async function route(req, res, url) {
    const [, key, kind, id, leaf] = url.pathname.split("/");
    if (key !== token) return send(res, 404, "text/plain", "Not found");
    const base = `/${token}`;
    if (!kind) {
      const page = await client.listSessions({ limit: "100", order: "desc", parentID: "null" });
      const sessions = (page.data ?? []).filter((s) => policy.allowed(s.location?.directory)).map(summarizeSession);
      return send(res, 200, "text/html", indexPage(base, sessions));
    }
    if (kind !== "s" || !id) return send(res, 404, "text/plain", "Not found");
    const info = await loadSession(id);
    if (!leaf) return send(res, 200, "text/html", sessionPage(`${base}/s/${id}`, summarizeSession(info)));
    if (leaf === "events") return stream(req, res, id);
    if (leaf === "history") {
      const items = ((await client.messages(id, { limit: "12", order: "desc" })).data ?? []).reverse().filter((m) => m.type === "user" || m.type === "assistant");
      const active = (await client.activeSessions()).data ?? {};
      return send(res, 200, "application/json", JSON.stringify({ messages: items.map((m) => brief(m, 6000)), running: Boolean(active[id]) }));
    }
    return send(res, 404, "text/plain", "Not found");
  }

  const hostOk = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

  async function handler(req, res) {
    if (req.method !== "GET" || !hostOk(req.headers.host)) return send(res, 403, "text/plain", "Forbidden");
    try {
      await route(req, res, new URL(req.url, "http://localhost"));
    } catch {
      if (!res.headersSent) send(res, 404, "text/plain", "Not found");
    }
  }

  async function start() {
    if (server) return;
    server = createServer((req, res) => void handler(req, res));
    const listen = (p) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      await listen(config.viewerPort);
    } catch {
      await listen(0);
    }
    port = server.address().port;
  }

  return {
    start,
    get token() {
      return token;
    },
    get port() {
      return port;
    },
    /** URL of the page listing the authorized sessions. */
    async indexUrl() {
      await start();
      return `http://127.0.0.1:${port}/${token}/`;
    },
    /** URL of the live page for a session. Starts the viewer and the event stream on first use. */
    async urlFor(sessionId) {
      await start();
      hub.ensure();
      return `http://127.0.0.1:${port}/${token}/s/${sessionId}`;
    },
    /** Opens the live page once per session, unless the owner turned that off. Always returns the URL. */
    async show(sessionId) {
      const url = await this.urlFor(sessionId);
      if (config.openViewer && !opened.has(sessionId)) {
        opened.add(sessionId);
        openBrowser(url);
      }
      return url;
    },
    stop() {
      server?.close();
      server?.closeAllConnections?.();
      server = null;
    },
  };
}
