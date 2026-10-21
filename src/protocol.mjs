import { createClient } from "./client.mjs";
import { makePolicy } from "./policy.mjs";
import { manageTools } from "./tools-manage.mjs";
import { sessionTools } from "./tools-session.mjs";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Controls OpenCode coding sessions. Start with opencode_status, then opencode_list_sessions or opencode_create_session. " +
  "Sessions keep their history: use opencode_send to continue one. Only directories the owner authorized can be used.";

const textResult = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Builds the MCP request handler for one runtime and config. Transport-independent: it maps a JSON-RPC message to a reply. */
export function createMcpServer({ runtime, config }) {
  const client = createClient({ getServer: runtime.getServer });
  const policy = makePolicy(config.allowedDirs);
  const ctx = { client, policy, config };
  const status = {
    name: "opencode_status",
    description: "Check that OpenCode is reachable and show which project directories this server may use.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    async handler() {
      const info = await client.info();
      return { opencodeVersion: info.version, server: runtime.isPrivate ? "private (started by this MCP server, loopback only)" : "external", authorizedDirectories: policy.roots };
    },
  };
  const tools = [status, ...sessionTools(ctx), ...manageTools(ctx)];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const listing = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: Boolean(t.readOnly), destructiveHint: Boolean(t.destructive), openWorldHint: false } }));

  async function callTool(params) {
    const tool = byName.get(params?.name);
    if (!tool) return textResult(`Unknown tool: ${params?.name}`, true);
    try {
      return textResult(await tool.handler(params.arguments ?? {}));
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  }

  /** Returns the reply for a request, or null for a notification. */
  async function handle(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(message?.id, -32600, "Invalid request");
    const { id, method, params } = message;
    if (id === undefined || id === null) return null;
    switch (method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "opencode-mcp", version: "0.1.0" }, instructions: INSTRUCTIONS } };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: listing } };
      case "tools/call":
        return { jsonrpc: "2.0", id, result: await callTool(params) };
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  /** Accepts one message or a batch. */
  async function handleAny(payload) {
    if (!Array.isArray(payload)) return handle(payload);
    const replies = (await Promise.all(payload.map(handle))).filter(Boolean);
    return replies.length ? replies : null;
  }

  return { handle: handleAny, tools: listing };
}
