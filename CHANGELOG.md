# Changelog

## [Unreleased]

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
