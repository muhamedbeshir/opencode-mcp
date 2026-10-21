/** Plain-data helpers: model references, session summaries, and reading a finished turn out of the message list. */

/** "provider/model#variant" -> a Model.Ref. The model id may itself contain slashes, so only the first one splits. */
export function parseModel(text) {
  const [path, variant] = String(text).split("#");
  const slash = path.indexOf("/");
  if (slash < 1 || slash === path.length - 1) throw new Error(`A model looks like provider/model or provider/model#variant, got "${text}"`);
  return { providerID: path.slice(0, slash), id: path.slice(slash + 1), ...(variant ? { variant } : {}) };
}

export const modelText = (ref) => (ref ? `${ref.providerID}/${ref.id}${ref.variant && ref.variant !== "default" ? `#${ref.variant}` : ""}` : null);

export function summarizeSession(info) {
  const when = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    id: info.id,
    title: info.title ?? "",
    directory: info.location?.directory ?? null,
    model: modelText(info.model),
    agent: info.agent ?? null,
    lastOutcome: info.outcome ?? null,
    cost: info.cost ?? 0,
    tokens: info.tokens ? { input: info.tokens.input, output: info.tokens.output, reasoning: info.tokens.reasoning } : null,
    created: when(info.time?.created),
    updated: when(info.time?.updated),
  };
}

/** What happened after a given moment: the assistant's text, the tools it used, and how the turn ended. */
export function readTurn(items, sinceMs) {
  const after = items.filter((m) => (m.time?.created ?? 0) >= sinceMs);
  const idle = after.find((m) => m.type === "idle");
  const assistants = after.filter((m) => m.type === "assistant").sort((a, b) => a.time.created - b.time.created);
  const answer = assistants.flatMap((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text)).join("\n\n").trim();
  const tools = assistants.flatMap((m) => (m.content ?? []).filter((c) => c.type === "tool").map((c) => ({ name: c.name, status: c.state?.status ?? null })));
  return { finished: Boolean(idle), outcome: idle?.outcome ?? null, error: idle?.error ? { type: idle.error.type, message: idle.error.message } : null, answer, tools };
}

/** A short, bounded view of one message for history listings. */
export function brief(message, maxChars = 2000) {
  const text = message.type === "user" ? message.text : (message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const entry = { id: message.id, type: message.type, at: new Date(message.time?.created ?? 0).toISOString() };
  if (text) entry.text = text.length > maxChars ? `${text.slice(0, maxChars)}… [${text.length - maxChars} more characters]` : text;
  if (message.type === "assistant") entry.tools = (message.content ?? []).filter((c) => c.type === "tool").map((c) => c.name);
  if (message.type === "idle") {
    entry.outcome = message.outcome;
    if (message.error) entry.error = message.error.message;
  }
  return entry;
}
