/**
 * What a client is told besides each tool's own description.
 *
 * The description is a catalog line for choosing this server. Instructions are the cross-tool
 * choice, and must not repeat those descriptions. Prompts are user-invoked templates for hosts
 * that surface them; a host that drops instructions can still start a search from one.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_WEBSITE } from "./version.ts";

export const SERVER_NAME = "@astralyn/search";

/** Display name. The description, not this, says which kind of search. */
export const SERVER_TITLE = "Search";

/** Catalog line. Naming the backend does not help a model choose a tool. */
export const SERVER_DESCRIPTION = "Semantic code search and live web search.";

export const SERVER_INFO = {
	name: SERVER_NAME,
	title: SERVER_TITLE,
	description: SERVER_DESCRIPTION,
	...(SERVER_WEBSITE ? { websiteUrl: SERVER_WEBSITE } : {}),
};

function currentMonth(now: Date): string {
	return now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Cross-tool choice and follow-through. The month is fixed when the session starts. */
export function instructions(now = new Date()): string {
	const month = currentMonth(now);
	return [
		"Use `code_search` when you cannot name the file, symbol, or literal. Read the ranges it returns before editing; they are candidates, not answers.",
		"Use `web_search` for information beyond your knowledge cutoff.",
		`It is ${month}; put this year in \`web_search\` queries for recent releases, versions, or events, not the year your training data suggests.`,
		"When an answer relies on `web_search` results, cite each result you used as a markdown link: [Title](URL).",
	].join("\n");
}

function locateBrief(query: string, path?: string): string {
	const lines = [
		"Locate this in the workspace with `code_search`.",
		"Write the tool query as the behavior, in concise English, and keep identifiers verbatim. Do not pass a bare symbol, filename, or literal.",
		"Read every returned range before editing; the locations are candidates, not answers.",
	];
	if (path?.trim()) lines.push(`Search only under \`${path.trim()}\`.`);
	lines.push("", query.trim());
	return lines.join("\n");
}

function lookupBrief(query: string, now: Date): string {
	return [
		"Look this up with `web_search`.",
		`It is ${currentMonth(now)}; put this year in the query if it is about a recent release, version, or event.`,
		"Cite each result you use as a markdown link: [Title](URL).",
		"",
		query.trim(),
	].join("\n");
}

export function registerPrompts(server: McpServer): void {
	server.registerPrompt(
		"locate",
		{
			title: "Locate code",
			description: "Call `code_search` to locate behavior you cannot name as a file or symbol.",
			argsSchema: {
				query: z.string().describe("The behavior, flow, error, or concept to locate, in concise English."),
				path: z
					.string()
					.optional()
					.describe("Directory to search: absolute inside a workspace root, or relative to the first root."),
			},
		},
		({ query, path }) => ({
			messages: [{ role: "user", content: { type: "text", text: locateBrief(query, path) } }],
		}),
	);

	server.registerPrompt(
		"lookup",
		{
			title: "Look up",
			description: "Call `web_search` for information beyond your knowledge cutoff.",
			argsSchema: {
				query: z
					.string()
					.describe(
						"What to look up. Be specific: product names, versions, exact error text. English matches best.",
					),
			},
		},
		({ query }) => ({
			messages: [{ role: "user", content: { type: "text", text: lookupBrief(query, new Date()) } }],
		}),
	);
}
