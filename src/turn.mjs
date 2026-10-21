import { readTurn } from "./format.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follows a session until the turn that started at `sinceMs` is over, polling the message list. The first polls are
 * quick so a short answer comes back at once; later ones slow down. Returns `{ finished: false }` at the deadline,
 * leaving the turn running so the caller can come back with `opencode_result`.
 */
export async function followTurn(client, sessionId, sinceMs, { timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const page = await client.messages(sessionId, { limit: 100, order: "desc" });
    const turn = readTurn(page.data ?? [], sinceMs);
    if (turn.finished || Date.now() >= deadline || signal?.aborted) return turn;
    await sleep(attempt < 6 ? 300 : attempt < 30 ? 750 : 2000);
  }
}
