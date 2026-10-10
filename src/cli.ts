#!/usr/bin/env node
import { COMMAND, ENV_KEY } from "./config.ts";
import { login } from "./login.ts";
import { serveStdio } from "./server.ts";
import { SERVER_VERSION } from "./version.ts";

const USAGE = `@astralyn/search ${SERVER_VERSION}: code_search and web_search over MCP, powered by Devin.

Usage:
  ${COMMAND}            Start the MCP server on stdio.
  ${COMMAND} login      Sign in to Devin and print the ${ENV_KEY} for your MCP client.
  ${COMMAND} --help     Show this help.
  ${COMMAND} --version  Show the version.

MCP client config:
{
  "mcpServers": {
    "search": {
      "command": "npx",
      "args": ["-y", "@astralyn/search@latest"],
      "env": { "${ENV_KEY}": "<the key login prints>" }
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
		case "help":
		case "--help":
		case "-h":
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
