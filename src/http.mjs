import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_BODY = 1_000_000;

const sameToken = (given, expected) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The Streamable HTTP transport (POST /mcp, JSON replies). It listens on loopback, demands a bearer token, and checks
 * Host and Origin so a web page cannot reach it through DNS rebinding. For a remote client put a tunnel in front and
 * list its host in `allowedHosts`; the token still applies.
 */
export function serveHttp(server, config, { port = config.httpPort } = {}) {
  if (!config.httpToken || config.httpToken.length < 24) throw new Error("A token of at least 24 characters is required for the HTTP transport. Run `opencode-mcp setup` to create one.");
  const hosts = new Set(config.allowedHosts);
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(body === null ? undefined : JSON.stringify(body));
  };
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://local");
      if (url.pathname === "/health") return send(res, 200, { ok: true });
      if (!hosts.has(req.headers.host ?? "")) return send(res, 403, { error: "host not allowed" });
      if (req.headers.origin && !config.allowedOrigins.includes(req.headers.origin)) return send(res, 403, { error: "origin not allowed" });
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      if (!sameToken(bearer, config.httpToken)) return send(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      if (url.pathname !== "/mcp") return send(res, 404, { error: "not found" });
      if (req.method !== "POST") return send(res, 405, { error: "use POST" }, { allow: "POST" });
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const reply = await server.handle(payload);
      return reply ? send(res, 200, reply) : send(res, 202, null);
    } catch {
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => {
      const bound = http.address().port;
      for (const name of ["127.0.0.1", "localhost", "[::1]"]) hosts.add(`${name}:${bound}`);
      resolve(http);
    });
  });
}
