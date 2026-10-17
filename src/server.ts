import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema, type ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { COMMAND, ENV_KEY, ENV_ROOT } from "./config.ts";
import { getApiKey } from "./credential.ts";
import { instructions, registerPrompts, SERVER_INFO, SERVER_NAME } from "./guidance.ts";
import {
	CODE_SEARCH_DESCRIPTION,
	type CodeSearchArgs,
	runCodeSearch,
	runWebSearch,
	WEB_SEARCH_DESCRIPTION,
	type WebSearchArgs,
} from "./tools.ts";
import { SERVER_VERSION } from "./version.ts";

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

function progressReporter(
	progressToken: unknown,
	sendNotification: (notification: ServerNotification) => Promise<void>,
): ((message: string) => void) | undefined {
	if (typeof progressToken !== "string" && typeof progressToken !== "number") return undefined;
	let progress = 0;
	return (message) => {
		sendNotification({
			method: "notifications/progress",
			params: { progressToken, progress: ++progress, message },
		}).catch(() => {});
	};
}

export function createServer(): McpServer {
	const server = new McpServer({ ...SERVER_INFO, version: SERVER_VERSION }, { instructions: instructions() });

	// The client's file roots, asked for once and again after it reports a change; SEARCH_ROOT, then cwd, without them.
	let roots: Promise<string[]> | undefined;
	const workspaceRoots = (): Promise<string[]> => {
		roots ??= (async () => {
			if (server.server.getClientCapabilities()?.roots) {
				try {
					const listed = (await server.server.listRoots()).roots
						.filter((root) => root.uri.startsWith("file://"))
						.map((root) => fileURLToPath(root.uri));
					if (listed.length) return listed;
				} catch {}
			}
			return [process.env[ENV_ROOT]?.trim() || process.cwd()];
		})();
		return roots;
	};
	server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
		roots = undefined;
	});

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
					.describe(
						"Directory to search: absolute inside a workspace root, or relative to the first root. Defaults to the first root.",
					),
			},
			outputSchema: {
				locations: z.array(z.object({ path: z.string(), ranges: z.array(z.tuple([z.number(), z.number()])) })),
			},
			annotations: READ_ONLY,
		},
		async (args: CodeSearchArgs, extra) => {
			const { text, locations } = await runCodeSearch(args, {
				roots: await workspaceRoots(),
				signal: extra.signal,
				onProgress: progressReporter(extra._meta?.progressToken, extra.sendNotification),
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
					.describe(
						"Web search query. Be specific: product names, versions, exact error text. English matches best.",
					),
				max_results: z.number().int().min(1).max(10).optional().describe("Results to return (default 5)."),
			},
			outputSchema: {
				results: z.array(
					z.object({ url: z.string(), title: z.string().optional(), summary: z.string().optional() }),
				),
			},
			annotations: READ_ONLY,
		},
		async (args: WebSearchArgs, extra) => {
			const { text, results } = await runWebSearch(args, extra.signal);
			return { content: [{ type: "text", text }], structuredContent: { results } };
		},
	);

	registerPrompts(server);
	return server;
}

/** stdout carries JSON-RPC only; anything for a person goes to stderr. */
export async function serveStdio(): Promise<McpServer> {
	const server = createServer();
	await server.connect(new StdioServerTransport());
	if (!getApiKey()) {
		console.error(
			`${SERVER_NAME}: no ${ENV_KEY} set. Run \`${COMMAND} login\` and add the key to this server's env.`,
		);
	}
	return server;
}
