import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProgressNotification, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ENV_KEY, ENV_ROOT } from "./config.ts";
import { getApiKey } from "./credential.ts";
import {
	CODE_SEARCH_DESCRIPTION,
	type CodeSearchArgs,
	runCodeSearch,
	runWebSearch,
	WEB_SEARCH_DESCRIPTION,
	type WebSearchArgs,
} from "./tools.ts";
import { SERVER_VERSION } from "./version.ts";

const SERVER_NAME = "devin-search-mcp";

function progressReporter(
	progressToken: unknown,
	sendNotification: (notification: ServerNotification) => Promise<void>,
) {
	if (typeof progressToken !== "string" && typeof progressToken !== "number") return undefined;
	let seen = 0;
	return async (message: string) => {
		try {
			const notification: ProgressNotification = {
				method: "notifications/progress",
				params: { progressToken, progress: ++seen, message },
			};
			await sendNotification(notification);
		} catch {}
	};
}

async function resolveRoot(server: McpServer): Promise<string> {
	if (server.server.getClientCapabilities()?.roots) {
		try {
			const { roots } = await server.server.listRoots();
			for (const root of roots) {
				if (root.uri.startsWith("file://")) return fileURLToPath(root.uri);
			}
		} catch {}
	}
	return process.env[ENV_ROOT]?.trim() || process.cwd();
}

export function createServer(): McpServer {
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	let rootPromise: Promise<string> | undefined;

	server.registerTool(
		"code_search",
		{
			title: "Code Search",
			description: CODE_SEARCH_DESCRIPTION,
			inputSchema: {
				query: z
					.string()
					.describe(
						"Natural-language description of the behavior, flow, error, or concept to locate, in concise English. Keep identifiers, API names, and error text verbatim. Not for a bare symbol, filename, or literal.",
					),
				path: z
					.string()
					.optional()
					.describe("Subdirectory to search, relative to the workspace root. Defaults to the whole root."),
			},
			outputSchema: {
				locations: z.array(
					z.object({
						path: z.string(),
						ranges: z.array(z.tuple([z.number(), z.number()])),
					}),
				),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args: CodeSearchArgs, extra) => {
			const root = (rootPromise ??= resolveRoot(server));
			const { text, locations } = await runCodeSearch(args, {
				root: await root,
				signal: extra.signal,
				onProgress: progressReporter(extra._meta?.["progressToken"], extra.sendNotification),
			});
			return { content: [{ type: "text", text }], structuredContent: { locations } };
		},
	);

	server.registerTool(
		"web_search",
		{
			title: "Web Search",
			description: WEB_SEARCH_DESCRIPTION,
			inputSchema: {
				query: z
					.string()
					.describe("Web search query. Be specific: product names, versions, exact error text. English matches best."),
				max_results: z
					.number()
					.int()
					.min(1)
					.max(10)
					.optional()
					.describe("Results to return (default 5)."),
			},
			outputSchema: {
				results: z.array(
					z.object({
						url: z.string(),
						title: z.string().optional(),
						summary: z.string().optional(),
					}),
				),
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args: WebSearchArgs, extra) => {
			const { text, results } = await runWebSearch(args, { signal: extra.signal });
			return { content: [{ type: "text", text }], structuredContent: { results } };
		},
	);

	return server;
}

// stdout carries the JSON-RPC protocol only; anything logged goes to stderr.
export async function serveStdio(): Promise<McpServer> {
	const server = createServer();
	await server.connect(new StdioServerTransport());
	console.error(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio (credential: ${ENV_KEY} or \`login\`)`);
	if (!getApiKey()) {
		console.error(
			"No SEARCH_KEY yet. Run `devin-search-mcp login` to mint a key and paste it into the MCP client's env.",
		);
	}
	return server;
}
