import { brief, modelText, parseModel, summarizeSession } from "./format.mjs";
import { followTurn } from "./turn.mjs";

const str = (description) => ({ type: "string", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const SESSION = str("OpenCode session id, starts with ses");
const WAIT = { type: "number", description: "Seconds to wait for the answer (0 returns at once and leaves the turn running). Default 120." };

/** Loads a session and refuses it unless it lives inside an authorized directory. Every session tool starts here. */
export async function authorize({ client, policy }, sessionId) {
  const info = (await client.getSession(sessionId)).data;
  policy.assert(info.location?.directory);
  return info;
}

/** Sends one instruction and, unless told not to, waits for the turn to end. */
async function send(ctx, info, { text, model, delivery, waitSeconds }) {
  if (model) await ctx.client.switchModel(info.id, parseModel(model));
  const sent = (await ctx.client.prompt(info.id, { text, ...(delivery ? { delivery } : {}) })).data;
  const since = sent.time.created;
  const seconds = Math.min(waitSeconds ?? 120, ctx.config.maxWaitSeconds);
  if (seconds <= 0) return { sessionId: info.id, status: "running", note: "Started. Call opencode_result to collect the answer." };
  const turn = await followTurn(ctx.client, info.id, since, { timeoutMs: seconds * 1000 });
  const now = summarizeSession((await ctx.client.getSession(info.id)).data);
  if (!turn.finished) return { sessionId: info.id, status: "running", partialAnswer: turn.answer, tools: turn.tools, note: "Still working. Call opencode_result later." };
  return { sessionId: info.id, status: turn.outcome, error: turn.error, answer: turn.answer, tools: turn.tools, model: now.model, cost: now.cost };
}

export function sessionTools(ctx) {
  const { client, policy } = ctx;
  return [
    {
      name: "opencode_list_sessions",
      description: "List OpenCode sessions, newest first, limited to authorized project directories. Pass a directory to see one project only.",
      inputSchema: obj({ directory: str("Absolute project directory"), search: str("Text to find in session titles"), limit: { type: "number", description: "Default 20, at most 100" } }),
      readOnly: true,
      async handler({ directory, search, limit = 20 }) {
        if (directory) policy.assert(directory);
        const want = Math.min(limit, 100);
        const page = await client.listSessions({ directory, search, limit: String(Math.min(want * 3, 200)), order: "desc", parentID: "null" });
        const sessions = (page.data ?? []).filter((s) => policy.allowed(s.location?.directory)).slice(0, want).map(summarizeSession);
        return { count: sessions.length, sessions };
      },
    },
    {
      name: "opencode_create_session",
      description: "Create a session in an authorized project directory. It runs in the background and can be resumed later, also from the OpenCode terminal with `opencode -s <id>`. Optionally pick a model and send a first instruction.",
      inputSchema: obj({ directory: str("Absolute project directory"), title: str("Session title"), model: str("provider/model or provider/model#variant, see opencode_list_models"), agent: str("Agent id, see opencode_list_agents"), prompt: str("First instruction to send"), wait_seconds: WAIT }, ["directory"]),
      async handler({ directory, title, model, agent, prompt, wait_seconds }) {
        policy.assert(directory);
        const body = { location: { directory }, ...(title ? { title } : {}), ...(model ? { model: parseModel(model) } : {}), ...(agent ? { agent } : {}) };
        const info = (await client.createSession(body)).data;
        const created = summarizeSession(info);
        if (!prompt) return { created };
        return { created, ...(await send(ctx, info, { text: prompt, waitSeconds: wait_seconds })) };
      },
    },
    {
      name: "opencode_send",
      description: "Send an instruction to an existing session (history is kept), optionally switching its model first, and wait for the answer. If the session is busy the instruction is added to its inbox.",
      inputSchema: obj({ session_id: SESSION, text: str("The instruction"), model: str("Switch to this model before sending"), delivery: { type: "string", enum: ["steer", "queue"], description: "steer = inject into the running turn, queue = run after it" }, wait_seconds: WAIT }, ["session_id", "text"]),
      async handler({ session_id, text, model, delivery, wait_seconds }) {
        return send(ctx, await authorize(ctx, session_id), { text, model, delivery, waitSeconds: wait_seconds });
      },
    },
    {
      name: "opencode_result",
      description: "Wait for a running session to finish its current turn and return the latest answer, tools used and outcome.",
      inputSchema: obj({ session_id: SESSION, wait_seconds: WAIT }, ["session_id"]),
      readOnly: true,
      async handler({ session_id, wait_seconds = 120 }) {
        const info = await authorize(ctx, session_id);
        const latest = (await client.messages(info.id, { limit: 100, order: "desc" })).data ?? [];
        const lastUser = latest.find((m) => m.type === "user");
        const since = lastUser?.time.created ?? 0;
        const turn = await followTurn(client, info.id, since, { timeoutMs: Math.min(wait_seconds, ctx.config.maxWaitSeconds) * 1000 });
        return { sessionId: info.id, status: turn.finished ? turn.outcome : "running", error: turn.error, answer: turn.answer, tools: turn.tools, session: summarizeSession(info) };
      },
    },
    {
      name: "opencode_history",
      description: "Read a session's conversation, newest first by default. Long texts are cut; use a small limit.",
      inputSchema: obj({ session_id: SESSION, limit: { type: "number", description: "Default 10, at most 50" }, order: { type: "string", enum: ["asc", "desc"] }, type: { type: "string", enum: ["user", "assistant", "idle", "shell", "system", "compaction"] } }, ["session_id"]),
      readOnly: true,
      async handler({ session_id, limit = 10, order = "desc", type }) {
        const info = await authorize(ctx, session_id);
        const page = await client.messages(info.id, { limit: String(Math.min(limit, 50)), order, type });
        return { session: summarizeSession(info), messages: (page.data ?? []).map((m) => brief(m)) };
      },
    },
    {
      name: "opencode_get_session",
      description: "Show one session: model, agent, directory, cost, tokens, last outcome, and whether it is running right now.",
      inputSchema: obj({ session_id: SESSION }, ["session_id"]),
      readOnly: true,
      async handler({ session_id }) {
        const info = await authorize(ctx, session_id);
        const active = (await client.activeSessions()).data ?? {};
        return { ...summarizeSession(info), running: Boolean(active[info.id]), model: modelText(info.model) };
      },
    },
  ];
}
