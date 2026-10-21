import { createInterface } from "node:readline";

/** The stdio transport: one JSON-RPC message per line on stdin, replies on stdout. Logs go to stderr only. */
export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input });
  const pending = new Set();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const job = (async () => {
      let reply;
      try {
        reply = await server.handle(JSON.parse(line));
      } catch (error) {
        reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error instanceof SyntaxError ? "Parse error" : "Internal error" } };
      }
      if (reply) output.write(`${JSON.stringify(reply)}\n`);
    })().finally(() => pending.delete(job));
    pending.add(job);
  });
  return new Promise((resolve) => lines.once("close", () => Promise.allSettled([...pending]).then(resolve)));
}
