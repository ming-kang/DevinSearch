import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_KEY, ENV_ROOT } from "../src/config.ts";
import { createServer } from "../src/server.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "devin-search-server-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "retry.ts"), "export function retry() {\n  return 1;\n}\n");
	writeFileSync(join(root, "src", "notes.md"), "# notes\n");
	process.env[ENV_KEY] = "test-key";
	delete process.env[ENV_ROOT];
});
afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env[ENV_KEY];
	delete process.env[ENV_ROOT];
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			requests.push(gunzipSync(Buffer.from(init.body as Uint8Array).subarray(5)).toString("utf-8"));
			return stream(replies.shift() ?? "");
		}),
	);
}

const answer = (xml: string) => `Done.[TOOL_CALLS]answer[ARGS]${JSON.stringify({ answer: xml })}`;

async function session(options: { roots?: boolean } = {}) {
	const server = createServer();
	const client = new Client(
		{ name: "devin-search-test", version: "0.0.0" },
		options.roots ? { capabilities: { roots: {} } } : {},
	);
	if (options.roots) {
		client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(root).href }] }));
	}
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { server, client };
}

describe("MCP server", () => {
	it("lists both search tools with their descriptions", async () => {
		const { client } = await session();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(["code_search", "web_search"]);
		expect(tools.find((t) => t.name === "code_search")?.description).toContain("SWE-grep");
		expect(tools.find((t) => t.name === "code_search")?.inputSchema.required).toEqual(["query"]);
		await client.close();
	});

	it("runs the SWE-grep loop against the client's root and returns locations", async () => {
		scriptDevin([
			'Searching.[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"export function retry","path":"/codebase/src"}}',
			answer('<ANSWER><file path="/codebase/src/retry.ts"><range>1-3</range></file></ANSWER>'),
		]);
		const { client } = await session({ roots: true });
		const result = await client.callTool({ name: "code_search", arguments: { query: "where does retry live" } });
		expect(result.isError).toBeFalsy();
		const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text).toContain("src/retry.ts (L1-3)");
		expect((result.structuredContent as { locations: unknown }).locations).toEqual([
			{ path: "src/retry.ts", ranges: [[1, 3]] },
		]);
		await client.close();
	});

	it("falls back to SEARCH_ROOT when the client offers no roots", async () => {
		process.env[ENV_ROOT] = root;
		scriptDevin([
			'Reading.[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"readfile","file":"/codebase/notes.md"}}',
			answer('<ANSWER><file path="/codebase/notes.md"><range>1-1</range></file></ANSWER>'),
		]);
		const { client } = await session();
		// `path` becomes the workspace the planner sees as /codebase; answers stay root-relative.
		const result = await client.callTool({ name: "code_search", arguments: { query: "notes", path: "src" } });
		expect(result.isError).toBeFalsy();
		expect((result.structuredContent as { locations: Array<{ path: string }> }).locations[0]?.path).toBe("src/notes.md");
		await client.close();
	});

	it("refuses a path outside the workspace root", async () => {
		const { client } = await session({ roots: true });
		const result = await client.callTool({ name: "code_search", arguments: { query: "q", path: "../outside" } });
		expect(result.isError).toBe(true);
		expect((result.content as Array<{ type: string; text: string }>)[0]!.text).toContain("must be inside the workspace root");
		await client.close();
	});

	it("tells the model how to sign in when there is no credential", async () => {
		delete process.env[ENV_KEY];
		const { client } = await session({ roots: true });
		const result = await client.callTool({ name: "code_search", arguments: { query: "q" } });
		expect(result.isError).toBe(true);
		expect((result.content as Array<{ type: string; text: string }>)[0]!.text).toContain("devin-search-mcp login");
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
		const { client } = await session();
		const result = await client.callTool({ name: "web_search", arguments: { query: "example", max_results: 2 } });
		expect(result.isError).toBeFalsy();
		const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text).toContain("https://example.com/a");
		expect(text).toContain("first excerpt");
		expect((result.structuredContent as { results: unknown }).results).toHaveLength(2);
		await client.close();
	});

	it("streams progress notifications while the planner works", async () => {
		scriptDevin([answer("<ANSWER></ANSWER>")]);
		const { client } = await session({ roots: true });
		const messages: string[] = [];
		client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
			messages.push(notification.params.message ?? "");
		});
		await client.callTool({ name: "code_search", arguments: { query: "q" }, _meta: { progressToken: "t1" } });
		expect(messages).toContain("Planning (round 1/3)…");
		await client.close();
	});
});
