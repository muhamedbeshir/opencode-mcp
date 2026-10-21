# opencode-mcp

An MCP server that lets any MCP-capable assistant (Claude Desktop, Claude Code, ChatGPT, Cursor, and others) drive
**OpenCode** sessions inside project directories you authorize. It has no npm dependencies (Node 20+), and it talks to
OpenCode only through its own HTTP API (`opencode serve`).

```
assistant  --MCP (stdio or HTTP)-->  opencode-mcp  --HTTP, loopback, password-->  opencode serve  -->  models
```

## What it does

| Need | Tool |
| --- | --- |
| Check the setup | `opencode_status` |
| List / read sessions | `opencode_list_sessions`, `opencode_get_session`, `opencode_history` |
| Create a session (background, no TUI), optionally with a model, agent and first instruction | `opencode_create_session` |
| Continue the same session (history is kept) and wait for the answer | `opencode_send` |
| Start a long instruction and collect it later | `opencode_create_session` / `opencode_send` with a short `wait_seconds`, then `opencode_result` |
| Providers, models (with variants), agents | `opencode_list_providers`, `opencode_list_models`, `opencode_list_agents` |
| Choose the model for a new session / change it in an existing one | `model` on create/send, `opencode_switch_model` |
| Switch agent (build, plan, ...) | `opencode_switch_agent` |
| Stop a running turn | `opencode_interrupt` |
| Rename, fork, delete | `opencode_rename_session`, `opencode_fork_session`, `opencode_delete_session` (needs `confirm: true`) |
| See file changes | `opencode_changes` |
| Answer permission requests | `opencode_permissions` |

Sessions are stored by OpenCode itself. A session created here shows up in `opencode session list` and can be resumed
in the terminal with `opencode -s <id>` (verified), and the other way around.

## Install

```powershell
cd D:\opencode-mcp
node bin/opencode-mcp.mjs setup --allow D:\ElZnager-Flow --allow D:\Projects
```

`setup` writes `%APPDATA%\opencode-mcp\config.json` (keeps existing values, only adds), finds `opencode.exe`, and
creates an HTTP bearer token once. Run it again to authorize more directories. Without at least one authorized directory
every project tool refuses to work.

Settings can also come from environment variables, which win over the file:
`OPENCODE_MCP_ALLOWED_DIRS` (`;` on Windows), `OPENCODE_MCP_BIN`, `OPENCODE_MCP_SERVER_URL` +
`OPENCODE_MCP_SERVER_PASSWORD` (use an OpenCode server you already run instead of a private one),
`OPENCODE_MCP_HTTP_PORT`, `OPENCODE_MCP_TOKEN`, `OPENCODE_MCP_ALLOWED_HOSTS`, `OPENCODE_MCP_ALLOWED_ORIGINS`,
`OPENCODE_MCP_CONFIG`.

## Connect a client

### Claude Desktop (stdio)

```powershell
node bin/opencode-mcp.mjs register claude-desktop
```

This adds an `opencode` entry to `%APPDATA%\Claude\claude_desktop_config.json`, keeps everything else, and saves a
`.bak` copy first. Or add it by hand and restart Claude Desktop:

```json
{ "mcpServers": { "opencode": { "command": "node", "args": ["D:\\opencode-mcp\\bin\\opencode-mcp.mjs"] } } }
```

### Claude Code (stdio)

```powershell
claude mcp add opencode -- node D:\opencode-mcp\bin\opencode-mcp.mjs
```

### Cursor, Windsurf, Cline, and other stdio clients

Use the same command and args as above in the client's MCP settings.

### ChatGPT and other remote clients (HTTP)

These need a URL, so run the HTTP transport and put an HTTPS tunnel in front of it.

```powershell
node bin/opencode-mcp.mjs http       # http://127.0.0.1:47600/mcp
node bin/opencode-mcp.mjs token      # the bearer token to give the client
```

Expose it with a tunnel you trust (for example `cloudflared tunnel --url http://127.0.0.1:47600`), then allow that host:
`OPENCODE_MCP_ALLOWED_HOSTS=your-name.trycloudflare.com`. In ChatGPT, add a custom MCP connector with the tunnel URL
plus `/mcp` and the bearer token. The connector UI depends on the plan; this part could not be tested from here.

Any other client: POST JSON-RPC 2.0 to `/mcp` with `Authorization: Bearer <token>`. Replies are plain JSON (no SSE).

## Security model

- Only directories from `allowedDirs` (and their children) can be used. The check is applied to the directory of
  every session a tool touches, so a session id from another project is refused. Paths are resolved first
  (`..`, symlinks, short names, case).
- By default the server starts its **own** `opencode serve` on `127.0.0.1` with a random port and an in-memory
  password, and stops it on exit. Nothing is written to disk or logged.
- The HTTP transport listens on loopback only, requires a bearer token (24+ characters, constant-time compare), checks
  `Host` and `Origin` (DNS rebinding), caps bodies at 1 MB, and refuses to start without a token. `/health` is
  unauthenticated and returns nothing sensitive.
- Existing configs are never overwritten: `setup` merges, `register` backs up first.
- Deleting needs `confirm: true`. Permission requests from OpenCode stay paused until a client answers them.

An authorized directory means the assistant can make OpenCode read and edit files there and run commands, within
OpenCode's own permission rules. Authorize only projects you are happy to hand over.

## Limitations

- A session that is running inside **another** OpenCode process (an open TUI, or your background service) belongs to
  that process. Do not send to it from here at the same time; wait until it is idle, then continue it here. The server
  works with the sessions' stored history and starts its own private OpenCode, so it does not see a turn in progress
  elsewhere.
- Progress is polled (0.3 s, then 0.75 s, then 2 s), not streamed. Long work: use a short `wait_seconds` and call
  `opencode_result` again. `wait_seconds` is capped at 900 by default (`maxWaitSeconds`).
- Changing the model mid-session uses OpenCode's `switchModel`; models and variants come from `opencode_list_models`.
- Models that OpenCode itself rejects (for example free-tier models needing a newer OpenCode) fail with the OpenCode
  error text in the result.
- Tested with a raw MCP client over stdio and HTTP and the real OpenCode `0.0.0-arabic-202610150110`. Claude Desktop,
  ChatGPT and the others speak the same standard protocol (2025-06-18, 2025-03-26, 2024-11-05) but were not driven
  from here.
- Tunnels for ChatGPT are your choice and your responsibility.

## Tests

```powershell
npm test            # unit: policy, models, protocol, HTTP security, authorization (no OpenCode needed)
npm run test:live   # real OpenCode: create, follow-up with history, model switch, fork, delete, refusal, async result
```

Set `OPENCODE_MCP_TEST_MODEL` / `OPENCODE_MCP_TEST_MODEL_2` to models that work on your machine.
