import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_KEY, ENV_ROOT } from "../src/config.ts";
import { createServer } from "../src/server.ts";

let root: string;
let other: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "devin-search-server-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "retry.ts"), "export function retry() {\n  return 1;\n}\n");
	writeFileSync(join(root, "src", "notes.md"), "# notes\n");
	other = mkdtempSync(join(tmpdir(), "devin-search-other-"));
	writeFileSync(join(other, "billing.ts"), "export const charge = 1;\n");
	process.env[ENV_KEY] = "test-key";
	delete process.env[ENV_ROOT];
});
afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env[ENV_KEY];
	delete process.env[ENV_ROOT];
	rmSync(root, { recursive: true, force: true });
	rmSync(other, { recursive: true, force: true });
});

/** A Connect stream as Devin sends it: gzip data frames carrying text in field 2, then an end frame. */
function stream(text: string): Response {
	const data = Buffer.from(text, "utf-8");
	const message = gzipSync(Buffer.concat([Buffer.from([0x12, ...varint(data.length)]), data]));
	const frame = (flags: number, body: Buffer) => {
		const head = Buffer.alloc(5);
		head[0] = flags;
		head.writeUInt32BE(body.length, 1);
		return Buffer.concat([head, body]);
	};
	return new Response(new Uint8Array(Buffer.concat([frame(1, message), frame(2, Buffer.from("{}"))])));
}

function varint(n: number): number[] {
	const out: number[] = [];
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	return [...out, n];
}

function scriptDevin(replies: string[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => stream(replies.shift() ?? "")),
	);
}

const answer = (xml: string) => `Done.[TOOL_CALLS]answer[ARGS]${JSON.stringify({ answer: xml })}`;

/** A connected client; with `roots`, it offers those directories and can change them later. */
async function session(roots?: string[]) {
	const server = createServer();
	const client = new Client(
		{ name: "devin-search-test", version: "0.0.0" },
		roots ? { capabilities: { roots: { listChanged: true } } } : {},
	);
	if (roots) {
		client.setRequestHandler(ListRootsRequestSchema, async () => ({
			roots: roots.map((dir) => ({ uri: pathToFileURL(dir).href })),
		}));
	}
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;
const locations = (result: unknown) =>
	(result as { structuredContent: { locations: Array<{ path: string; ranges: number[][] }> } }).structuredContent
		.locations;

describe("MCP server", () => {
	it("lists both tools and tells the client when to use each, with the current year", async () => {
		const client = await session();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(["code_search", "web_search"]);
		expect(tools.find((t) => t.name === "code_search")?.inputSchema.required).toEqual(["query"]);
		const instructions = client.getInstructions() ?? "";
		expect(instructions).toContain("Use `code_search` when");
		expect(instructions).toContain(String(new Date().getFullYear()));
		await client.close();
	});

	it("runs the planner against the client's root and returns absolute locations", async () => {
		scriptDevin([
			'Searching.[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"export function retry","path":"/codebase/src"}}',
			answer('<ANSWER><file path="/codebase/src/retry.ts"><range>1-3</range></file></ANSWER>'),
		]);
		const client = await session([root]);
		const result = await client.callTool({ name: "code_search", arguments: { query: "where does retry live" } });
		expect(result.isError).toBeFalsy();
		expect(text(result)).toContain(`${join(root, "src", "retry.ts")} (L1-3)`);
		expect(locations(result)).toEqual([{ path: join(root, "src", "retry.ts"), ranges: [[1, 3]] }]);
		await client.close();
	});

	it("searches whichever root holds an absolute path", async () => {
		scriptDevin([answer('<ANSWER><file path="/codebase/billing.ts"><range>1-1</range></file></ANSWER>')]);
		const client = await session([root, other]);
		const result = await client.callTool({ name: "code_search", arguments: { query: "charging", path: other } });
		expect(locations(result)).toEqual([{ path: join(other, "billing.ts"), ranges: [[1, 1]] }]);
		await client.close();
	});

	it("asks for the roots again after the client reports a change", async () => {
		const roots = [root];
		const client = await session(roots);
		scriptDevin([answer("<ANSWER></ANSWER>")]);
		await client.callTool({ name: "code_search", arguments: { query: "q" } });
		roots.splice(0, 1, other);
		await client.sendRootsListChanged();
		scriptDevin([answer('<ANSWER><file path="/codebase/billing.ts"><range>1-1</range></file></ANSWER>')]);
		const result = await client.callTool({ name: "code_search", arguments: { query: "charging" } });
		expect(locations(result)[0]?.path).toBe(join(other, "billing.ts"));
		await client.close();
	});

	it("falls back to SEARCH_ROOT when the client offers no roots", async () => {
		process.env[ENV_ROOT] = root;
		scriptDevin([
			'Reading.[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"readfile","file":"/codebase/notes.md"}}',
			answer('<ANSWER><file path="/codebase/notes.md"><range>1-1</range></file></ANSWER>'),
		]);
		const client = await session();
		// `path` becomes the directory the planner sees as /codebase.
		const result = await client.callTool({ name: "code_search", arguments: { query: "notes", path: "src" } });
		expect(result.isError).toBeFalsy();
		expect(locations(result)[0]?.path).toBe(join(root, "src", "notes.md"));
		await client.close();
	});

	it("refuses a path outside the workspace root", async () => {
		const client = await session([root]);
		for (const path of ["../outside", other]) {
			const result = await client.callTool({ name: "code_search", arguments: { query: "q", path } });
			expect(result.isError).toBe(true);
			expect(text(result)).toMatch(/must be inside/);
		}
		await client.close();
	});

	it("tells the model how to get a key when there is none", async () => {
		delete process.env[ENV_KEY];
		const client = await session([root]);
		const result = await client.callTool({ name: "web_search", arguments: { query: "q" } });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("npx @astralyn/search login");
		await client.close();
	});

	it("returns web results with titles, urls, and excerpts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							results: [
								{ url: "https://example.com/a", title: "A", summary: "first excerpt" },
								{ url: "https://example.com/b", title: "B" },
							],
						}),
					),
			),
		);
		const client = await session();
		const result = await client.callTool({ name: "web_search", arguments: { query: "example", max_results: 2 } });
		expect(result.isError).toBeFalsy();
		expect(text(result)).toContain("https://example.com/a");
		expect(text(result)).toContain("first excerpt");
		expect((result.structuredContent as { results: unknown[] }).results).toHaveLength(2);
		await client.close();
	});

	it("streams progress notifications while the planner works", async () => {
		scriptDevin([answer("<ANSWER></ANSWER>")]);
		const client = await session([root]);
		const messages: string[] = [];
		client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
			messages.push(notification.params.message ?? "");
		});
		await client.callTool({ name: "code_search", arguments: { query: "q" }, _meta: { progressToken: "t1" } });
		expect(messages).toContain("Planning (round 1/3)…");
		await client.close();
	});
});
