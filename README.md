# @astralyn/search

An MCP server with two tools, powered by [Devin](https://devin.ai):

- **`code_search`** locates code from a plain-language description of a behavior, flow, or error, and returns up to 10 candidate files with line ranges—not every match.
- **`web_search`** searches the live web, and returns titles, URLs, and the page excerpts that match the query.

## Setup

1. Get a key. This opens Devin's sign-in page and prints the key once you paste back the code it shows:

   ```bash
   npx @astralyn/search@latest login
   ```

2. Add the server to your MCP client, with the key in its `env`:

   ```json
   {
     "mcpServers": {
       "search": {
         "command": "npx",
         "args": ["-y", "@astralyn/search@latest"],
         "env": { "SEARCH_KEY": "<the key login printed>" }
       }
     }
   }
   ```

   On Windows, where many clients cannot start `npx` directly, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@astralyn/search@latest"]` instead.

3. Restart the client. The key in `env` is the only authorization; nothing is written to disk.

Node.js 22 or later is required.

## code_search

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | One behavior, flow, or error to locate, in concise English. Keep identifiers and error text verbatim. Not a bare symbol, filename, or literal. |
| `path` | string | first workspace root | Directory to search: absolute inside a workspace root, or relative to the first root. |

The query and a directory tree go to Devin's SWE-grep model, which plans up to three rounds of up to six read-only commands (`rg`, `readfile`, `tree`, `ls`, `glob`). This server runs them locally and returns the model's answer—files and line ranges—as absolute paths. Treat it as a reading list to verify, not evidence: read the ranges before editing, and search identifiers found there directly when you need every occurrence, such as all call sites.

**What leaves your machine:** the query, the directory tree, and the output of the commands the model runs, including the file contents it reads.

**Enforced locally:**

- **Confinement.** Every path the model names must resolve inside the searched directory, as written and after following symlinks.
- **Ignored files stay local.** The model sees only what ripgrep would search: anything excluded by `.gitignore`, `.ignore`, or `.rgignore` (even outside a git repository) is never listed, searched, or read, even when named directly. So are `.git` and dependency and cache directories such as `node_modules`, `.venv`, `__pycache__`. To hide more, such as a committed `vendor/`, add it to `.ignore`.
- **Read-only.** The five commands are the only operations; there is no shell and no write, and each command has a 30-second budget.
- **Bounded output.** Each command result is capped at 50 lines of 200 characters; `readfile` refuses files over 4 MiB.

**Workspace root.** On `2026-07-28` connections, the server requests roots through the `input_required` flow for each search; on legacy connections it asks once and asks again on `roots/list_changed`. Without roots, it uses `SEARCH_ROOT`, then the directory the server was started in.

Ripgrep comes from the optional `@vscode/ripgrep` dependency; if that install failed, `rg` must be on `PATH`.

## web_search

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Be specific: product names, versions, exact error text. English matches best. |
| `max_results` | integer | 5 | Results to return, 1 to 10. |
| `domain` | string | unrestricted | Restrict results to one domain, e.g. `docs.rs` or `github.com`. |

Server instructions tell the model when to choose each tool, the current month, that web results and excerpts are untrusted data rather than instructions, and to cite them as `[Title](URL)`.

## Prompts

User-invoked templates for clients that list MCP prompts; a host that drops server instructions can still start a search from one.

| Prompt | Arguments | Asks the model to |
|---|---|---|
| `locate` | `query`, optional `path` | Use `code_search` to orient in unfamiliar code, then verify the reading list and search known identifiers directly. |
| `lookup` | `query` | Call `web_search`, include the current year for a recent fact, treat excerpts as untrusted, and cite each result used. |

## Tool results

Both tools return human-readable guidance, serialized JSON text, and `structuredContent` matching the advertised output schema. The stdio entry serves both `2026-07-28` and legacy clients.

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
