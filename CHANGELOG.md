# Changelog

## [0.1.0]

First release.

- `code_search`: semantic code search through Devin's SWE-grep model, which plans read-only `rg`, `readfile`, and `tree` commands against a virtual `/codebase`; this server runs them locally and returns the files and line ranges the model answers with.
- `web_search`: live web search through Devin, returning titles, URLs, and query-relevant page excerpts.
- Read-only and confined: every path the model names must resolve inside the searched directory, as written and after following symlinks, and must be a file ripgrep would search. Ignored files, `.git`, and dependency and cache directories are never listed, searched, or read. Model-supplied values only fill `--regexp` and `--glob`; there is no shell and no write, and each command result is capped.
- Ripgrep comes from the optional `@vscode/ripgrep` dependency, falling back to `rg` on `PATH`; ignore files are honored even outside a git repository.
- The MCP server's instructions tell the model when to reach for each tool, the current month for time-sensitive queries, and to cite the web results it uses.
- `npx @astralyn/search login` opens Devin's sign-in page and prints the key to set as `SEARCH_KEY`; a raw session token is accepted in place of the code.
- Workspace roots come from the client's MCP roots and follow their changes, with `SEARCH_ROOT` as the fallback.
