# Changelog

## [0.1.0]

First release.

- `code_search`: semantic code search through Devin's SWE-grep model, run locally with ripgrep. Ignored files, `.git`, and dependency and cache directories are never listed, searched, or read.
- `web_search`: live web search through Devin.
- `npx @astralyn/search login` prints the key to set as `SEARCH_KEY` in the MCP client's config.
- Workspace roots come from the client's MCP roots and follow its changes, with `SEARCH_ROOT` as the fallback.
