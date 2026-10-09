/**
 * The two tools behind the MCP layer: argument checks, the credential, and the model-facing text.
 * Locations come back as absolute paths, since the client's working directory is unknown here.
 */
import { isAbsolute, resolve } from "node:path";
import { type CodeLocation, codeSearch, formatLocations } from "./code-search.ts";
import { COMMAND, ENV_KEY, ENV_ROOT } from "./config.ts";
import { getApiKey } from "./credential.ts";
import { DevinAuthError, type WebResult, webSearch } from "./devin.ts";
import { isInside } from "./workspace.ts";

const WEB_EXCERPT_MAX_CHARS = 1500;

const SIGN_IN_HINT = `Ask the user to run \`${COMMAND} login\` and set the key it prints as ${ENV_KEY} in this MCP server's config.`;

export const CODE_SEARCH_DESCRIPTION =
	"Find where behavior lives in the workspace from a description of it. Returns candidate files with line ranges.";

export const WEB_SEARCH_DESCRIPTION =
	"Search the live web for current information. Returns titles, URLs, and the page excerpts that match the query.";

/** Run a Devin call with the current credential; credential failures tell the model what fixes them. */
async function withDevin<T>(run: (apiKey: string) => Promise<T>): Promise<T> {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error(`Devin Search has no ${ENV_KEY}. ${SIGN_IN_HINT}`);
	try {
		return await run(apiKey);
	} catch (error) {
		throw error instanceof DevinAuthError ? new Error(`${error.message} ${SIGN_IN_HINT}`) : error;
	}
}

export interface CodeSearchArgs {
	query: string;
	path?: string;
}

export interface WebSearchArgs {
	query: string;
	max_results?: number;
}

export interface CodeSearchOptions {
	/** Workspace roots, the first being the default. */
	roots: string[];
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

/** An absolute `path` searches inside whichever root holds it; a relative one is under the first root. */
function searchScope(roots: string[], path: string | undefined): { root: string; dir: string } {
	const [first] = roots;
	if (!first) throw new Error(`no workspace root: the client offers no MCP roots and ${ENV_ROOT} is unset.`);
	const value = path?.trim();
	if (value && isAbsolute(value)) {
		const root = roots.find((r) => isInside(r, value));
		if (!root) throw new Error(`path must be inside a workspace root (${roots.join(", ")}).`);
		return { root, dir: resolve(value) };
	}
	const dir = resolve(first, value || ".");
	if (!isInside(first, dir)) throw new Error(`path must be inside the workspace root (${first}).`);
	return { root: first, dir };
}

export async function runCodeSearch(
	args: CodeSearchArgs,
	options: CodeSearchOptions,
): Promise<{ text: string; locations: CodeLocation[] }> {
	const query = args.query.trim();
	if (!query) throw new Error("query must not be empty.");
	const { root, dir } = searchScope(options.roots, args.path);
	const found = await withDevin((apiKey) =>
		codeSearch({ apiKey, query, root: dir, cwd: root, signal: options.signal, onProgress: options.onProgress }),
	);
	const locations = found.map((location) => ({ ...location, path: resolve(root, location.path) }));
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
	return `Web results for "${query}":\n\n${blocks.join("\n\n")}`;
}

export async function runWebSearch(
	args: WebSearchArgs,
	signal?: AbortSignal,
): Promise<{ text: string; results: WebResult[] }> {
	const query = args.query.trim();
	if (!query) throw new Error("query must not be empty.");
	const results = await withDevin((apiKey) => webSearch(apiKey, query, args.max_results ?? 5, signal));
	return { text: formatWebResults(query, results), results };
}
