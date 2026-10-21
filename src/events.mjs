/** Turns a stream of bytes into parsed server-sent events. Comments (heartbeats) and broken JSON are skipped. */
export function sseParser(onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  return (chunk) => {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        // A malformed event is not worth stopping the stream for.
      }
    }
  };
}

const ENDS_TURN = /^session\.execution\.(?!started)/;

/**
 * One shared connection to OpenCode's event stream (`/api/event`). It reconnects by itself. Nothing here costs the
 * assistant anything: events are consumed inside this process, and only the final answer is returned to the client.
 */
export function createEventHub(client) {
  const listeners = new Set();
  let controller = null;
  let connected = false;
  let stopped = false;

  const dispatch = (event) => {
    for (const listener of [...listeners]) listener(event);
  };

  async function run() {
    for (let delay = 500; !stopped; delay = Math.min(delay * 2, 10_000)) {
      controller = new AbortController();
      try {
        const res = await client.stream("/api/event", { signal: controller.signal });
        connected = true;
        delay = 250;
        const parse = sseParser(dispatch);
        for await (const chunk of res.body) parse(chunk);
      } catch {
        // Fall through to the retry below. Polling covers the gap.
      }
      connected = false;
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return {
    get connected() {
      return connected;
    },
    /** Starts the connection the first time it is needed. Safe to call again. */
    ensure() {
      if (!controller && !stopped) run().catch(() => {});
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Resolves when the session's turn ends, or after `ms`, whichever is first. */
    turnEnded(sessionId, ms) {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          off();
          resolve();
        };
        const off = this.subscribe((event) => event.data?.sessionID === sessionId && ENDS_TURN.test(event.type) && done());
        const timer = setTimeout(done, ms);
      });
    },
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
