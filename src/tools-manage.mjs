import { summarizeSession, parseModel } from "./format.mjs";
import { authorize } from "./tools-session.mjs";

const str = (description) => ({ type: "string", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const SESSION = str("OpenCode session id, starts with ses");

/** Models, providers, agents, and the housekeeping tools (stop, rename, fork, delete, permissions, changes). */
export function manageTools(ctx) {
  const { client, policy } = ctx;
  const inDir = async (directory) => {
    if (directory) policy.assert(directory);
    return directory;
  };
  return [
    {
      name: "opencode_list_providers",
      description: "List the model providers OpenCode knows and whether each is active.",
      inputSchema: obj({ directory: str("Absolute project directory (providers can differ per project)") }),
      readOnly: true,
      async handler({ directory }) {
        const list = (await client.providers(await inDir(directory))).data ?? [];
        return { providers: list.map((p) => ({ id: p.id, name: p.name, activation: p.activation })) };
      },
    },
    {
      name: "opencode_list_models",
      description: "List available models as provider/model strings with their variants (reasoning levels). Filter by text or provider. Use a returned `ref` when creating a session or switching.",
      inputSchema: obj({ directory: str("Absolute project directory"), search: str("Part of a model id or name"), provider: str("Provider id"), limit: { type: "number", description: "Default 40, at most 200" } }),
      readOnly: true,
      async handler({ directory, search, provider, limit = 40 }) {
        const all = (await client.models(await inDir(directory))).data ?? [];
        const needle = search?.toLowerCase();
        const models = all
          .filter((m) => m.enabled !== false && (!provider || m.providerID === provider) && (!needle || `${m.modelID} ${m.name}`.toLowerCase().includes(needle)))
          .slice(0, Math.min(limit, 200))
          .map((m) => ({ ref: `${m.providerID}/${m.modelID}`, name: m.name, variants: (m.variants ?? []).map((v) => v.id), context: m.limit?.context ?? null }));
        const def = (await client.defaultModel(directory)).data;
        return { default: def ? `${def.providerID}/${def.modelID}` : null, total: all.length, models };
      },
    },
    {
      name: "opencode_list_agents",
      description: "List the agents (modes such as build or plan) available in a project.",
      inputSchema: obj({ directory: str("Absolute project directory") }),
      readOnly: true,
      async handler({ directory }) {
        const list = (await client.agents(await inDir(directory))).data ?? [];
        return { agents: list.filter((a) => !a.hidden).map((a) => ({ id: a.id, mode: a.mode, description: a.description ?? "" })) };
      },
    },
    {
      name: "opencode_switch_model",
      description: "Change the model used by the session's later turns. The history stays.",
      inputSchema: obj({ session_id: SESSION, model: str("provider/model or provider/model#variant") }, ["session_id", "model"]),
      async handler({ session_id, model }) {
        const info = await authorize(ctx, session_id);
        const ref = parseModel(model);
        const known = ((await client.models(info.location.directory)).data ?? []).find((m) => m.providerID === ref.providerID && m.modelID === ref.id);
        if (!known) throw new Error(`Unknown model ${model}. Use opencode_list_models to see valid ones.`);
        if (ref.variant && !(known.variants ?? []).some((v) => v.id === ref.variant)) throw new Error(`Model ${model} has no variant "${ref.variant}"`);
        await client.switchModel(info.id, ref);
        return summarizeSession((await client.getSession(info.id)).data);
      },
    },
    {
      name: "opencode_switch_agent",
      description: "Change the agent (for example build or plan) used by the session's later turns.",
      inputSchema: obj({ session_id: SESSION, agent: str("Agent id") }, ["session_id", "agent"]),
      async handler({ session_id, agent }) {
        const info = await authorize(ctx, session_id);
        await client.switchAgent(info.id, agent);
        return summarizeSession((await client.getSession(info.id)).data);
      },
    },
    {
      name: "opencode_interrupt",
      description: "Stop the session's running turn. The session and its history remain.",
      inputSchema: obj({ session_id: SESSION }, ["session_id"]),
      async handler({ session_id }) {
        const info = await authorize(ctx, session_id);
        return { interrupted: Boolean((await client.interrupt(info.id))?.interrupted) };
      },
    },
    {
      name: "opencode_rename_session",
      description: "Change a session's title.",
      inputSchema: obj({ session_id: SESSION, title: str("New title") }, ["session_id", "title"]),
      async handler({ session_id, title }) {
        const info = await authorize(ctx, session_id);
        await client.updateSession(info.id, { title });
        return summarizeSession((await client.getSession(info.id)).data);
      },
    },
    {
      name: "opencode_fork_session",
      description: "Copy a session's conversation into a new session so a different approach can be tried without touching the original.",
      inputSchema: obj({ session_id: SESSION }, ["session_id"]),
      async handler({ session_id }) {
        const info = await authorize(ctx, session_id);
        return { forked: summarizeSession((await client.forkSession(info.id)).data) };
      },
    },
    {
      name: "opencode_delete_session",
      description: "Permanently delete a session and its child sessions. Requires confirm=true.",
      inputSchema: obj({ session_id: SESSION, confirm: { type: "boolean", description: "Must be true" } }, ["session_id", "confirm"]),
      destructive: true,
      async handler({ session_id, confirm }) {
        if (confirm !== true) throw new Error("Deleting is permanent. Call again with confirm=true.");
        const info = await authorize(ctx, session_id);
        await client.deleteSession(info.id);
        return { deleted: info.id };
      },
    },
    {
      name: "opencode_changes",
      description: "Show the file changes the session has made so far.",
      inputSchema: obj({ session_id: SESSION }, ["session_id"]),
      readOnly: true,
      async handler({ session_id }) {
        const info = await authorize(ctx, session_id);
        return (await client.diff(info.id)).data ?? [];
      },
    },
    {
      name: "opencode_permissions",
      description: "List the permission requests a session is waiting on, or answer one (decision once, always or reject). A session that needs approval stays paused until answered.",
      inputSchema: obj({ session_id: SESSION, request_id: str("Request to answer; omit to list"), decision: { type: "string", enum: ["once", "always", "reject"] }, message: str("Optional note with a rejection") }, ["session_id"]),
      async handler({ session_id, request_id, decision, message }) {
        const info = await authorize(ctx, session_id);
        if (!request_id) return { pending: (await client.permissions(info.id)).data ?? [] };
        if (!decision) throw new Error("decision is required when request_id is given");
        await client.replyPermission(info.id, request_id, { decision, ...(message ? { message } : {}) });
        return { answered: request_id, decision };
      },
    },
  ];
}
