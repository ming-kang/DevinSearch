# devin-search-mcp

[Devin](https://devin.ai)'s code search as an MCP server: `code_search` finds where behavior lives in
the local workspace, and `web_search` answers from the live web. Both are the tools Pi's `/search`
extension exposes, extracted to run standalone under any MCP client.

```jsonc
// Claude Code / Claude Desktop / VS Code / any MCP client
{
  "mcpServers": {
    "devin-search": {
      "command": "npx",
      "args": ["-y", "devin-search-mcp"]
    }
  }
}
```

## Tools

### `code_search`

Find where behavior lives in the local repository by describing it, powered by Devin's SWE-grep
planner. Use it when the relevant files are unknown: exploration, tracing a flow or bug, planning a
change in unfamiliar code. Returns candidate files with line ranges — a reading list to verify with
`read` or `grep`. For known paths, exact symbols, or literal strings, use grep/find/read directly.

- `query` (string, required) — natural-language description of the behavior, flow, error, or
  concept to locate. Keep identifiers, API names, and error text verbatim.
- `path` (string, optional) — subdirectory to search, relative to the workspace root. Defaults to
  the whole root. The planner sees it as `/codebase`; results stay root-relative.

The search is **read-only and confined to the workspace root**: the planner can only name `rg`,
`readfile`, and `tree` commands against a virtual `/codebase`, and every path it names must resolve
inside the root both lexically and after following symlinks. There is no shell and no write.

### `web_search`

Search the live web through Devin. Use it for facts outside the repository: library and API docs,
error messages, release notes, current versions. Returns titles, URLs, and query-relevant excerpts.

- `query` (string, required)
- `max_results` (integer 1–10, optional, default 5)

Both tools read-only (`readOnlyHint`), and `code_search` streams progress notifications
(`Planning (round 1/3)…`, `Running 3 commands (round 2/3)…`, …) when the client asks for them.

## Credential

There is exactly one credential source: the `SEARCH_KEY` environment variable, set by the MCP
client in its server config. The server writes nothing to disk and reads nothing from any other
tool's config directories — it is standalone. The variable is read on every call.

```bash
npx devin-search-mcp login   # browser sign-in; prints the SEARCH_KEY to paste into your client
```

`login` opens Devin's sign-in page, you paste the one-time code back (or paste a raw token), the
code is exchanged for the session token, one cheap authenticated call checks it, and the finished
key is printed for you to paste:

```jsonc
{
  "mcpServers": {
    "devin-search": {
      "command": "npx",
      "args": ["-y", "devin-search-mcp"],
      "env": { "SEARCH_KEY": "devin-session-token$eyJ…" }
    }
  }
}
```

A bare Devin session JWT (`eyJ…`) is accepted and gains the `devin-session-token$` prefix it needs
at request time; an already prefixed key passes through unchanged. Restart the MCP session after
editing the client config.

## Environment variables

| Variable      | Default | Meaning                                                        |
| ------------- | ------- | -------------------------------------------------------------- |
| `SEARCH_KEY`  | —       | Devin API key / session token. The only credential source.     |
| `SEARCH_ROOT` | —       | Workspace root when the client offers no MCP roots.            |
| `SEARCH_RG_PATH` | —    | ripgrep binary override for `code_search`.                     |
| `SEARCH_ROOT`    | —                           | Workspace root when the client offers no MCP roots.           |
| `SEARCH_RG_PATH` | —                           | ripgrep binary override for `code_search`.                    |

The workspace root normally comes from the client's MCP roots (VS Code, Claude Code, …), falling
back to `SEARCH_ROOT`, then to the server process's cwd. Every search is confined to that root.

## How it works

`code_search` is a small agent loop: up to 3 planning rounds in which Devin's SWE-grep model
receives a repo map and answers with one `restricted_exec` tool call (up to 8 `rg`/`readfile`/
`tree` commands executed locally by this process) or a final `answer` naming files and line ranges.
The model-facing result is the same text Pi's extension produces, so agents that already know the
Pi tools behave identically.

```
stdio MCP client ──tools/call──▶ server.ts ──▶ tools.ts ──▶ code-search.ts (loop)
                                                  │                ├─ devin.ts  (SWE-grep planner, Connect+protobuf)
                                                  │                └─ workspace.ts (rg / readfile / tree, confined)
                                                  └─▶ devin.ts    (GetWebSearchResults)
```

The Devin (Windsurf) wire protocol is undocumented; the field numbers, the client identity
constants, and the JSON-repair heuristics in `code-search.ts` are the minimum the backend accepts
and were verified against it. If searches start failing with `invalid_argument`, those constants in
`src/devin.ts` are the first place to look.

Ripgrep comes from the `@vscode/ripgrep` optional dependency, with `rg` from `PATH` as fallback;
`SEARCH_RG_PATH` overrides both.

## Development

```bash
npm install
npm run build     # tsc → dist/
npm test          # vitest (planner loop, confinement, rg backend, MCP session)
```

The test suite runs fully offline: Devin's replies are scripted and injected as `fetch` stubs, and
the MCP layer is exercised over the SDK's in-memory transport.

## Provenance

Ported from the Devin Search extension of [`@astralyn/pi`](https://www.npmjs.com/package/@astralyn/pi)
(`src/extensions/search/`): the protocol client, planner prompt, agent loop, and workspace
confinement are carried over as-is. The Pi-specific parts (tool registration, TUI panels, Pi's
grep tool and tool downloader, Pi's credential storage) were replaced by the MCP server, the
`@vscode/ripgrep` backend, and the `SEARCH_KEY` environment variable — no file storage of any kind,
and no dependency on Pi at build or run time.
