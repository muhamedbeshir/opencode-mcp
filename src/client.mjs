/** A small client for OpenCode's HTTP API (`opencode serve`). Every call carries the server's basic-auth password. */
export class OpenCodeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Adds `key[sub]=value` pairs for the API's deepObject parameters, and plain pairs for the rest. */
function addQuery(url, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") for (const [sub, inner] of Object.entries(value)) url.searchParams.set(`${key}[${sub}]`, String(inner));
    else url.searchParams.set(key, String(value));
  }
}

export function createClient({ getServer }) {
  const basic = (password) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

  /** Opens a server-sent event stream and returns the raw response; the caller reads `res.body` and aborts via `signal`. */
  async function stream(path, { signal } = {}) {
    const { url: base, password } = await getServer();
    const res = await fetch(new URL(path, base), { headers: { authorization: basic(password), accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new OpenCodeError(res.status, `OpenCode answered ${res.status} for GET ${path}`);
    return res;
  }

  async function call(method, path, { query, body, signal } = {}) {
    const { url: base, password } = await getServer();
    const url = new URL(path, base);
    addQuery(url, query);
    const headers = { authorization: basic(password) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    const text = await res.text();
    if (!res.ok) throw new OpenCodeError(res.status, `OpenCode answered ${res.status} for ${method} ${path}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  const at = (directory) => (directory ? { location: { directory } } : {});
  return {
    call,
    stream,
    info: () => call("GET", "/api/info"),
    listSessions: (query) => call("GET", "/api/session", { query }),
    getSession: (id) => call("GET", `/api/session/${encodeURIComponent(id)}`),
    createSession: (body) => call("POST", "/api/session", { body }),
    updateSession: (id, body) => call("PATCH", `/api/session/${encodeURIComponent(id)}`, { body }),
    deleteSession: (id) => call("DELETE", `/api/session/${encodeURIComponent(id)}`),
    forkSession: (id, body) => call("POST", `/api/session/${encodeURIComponent(id)}/fork`, { body: body ?? {} }),
    prompt: (id, body) => call("POST", `/api/session/${encodeURIComponent(id)}/prompt`, { body }),
    messages: (id, query) => call("GET", `/api/session/${encodeURIComponent(id)}/message`, { query }),
    interrupt: (id) => call("POST", `/api/session/${encodeURIComponent(id)}/interrupt`),
    switchModel: (id, model) => call("POST", `/api/session/${encodeURIComponent(id)}/model`, { body: { model } }),
    switchAgent: (id, agent) => call("POST", `/api/session/${encodeURIComponent(id)}/agent`, { body: { agent } }),
    diff: (id) => call("GET", `/api/session/${encodeURIComponent(id)}/diff`),
    activeSessions: () => call("GET", "/api/session/active"),
    permissions: (id) => call("GET", `/api/session/${encodeURIComponent(id)}/permission`),
    replyPermission: (id, requestId, body) => call("POST", `/api/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(requestId)}/reply`, { body }),
    models: (directory) => call("GET", "/api/model", { query: at(directory) }),
    defaultModel: (directory) => call("GET", "/api/model/default", { query: at(directory) }),
    providers: (directory) => call("GET", "/api/provider", { query: at(directory) }),
    agents: (directory) => call("GET", "/api/agent", { query: at(directory) }),
  };
}
