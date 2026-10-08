import { resolve } from "node:path";
import { type CodeLocation, codeSearch, formatLocations } from "./code-search.ts";
import { getApiKey } from "./credential.ts";
import { DevinAuthError, type WebResult, webSearch } from "./devin.ts";
import { truncateHead } from "./truncate.ts";
import { isInside, Workspace } from "./workspace.ts";

const WEB_EXCERPT_MAX_CHARS = 1500;

const SIGN_IN_HINT =
	"Run `devin-search-mcp login` to mint a key, then set SEARCH_KEY in the MCP client's env.";

async function withDevin<T>(run: (apiKey: string) => Promise<T>): Promise<T> {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error(`Devin Search is not signed in. ${SIGN_IN_HINT}`);
	try {
		return await run(apiKey);
	} catch (error) {
		throw error instanceof DevinAuthError ? new Error(`${error.message} ${SIGN_IN_HINT}`) : error;
	}
}

export const CODE_SEARCH_DESCRIPTION =
	"Find where behavior lives in the local repository by describing it, powered by Devin's SWE-grep agent. " +
	"Use it when the relevant files are unknown: exploration, tracing a flow or bug, planning a change in " +
	"unfamiliar code. Returns candidate files with line ranges — a reading list to verify with read or grep. " +
	"For known paths, exact symbols, or literal strings, use find, grep, or read directly.";

export const WEB_SEARCH_DESCRIPTION =
	"Search the live web through Devin. Use it for facts outside the repository: library and API docs, error " +
	"messages, release notes, current versions. Returns titles, URLs, and query-relevant page excerpts.";

export interface CodeSearchArgs {
	query: string;
	path?: string;
}

export interface WebSearchArgs {
	query: string;
	max_results?: number;
}

export interface ToolRunOptions {
	root?: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	workspace?: Workspace;
}

export interface CodeSearchOutcome {
	text: string;
	locations: CodeLocation[];
}

export interface WebSearchOutcome {
	text: string;
	results: WebResult[];
}

export async function runCodeSearch(args: CodeSearchArgs, options: ToolRunOptions): Promise<CodeSearchOutcome> {
	const query = args.query.trim();
	if (!query) throw new Error("query must not be empty.");
	if (!options.root) throw new Error("a workspace root is required (MCP roots, SEARCH_ROOT, or cwd).");
	const root = resolve(options.root);
	const searchRoot = resolve(root, args.path?.trim() || ".");
	if (!isInside(root, searchRoot)) throw new Error(`path must be inside the workspace root (${root}).`);
	const locations = await withDevin((apiKey) =>
		codeSearch({
			apiKey,
			query,
			root: searchRoot,
			cwd: root,
			signal: options.signal,
			onProgress: options.onProgress,
			workspace: options.workspace,
		}),
	);
	return { text: formatLocations(locations), locations };
}

export function formatWebResults(query: string, results: WebResult[]): string {
	if (!results.length) return `No web results for "${query}".`;
	const blocks = results.map((r, i) => {
		const lines = [`${i + 1}. ${r.title ?? r.url}`, `   ${r.url}`];
		if (r.summary) {
			const excerpt = r.summary.replace(/\n\s*\n+/g, "\n").trim();
			lines.push(excerpt.length > WEB_EXCERPT_MAX_CHARS ? `${excerpt.slice(0, WEB_EXCERPT_MAX_CHARS)}…` : excerpt);
		}
		return lines.join("\n");
	});
	return truncateHead(`Web results for "${query}":\n\n${blocks.join("\n\n")}`).content;
}

export async function runWebSearch(args: WebSearchArgs, options: ToolRunOptions = {}): Promise<WebSearchOutcome> {
	const query = args.query.trim();
	if (!query) throw new Error("query must not be empty.");
	const results = await withDevin((apiKey) => webSearch(apiKey, query, args.max_results ?? 5, options.signal));
	return { text: formatWebResults(query, results), results };
}
