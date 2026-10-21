import { readTurn } from "./format.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follows a session until the turn that started at `sinceMs` is over. With the event hub connected it wakes the moment
 * OpenCode reports the turn ended and only polls as a safety net; without it, it polls (fast at first, then slower).
 * Returns `{ finished: false }` at the deadline, leaving the turn running so the caller can come back with
 * `opencode_result`.
 */
export async function followTurn(client, sessionId, sinceMs, { timeoutMs, signal, hub }) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const page = await client.messages(sessionId, { limit: 100, order: "desc" });
    const turn = readTurn(page.data ?? [], sinceMs);
    if (turn.finished || Date.now() >= deadline || signal?.aborted) return turn;
    const remaining = deadline - Date.now();
    if (hub?.connected) await hub.turnEnded(sessionId, Math.min(attempt < 2 ? 400 : 3000, remaining));
    else await sleep(attempt < 6 ? 300 : attempt < 30 ? 750 : 2000);
  }
}
