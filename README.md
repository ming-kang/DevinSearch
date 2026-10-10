# @astralyn/search

An MCP server with two tools, powered by [Devin](https://devin.ai):

- **`code_search`** finds where behavior lives in your workspace from a description of it, and returns candidate files with line ranges.
- **`web_search`** searches the live web, and returns titles, URLs, and the page excerpts that match the query.

## Setup

1. Get a key. This opens Devin's sign-in page, and prints the key once you paste back the code Devin shows you:

   ```bash
   npx @astralyn/search login
   ```

2. Add the server to your MCP client, with the key in its `env`. On macOS and Linux:

   ```json
   {
     "mcpServers": {
       "search": {
         "command": "npx",
         "args": ["-y", "@astralyn/search"],
         "env": { "SEARCH_KEY": "<the key login printed>" }
       }
     }
   }
   ```

   On Windows, where many clients cannot start `npx` directly, run it through `cmd`:

   ```json
   {
     "mcpServers": {
       "search": {
         "command": "cmd",
         "args": ["/c", "npx", "-y", "@astralyn/search"],
         "env": { "SEARCH_KEY": "<the key login printed>" }
       }
     }
   }
   ```

3. Restart the client. The key in the server's `env` is the only authorization; nothing is written to disk.

Node.js 22 or later is required.

## code_search

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | The behavior, flow, error, or concept to locate, in concise English. Keep identifiers and error text verbatim. |
| `path` | string | first workspace root | Directory to search: absolute inside a workspace root, or relative to the first root. |

The query and a directory tree go to Devin's SWE-grep model, which plans up to three rounds of up to eight read-only commands (`rg`, `readfile`, and `tree`). This server runs them on your machine and returns the files and line ranges the model answers with, as absolute paths. Treat them as a reading list to verify, not as evidence.

**What leaves your machine:** the query, the directory tree, and the output of the commands the model runs, including the file contents it reads.

**Enforced locally, not by Devin:**

- **Confinement.** Every path the model names must resolve inside the searched directory, both as written and after following symlinks.
- **Ignored files stay local.** The model sees only what ripgrep would search. Anything excluded by `.gitignore`, `.ignore`, or `.rgignore` (even outside a git repository) is neither listed, searched, nor read, even when the model names it. So, at any depth, are `.git` and dependency and cache directories such as `node_modules`, `.venv`, and `__pycache__`. To hide more, such as a committed `vendor/`, add it to `.ignore`.
- **Read-only.** The three commands are the only operations; there is no shell and no write.
- **Bounded output.** Each command result is capped at 40 lines of 200 characters.

**Workspace root.** The server asks the client for its MCP roots, and asks again when the client reports a change. Without roots, it uses `SEARCH_ROOT`, then the directory the server was started in.

Ripgrep comes from the optional `@vscode/ripgrep` dependency; if that install failed, `rg` must be on `PATH`.

## web_search

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Be specific: product names, versions, exact error text. English matches best. |
| `max_results` | integer | 5 | Results to return, 1 to 10. |

The server's MCP instructions tell the model the current month, so it searches with the right year, and to cite the results it uses.

## Environment variables

| Variable | Description |
|---|---|
| `SEARCH_KEY` | The key `login` prints. Required by both tools. |
| `SEARCH_ROOT` | Workspace root for clients that offer no MCP roots. |

## Development

```bash
npm install
npm run check   # Biome and TypeScript
npm test        # offline: Devin's replies are scripted
npm run build
```
