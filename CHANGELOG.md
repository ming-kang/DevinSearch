# Changelog

## [Unreleased]

## [0.3.2] - 2026-11-21

- Fixed `restricted_exec`'s command schema, which described itself as "rg, readfile, or tree" while also accepting `ls` and `glob`.
- Hardened the Devin transport: protobuf fields and Connect frames are strictly validated (truncated frames, reserved flags, malformed wire data), every body read is byte-bounded (errors 64 KiB, web results 2 MiB, planner 8 MiB), gzip frames have a per-frame decompression cap, and multi-byte UTF-8 no longer corrupts across field chunks.
- `readfile` now reads at most its byte budget through an open handle — a growing file cannot exceed it — and honours cancellation mid-read; rg's stderr is capped and a failed file index retries on the next command instead of sticking.
- Argument repair no longer rewrites key-shaped text inside string values, and malformed or inverted `<range>` lines in an answer are dropped rather than forwarded.

## [0.3.1] - 2026-11-21

- Aligned `code_search` with Devin's current fast-context contract: the planner gets six command slots per round plus `ls` and `glob` sub-commands, command results cap at 50 lines, and the planner's reasoning rides in the transcript's `thinking` field.
- The planner's calls are read from the stream's structured `tool_calls` frames when present; the `[TOOL_CALLS]` text parse remains as a fallback.
- `ls` lists a directory (dotfiles hidden unless `all`, sizes in `long_format`); `glob` matches files by ripgrep's own glob semantics and directories by a small matcher. Both keep the same confinement and ignore-file rules as `rg`, `readfile`, and `tree`.
- Each local command now has a 30-second budget, `readfile` reads asynchronously and refuses files over 4 MiB, and the repo map no longer splits a line when a level-1 tree exceeds its budget.
- `web_search` accepts an optional `domain` to restrict results, and surfaces Devin's `summary` and `web_search_url` when it sends them.
- Modern (`2026-07-28`) clients get SEP-2549 cache hints on `tools/list`, `prompts/list`, and `server/discover`, and icons on the server, tools, and prompts.
- A failed legacy `roots/list` no longer pins the configured-root fallback for the rest of the session; the server asks again next call.

## [0.3.0] - 2026-11-02

- Ported Pi's tighter `code_search` copy: the tool returns up to 10 candidates rather than every match, is primarily for orienting in unfamiliar code, and its results are a reading list before direct identifier searches.
- Web search instructions, prompts, and results warn the model that page excerpts are untrusted data, not instructions to follow.
- Tool results include both human-readable guidance and serialized JSON text alongside `structuredContent`, for clients using either result representation.
- Migrated to the MCP TypeScript SDK v2 server packages and Zod 4. The stdio entry serves both `2026-07-28` and legacy clients; modern workspace roots use the multi-round-trip `input_required` flow, while legacy root change notifications remain supported.

## [0.2.0] - 2026-10-17

- The server reports a display title, the repository URL, and a one-line description: semantic code search and live web search. The description does not name the backend; that does not help a model choose a tool.
- Instructions say when to choose each tool, to read returned ranges before editing, and to cite web results. They no longer name the host's file tools or repeat the tool descriptions.
- Prompts `locate` and `lookup` are user-invoked templates that ask the model to call `code_search` and `web_search` with the right query shape. `lookup` states the current month when it is fetched.
- A web result repeats the citation line, because a host may not inject server instructions. An empty code search no longer tells the model to grep.
- `code_search` returns absolute paths directly. It no longer makes them relative to a session working directory and resolves them again.

## [0.1.1] - 2026-10-10

- Setup examples and sign-in hints name `@astralyn/search@latest`. The explicit tag keeps npm from resolving the bare package name to a local checkout when the server starts inside this repository, where npx would then look for a `search` bin that was never linked.

## [0.1.0] - 2026-10-10

First release.

- `code_search`: semantic code search through Devin's SWE-grep model, which plans read-only `rg`, `readfile`, and `tree` commands against a virtual `/codebase`; this server runs them locally and returns the files and line ranges the model answers with.
- `web_search`: live web search through Devin, returning titles, URLs, and query-relevant page excerpts.
- Read-only and confined: every path the model names must resolve inside the searched directory, as written and after following symlinks, and must be a file ripgrep would search. Ignored files, `.git`, and dependency and cache directories are never listed, searched, or read. Model-supplied values only fill `--regexp` and `--glob`; there is no shell and no write, and each command result is capped.
- Ripgrep comes from the optional `@vscode/ripgrep` dependency, falling back to `rg` on `PATH`; ignore files are honored even outside a git repository.
- The MCP server's instructions tell the model when to reach for each tool, the current month for time-sensitive queries, and to cite the web results it uses.
- `npx @astralyn/search login` opens Devin's sign-in page and prints the key to set as `SEARCH_KEY`; a raw session token is accepted in place of the code.
- Workspace roots come from the client's MCP roots and follow their changes, with `SEARCH_ROOT` as the fallback.
