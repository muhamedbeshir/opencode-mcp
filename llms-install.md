# Install opencode-mcp (instructions for an AI agent)

Goal: make the `opencode_*` tools available in the user's MCP client. Do the steps in order and stop at the first
failure; report the exact error to the user.

## 1. Check the requirements

```bash
node --version      # must be v20 or newer
opencode --version  # OpenCode must be installed (https://opencode.ai) and logged in to a provider
```

If `opencode` is missing, tell the user to install it and log in (`opencode auth login`). Do not continue without it.

## 2. Get the code

```bash
git clone https://github.com/muhamedbeshir/opencode-mcp
cd opencode-mcp
```

Keep the clone where it is: the client config points at `bin/opencode-mcp.mjs` in this folder.

## 3. Install and register

Authorize the project folder(s) the user wants OpenCode to work in. Ask which folder if it is not clear; never
authorize a drive root or the home folder unless the user says so.

```bash
node bin/opencode-mcp.mjs install --allow "<absolute path to the user's project>"
```

Optional: `--client claude-code,claude-desktop,cursor` to pick clients, and more `--allow <dir>` for more folders.

The command prints one line per client (`OK` or `skip`) and a restart hint. If every client says `skip`, it also prints
a JSON snippet: add that to the client's MCP settings by hand.

## 4. Restart the client

Follow the restart hint printed in step 3 (Claude Desktop must be quit completely, tray icon too). The tools only
appear after a restart.

## 5. Verify

After the restart, call the `opencode_status` tool. It should report the OpenCode version, the authorized directories,
and a `liveView` URL. Then optionally try:

```
opencode_create_session  { "prompt": "Reply with the word ready.", "wait_seconds": 60 }
```

A session created without `directory` uses the folder the client was started in, which must be authorized.

## Troubleshooting

- `skip claude-code`: the `claude` CLI is not on PATH. Run `claude mcp add --scope user opencode -- node "<path>/bin/opencode-mcp.mjs"` yourself.
- Tools refuse with a "not authorized" error: run `install --allow <dir>` again for that folder.
- Provider errors (expired key, no credits): they come from OpenCode; refresh with `opencode auth login`.
- Nothing is overwritten: client configs keep their other servers and a `.bak` copy is written first.

More detail: [README.md](README.md).
