#!/usr/bin/env node
import { ENV_KEY } from "./config.ts";
import { login } from "./login.ts";
import { serveStdio } from "./server.ts";
import { SERVER_VERSION } from "./version.ts";

const USAGE = `devin-search-mcp ${SERVER_VERSION}

Usage:
  devin-search-mcp            Start the MCP server on stdio (default).
  devin-search-mcp login      Sign in to Devin in the browser and print the SEARCH_KEY to paste
                              into your MCP client's env.
  devin-search-mcp --help     Show this help.
  devin-search-mcp --version  Show the version.

Credential: the SEARCH_KEY environment variable in the MCP client config. Nothing is stored on disk.

MCP client config:
{
  "mcpServers": {
    "devin-search": {
      "command": "npx",
      "args": ["-y", "devin-search-mcp"],
      "env": { "${ENV_KEY}": "devin-session-token$<key>" }
    }
  }
}`;

async function main(): Promise<void> {
	const [command] = process.argv.slice(2);
	switch (command) {
		case undefined:
		case "serve":
			await serveStdio();
			return;
		case "login":
			await login();
			return;
		case "--help":
		case "-h":
		case "help":
			console.log(USAGE);
			return;
		case "--version":
		case "-v":
			console.log(SERVER_VERSION);
			return;
		default:
			console.error(`Unknown command: ${command}\n\n${USAGE}`);
			process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
