import { fileURLToPath } from "node:url";
import {
	CLIENT_CAPABILITIES_META_KEY,
	type ClientCapabilities,
	type InputRequiredResult,
	inputRequired,
	inputResponse,
	McpServer,
	type ServerContext,
	type ServerNotification,
} from "@modelcontextprotocol/server";
import { serveStdio as serve } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { COMMAND, ENV_KEY, ENV_ROOT } from "./config.ts";
import { getApiKey } from "./credential.ts";
import { instructions, registerPrompts, SERVER_ICONS, SERVER_INFO, SERVER_NAME } from "./guidance.ts";
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

/** Human guidance first, then serialized JSON for clients that only consume text. */
function searchResult<T extends Record<string, unknown>>(text: string, structuredContent: T) {
	return {
		content: [
			{ type: "text" as const, text },
			{ type: "text" as const, text: JSON.stringify(structuredContent) },
		],
		structuredContent,
	};
}

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
	const server = new McpServer(
		{ ...SERVER_INFO, version: SERVER_VERSION },
		{
			instructions: instructions(),
			// Catalogs and discovery are identical for every client and change only with the build.
			cacheHints: {
				"tools/list": { ttlMs: 86_400_000, cacheScope: "public" },
				"prompts/list": { ttlMs: 86_400_000, cacheScope: "public" },
				"server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
			},
		},
	);

	const configuredRoots = () => [process.env[ENV_ROOT]?.trim() || process.cwd()];
	const fileRoots = (roots: Array<{ uri: string }>): string[] =>
		roots.flatMap((root) => {
			const uri = root?.uri;
			if (typeof uri !== "string" || !uri.startsWith("file://")) return [];
			try {
				return [fileURLToPath(uri)];
			} catch {
				return [];
			}
		});

	// Legacy roots are cached until the client reports a change. Modern roots arrive per call through MRTR.
	let legacyRoots: Promise<string[]> | undefined;
	const legacyWorkspaceRoots = (): Promise<string[]> => {
		legacyRoots ??= (async () => {
			if (server.server.getClientCapabilities()?.roots) {
				try {
					const listed = fileRoots((await server.server.listRoots()).roots);
					if (listed.length) return listed;
				} catch {
					// A transient failure must not pin the fallback for the rest of the session.
					legacyRoots = undefined;
				}
			}
			return configuredRoots();
		})();
		return legacyRoots;
	};
	server.server.setNotificationHandler("notifications/roots/list_changed", async () => {
		legacyRoots = undefined;
	});

	const workspaceRoots = async (extra: ServerContext): Promise<string[] | InputRequiredResult> => {
		const envelope = extra.mcpReq.envelope as
			| Partial<Record<typeof CLIENT_CAPABILITIES_META_KEY, ClientCapabilities>>
			| undefined;
		if (!envelope) return legacyWorkspaceRoots();
		if (!envelope[CLIENT_CAPABILITIES_META_KEY]?.roots) return configuredRoots();

		const response = inputResponse(extra.mcpReq.inputResponses, "workspace");
		if (response.kind === "roots") {
			const listed = fileRoots(response.roots);
			return listed.length ? listed : configuredRoots();
		}
		// A malformed or missing response must not cause an endless request/retry loop.
		if (extra.mcpReq.inputResponses) return configuredRoots();
		return inputRequired({ inputRequests: { workspace: inputRequired.listRoots() } });
	};

	server.registerTool(
		"code_search",
		{
			title: "Code Search",
			description: CODE_SEARCH_DESCRIPTION,
			inputSchema: z.object({
				query: z
					.string()
					.describe(
						"One behavior, flow, or error to locate, in concise English. Keep identifiers and error text verbatim. Not for a bare symbol, filename, or literal.",
					),
				path: z
					.string()
					.optional()
					.describe(
						"Directory to search: absolute inside a workspace root, or relative to the first root. Defaults to the first root.",
					),
			}),
			outputSchema: z.object({
				locations: z.array(
					z.object({ path: z.string(), ranges: z.array(z.tuple([z.number().int(), z.number().int()])) }),
				),
			}),
			annotations: READ_ONLY,
			icons: SERVER_ICONS,
		},
		async (args: CodeSearchArgs, extra) => {
			const roots = await workspaceRoots(extra);
			if (!Array.isArray(roots)) return roots;
			const { text, locations } = await runCodeSearch(args, {
				roots,
				signal: extra.mcpReq.signal,
				onProgress: progressReporter(extra.mcpReq._meta?.progressToken, extra.mcpReq.notify),
			});
			return searchResult(text, { locations });
		},
	);

	server.registerTool(
		"web_search",
		{
			title: "Web Search",
			description: WEB_SEARCH_DESCRIPTION,
			inputSchema: z.object({
				query: z
					.string()
					.describe(
						"Web search query. Be specific: product names, versions, exact error text. English matches best.",
					),
				max_results: z.number().int().min(1).max(10).optional().describe("Results to return (default 5)."),
				domain: z.string().optional().describe("Restrict results to one domain, e.g. 'docs.rs' or 'github.com'."),
			}),
			outputSchema: z.object({
				results: z.array(
					z.object({ url: z.string(), title: z.string().optional(), summary: z.string().optional() }),
				),
				summary: z.string().optional(),
				web_search_url: z.string().optional(),
			}),
			annotations: READ_ONLY,
			icons: SERVER_ICONS,
		},
		async (args: WebSearchArgs, extra) => {
			const { text, results, summary, webSearchUrl } = await runWebSearch(args, extra.mcpReq.signal);
			return searchResult(text, {
				results,
				...(summary ? { summary } : {}),
				...(webSearchUrl ? { web_search_url: webSearchUrl } : {}),
			});
		},
	);

	registerPrompts(server);
	return server;
}

/** Serve both protocol eras; stdout carries JSON-RPC only and anything for a person goes to stderr. */
export function serveStdio() {
	const handle = serve(createServer);
	if (!getApiKey()) {
		console.error(
			`${SERVER_NAME}: no ${ENV_KEY} set. Run \`${COMMAND} login\` and add the key to this server's env.`,
		);
	}
	return handle;
}
