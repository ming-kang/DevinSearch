import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { codeSearch, parseAnswer, parseToolCall } from "../src/code-search.ts";
import { DevinAuthError, decodeChatResponse, webSearch } from "../src/devin.ts";
import { MAX_TURNS } from "../src/prompt.ts";
import { Workspace } from "../src/workspace.ts";

const root = mkdtempSync(join(tmpdir(), "devin-search-code-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "retry.ts"), "export function retry() {\n  return 1;\n}\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

/** A Connect frame: flags byte, big-endian length, payload. */
function frameOf(flags: number, payload: Buffer): Buffer {
	const head = Buffer.alloc(5);
	head[0] = flags;
	head.writeUInt32BE(payload.length, 1);
	return Buffer.concat([head, payload]);
}

/** A Connect stream as Devin sends it: gzip data frames carrying text in field 2, then an end frame. */
function stream(text: string, end: object = {}, toolCalls: Array<{ name: string; args: object }> = []): Response {
	const data = Buffer.from(text, "utf-8");
	const fields = [Buffer.from([0x12, ...varint(data.length)]), data];
	for (const call of toolCalls) {
		const message = Buffer.concat([field(1, "call-1"), field(2, call.name), field(3, JSON.stringify(call.args))]);
		fields.push(Buffer.from([0x1a, ...varint(message.length)]), message);
	}
	const message = gzipSync(Buffer.concat(fields));
	const trailer = Buffer.from(JSON.stringify(end));
	return new Response(new Uint8Array(Buffer.concat([frameOf(1, message), frameOf(2, trailer)])));
}

function field(no: number, value: string): Buffer {
	const data = Buffer.from(value, "utf-8");
	return Buffer.concat([Buffer.from([(no << 3) | 2, ...varint(data.length)]), data]);
}

function varint(n: number): number[] {
	const out: number[] = [];
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	return [...out, n];
}

type Reply = string | { text: string; toolCalls: Array<{ name: string; args: object }> };

/** Script Devin's replies and record every request body it receives. */
function devin(replies: Reply[]): string[] {
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			const body = Buffer.from(init.body as Uint8Array);
			requests.push(gunzipSync(body.subarray(5)).toString("utf-8"));
			const reply = replies.shift() ?? "";
			return typeof reply === "string" ? stream(reply) : stream(reply.text, {}, reply.toolCalls);
		}),
	);
	return requests;
}

const answer = (xml: string) => `Done.[TOOL_CALLS]answer[ARGS]${JSON.stringify({ answer: xml })}`;

describe("code_search loop", () => {
	it("runs the planner's commands locally and returns only answer paths inside the root", async () => {
		const requests = devin([
			// The malformed key quoting the live backend produces: `,start_line":1`.
			'Let me read.[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"readfile","file":"/codebase/src/retry.ts",start_line":1}}</s>',
			answer(
				'<ANSWER><file path="/codebase/src/retry.ts"><range>1-3</range></file><file path="/codebase/../outside.ts"><range>1-2</range></file></ANSWER>',
			),
		]);
		const locations = await codeSearch({ apiKey: "k", query: "retry", root });
		expect(locations).toEqual([{ path: join(root, "src", "retry.ts"), ranges: [[1, 3]] }]);
		expect(requests[1]).toContain("1:export function retry() {");
	});

	it("demands an answer once the planning rounds run out", async () => {
		const call = '[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"tree","path":"/codebase"}}';
		const requests = devin([...Array(MAX_TURNS).fill(call), answer("<ANSWER></ANSWER>")]);
		await expect(codeSearch({ apiKey: "k", query: "q", root })).resolves.toEqual([]);
		expect(requests).toHaveLength(MAX_TURNS + 1);
		expect(requests.at(-1)).toContain("You have no turns left");
	});

	it("repairs a bare key without rewriting key-shaped text inside a string value", () => {
		// `path:` lacks quotes, forcing the repair pass; `{ y: 1 }` inside the pattern must survive it.
		const call = parseToolCall(
			'[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"if (x) { y: 1 }",path:"/codebase"}}',
		);
		expect(call?.args).toEqual({ command1: { type: "rg", pattern: "if (x) { y: 1 }", path: "/codebase" } });
	});

	it("keeps braces inside string values when finding the end of the arguments", () => {
		const call = parseToolCall(
			'[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"\\\\{\\\\}"}} trailing }',
		);
		expect(call?.args).toEqual({ command1: { type: "rg", pattern: "\\{\\}" } });
	});

	it("uses a structured tool_calls frame instead of parsing reply text", async () => {
		devin([
			{
				text: "Searching.",
				toolCalls: [
					{
						name: "restricted_exec",
						args: { command1: { type: "readfile", file: "/codebase/src/retry.ts" } },
					},
				],
			},
			{
				text: "",
				toolCalls: [
					{
						name: "answer",
						args: { answer: '<ANSWER><file path="/codebase/src/retry.ts"><range>1-2</range></file></ANSWER>' },
					},
				],
			},
		]);
		const locations = await codeSearch({ apiKey: "k", query: "retry", root });
		expect(locations).toEqual([{ path: join(root, "src", "retry.ts"), ranges: [[1, 2]] }]);
	});
});

describe("Devin responses", () => {
	it("reports an end-of-stream unauthenticated error as a credential failure", async () => {
		const response = stream("", { error: { code: "unauthenticated", message: "invalid api key" } });
		const body = Buffer.from(await response.arrayBuffer());
		expect(() => decodeChatResponse(body)).toThrow(DevinAuthError);
	});

	it("keeps only http(s) web results without embedded credentials", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							results: [
								{ url: "https://example.com/a", title: "A", summary: "excerpt" },
								{ url: "https://user:pw@example.com/b" },
								{ url: "javascript:alert(1)" },
								{ url: "http://example.com/c" },
							],
						}),
					),
			),
		);
		const { results } = await webSearch("k", "q", 5);
		expect(results).toEqual([
			{ url: "https://example.com/a", title: "A", summary: "excerpt" },
			{ url: "http://example.com/c" },
		]);
	});

	it("passes a domain restriction through and surfaces the search URL", async () => {
		let body: { query?: string; domain?: string } = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				body = JSON.parse(String(init.body));
				return new Response(
					JSON.stringify({
						results: [{ url: "https://docs.rs/a", title: "A" }],
						summary: "A synthesized answer.",
						webSearchUrl: "https://www.google.com/search?q=a",
					}),
				);
			}),
		);
		const response = await webSearch("k", "serde", 5, "docs.rs");
		expect(body.domain).toBe("docs.rs");
		expect(response.summary).toBe("A synthesized answer.");
		expect(response.webSearchUrl).toBe("https://www.google.com/search?q=a");
	});
});

describe("transport boundaries", () => {
	it("rejects a truncated frame, reserved flags, and a corrupt gzip payload", () => {
		expect(() => decodeChatResponse(Buffer.from([1, 0, 0]))).toThrow(/truncated planner frame/);
		expect(() => decodeChatResponse(Buffer.concat([frameOf(0, Buffer.alloc(0)), Buffer.from([1, 2])]))).toThrow(
			/truncated planner frame/,
		);
		expect(() => decodeChatResponse(frameOf(0x04, Buffer.from("x")))).toThrow(/reserved flags/);
		expect(() => decodeChatResponse(frameOf(1, Buffer.from("not gzip at all")))).toThrow(/malformed planner frame/);
	});

	it("rejects malformed protobuf inside a data frame", () => {
		const payload = (bytes: number[]) => frameOf(0, Buffer.from(bytes));
		expect(() => decodeChatResponse(payload([0x00]))).toThrow(/malformed protobuf/);
		expect(() => decodeChatResponse(payload([0x12, 0x80]))).toThrow(/malformed protobuf/);
		expect(() => decodeChatResponse(payload([0x12, 0x64]))).toThrow(/malformed protobuf/);
		expect(() => decodeChatResponse(payload([0x0b]))).toThrow(/malformed protobuf/);
	});

	it("caps the decompressed text a gzip frame can expand to", () => {
		const bomb = frameOf(1, gzipSync(Buffer.alloc(32 * 1024 * 1024)));
		expect(() => decodeChatResponse(bomb)).toThrow(/too large/);
	});

	it("decodes multi-byte UTF-8 characters split across field chunks", () => {
		const bytes = Buffer.from("你好世界", "utf-8");
		const part1 = bytes.subarray(0, 4); // splits the second 3-byte character
		const part2 = bytes.subarray(4);
		const fld = (buf: Buffer) => Buffer.concat([Buffer.from([0x12, buf.length]), buf]);
		const body = Buffer.concat([frameOf(0, fld(part1)), frameOf(0, fld(part2)), frameOf(2, Buffer.from("{}"))]);
		expect(decodeChatResponse(body).text).toBe("你好世界");
	});

	it("rejects a malformed end frame", () => {
		expect(() => decodeChatResponse(frameOf(2, Buffer.from("{oops")))).toThrow(/malformed planner end frame/);
	});

	it("refuses a web search reply past the byte budget", async () => {
		const rows = Array.from({ length: 60_000 }, (_, i) => ({ url: `https://example.com/${i}` }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ results: rows }))),
		);
		await expect(webSearch("k", "q", 5)).rejects.toThrow(/web search reply exceeded/);
	});
});

describe("answer ranges", () => {
	const workspace = new Workspace(root);

	it("drops zero, inverted, and non-safe-integer ranges but keeps the rest in order", () => {
		const locations = parseAnswer(
			'<ANSWER><file path="/codebase/src/retry.ts"><range>0-5</range><range>5-2</range><range>4-4</range><range>1-3</range><range>1-99999999999999999999</range></file></ANSWER>',
			workspace,
		);
		expect(locations).toHaveLength(1);
		expect(locations[0]!.ranges).toEqual([
			[1, 3],
			[4, 4],
		]);
	});
});

describe("workspace confinement", () => {
	const workspace = new Workspace(root);

	it("refuses traversal, absolute paths, and other drives", async () => {
		for (const file of ["/codebase/../escape.ts", "../escape.ts", "/etc/passwd", String.raw`C:\Windows\win.ini`]) {
			expect(await workspace.run({ type: "readfile", file })).toMatch(/outside project root/);
		}
	});

	it("refuses a symlink that points outside the root", async () => {
		const outside = mkdtempSync(join(tmpdir(), "search-outside-"));
		writeFileSync(join(outside, "secret.txt"), "secret");
		try {
			symlinkSync(outside, join(root, "link"), "dir");
		} catch {
			rmSync(outside, { recursive: true, force: true });
			return; // unprivileged Windows sessions cannot create symlinks
		}
		expect(await workspace.run({ type: "readfile", file: "/codebase/link/secret.txt" })).toMatch(/outside/);
		rmSync(outside, { recursive: true, force: true });
	});

	it("reports rg hits on the virtual root, for a directory and for a single file", async () => {
		expect(await workspace.run({ type: "rg", pattern: "retry", path: "/codebase/src" })).toBe(
			"/codebase/src/retry.ts:1:export function retry() {",
		);
		expect(await workspace.run({ type: "rg", pattern: "return", path: "/codebase/src/retry.ts" })).toBe(
			"/codebase/src/retry.ts:2:  return 1;",
		);
	});
});

describe("workspace rg", () => {
	const repo = mkdtempSync(join(tmpdir(), "search-rg-"));
	afterAll(() => rmSync(repo, { recursive: true, force: true }));
	const write = (path: string, text: string) => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	};

	it("applies every include and exclude glob", async () => {
		for (const path of ["src/a.ts", "src/b.tsx", "src/c.js", "test/a.test.ts"]) write(path, "const needle = 1;\n");
		const out = await new Workspace(repo).run({
			type: "rg",
			pattern: "needle",
			path: "/codebase",
			include: ["**/*.ts", "**/*.tsx"],
			exclude: ["**/test/**"],
		});
		expect(out).toBe("/codebase/src/a.ts:1:const needle = 1;\n/codebase/src/b.tsx:1:const needle = 1;");
	});

	it("leads an over-broad search with matches per file", async () => {
		for (let i = 10; i < 40; i++) write(`many/f${i}.ts`, "hit\nhit\n");
		write("many/z.ts", "hit\nhit\nhit\n");
		const lines = (await new Workspace(repo).run({ type: "rg", pattern: "hit", path: "/codebase/many" })).split("\n");
		expect(lines[0]).toMatch(/^63 matches in 31 files;/);
		expect(lines[1]).toBe("/codebase/many/z.ts: 3");
		expect(lines.length).toBeLessThanOrEqual(51);
	});
});

describe("workspace visibility and paging", () => {
	const repo = mkdtempSync(join(tmpdir(), "search-visible-"));
	afterAll(() => rmSync(repo, { recursive: true, force: true }));
	const write = (path: string, text: string) => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	};
	write(".gitignore", ".env\ndist/\n");
	write(".env", "TOKEN=SECRET\n");
	write("dist/bundle.js", "SECRET\n");
	write("src/a.ts", Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
	for (let i = 0; i < 30; i++) write(`pkgs/p${i}/index.ts`, "x\n");

	it("keeps ignored files out of readfile, rg, and tree, even when named directly", async () => {
		const workspace = new Workspace(repo);
		expect(await workspace.run({ type: "readfile", file: "/codebase/.env" })).toMatch(/not searchable/);
		expect(await workspace.run({ type: "rg", pattern: "SECRET", path: "/codebase/.env" })).toMatch(/not searchable/);
		expect(await workspace.run({ type: "rg", pattern: "SECRET", path: "/codebase/dist" })).toMatch(/not searchable/);
		expect(await workspace.run({ type: "rg", pattern: "SECRET", path: "/codebase" })).toBe("(no matches)");
		const { tree } = await workspace.repoMap();
		expect(tree).toContain("└── src/");
		expect(tree).not.toMatch(/\.env|dist/);
	});

	it("skips dependency directories no ignore file mentions, but not committed vendor code", async () => {
		write("web/node_modules/lib/index.js", "SECRET\n");
		write("vendor/lib.ts", "x\n");
		const workspace = new Workspace(repo);
		expect(await workspace.run({ type: "rg", pattern: "SECRET", path: "/codebase" })).toBe("(no matches)");
		expect(await workspace.run({ type: "readfile", file: "web/node_modules/lib/index.js" })).toMatch(
			/not searchable/,
		);
		const { tree } = await workspace.repoMap();
		expect(tree).not.toContain("node_modules");
		expect(tree).toContain("vendor/");
	});

	it("states a file's length and where to continue a clipped read", async () => {
		const lines = (await new Workspace(repo).run({ type: "readfile", file: "src/a.ts", end_line: 100 })).split("\n");
		expect(lines[0]).toBe("/codebase/src/a.ts (100 lines)");
		expect(lines[1]).toBe("1:line 1");
		expect(lines.at(-1)).toBe("... (lines 51-100 not shown; continue with start_line=51)");
	});

	it("shallows a tree that would not fit rather than cutting it off", async () => {
		const out = await new Workspace(repo).run({ type: "tree", path: "/codebase/pkgs", levels: 2 });
		expect(out.split("\n")).toHaveLength(32);
		expect(out).toMatch(/├── p0\/\n/);
		expect(out).toMatch(/\(levels reduced to 1 to fit\)$/);
	});

	it("ls hides dotfiles unless asked, and stays out of ignored directories", async () => {
		write("src/.hidden.ts", "x\n");
		const workspace = new Workspace(repo);
		const out = await workspace.run({ type: "ls", path: "/codebase/src" });
		expect(out).toBe("a.ts");
		expect(await workspace.run({ type: "ls", path: "/codebase/src", all: true })).toBe(".hidden.ts\na.ts");
		expect(await workspace.run({ type: "ls", path: "/codebase/dist" })).toMatch(/not searchable/);
	});

	it("ls long format annotates directories and file sizes", async () => {
		write("pkgs/z.ts", "12345\n");
		const out = await new Workspace(repo).run({ type: "ls", path: "/codebase/pkgs/p0", long_format: true });
		expect(out).toMatch(/^\s+2 {2}index\.ts$/m);
	});

	it("glob matches files, directories, or both under the path", async () => {
		const workspace = new Workspace(repo);
		expect(await workspace.run({ type: "glob", pattern: "src/*.ts", path: "/codebase" })).toContain(
			"/codebase/src/a.ts",
		);
		expect(
			await workspace.run({ type: "glob", pattern: "pkgs/*", path: "/codebase", type_filter: "directory" }),
		).toBe(
			Array.from({ length: 30 }, (_, i) => `/codebase/pkgs/p${i}/`)
				.sort()
				.join("\n"),
		);
		expect(await workspace.run({ type: "glob", pattern: "*.env", path: "/codebase" })).toBe("(no matches)");
	});
});

describe("workspace resource boundaries", () => {
	const repo = mkdtempSync(join(tmpdir(), "search-bounds-"));
	afterAll(() => rmSync(repo, { recursive: true, force: true }));
	writeFileSync(join(repo, "a.ts"), "const a = 1;\n");

	it("does not run a command whose signal is already aborted", async () => {
		const aborted = new AbortController();
		aborted.abort();
		expect(await new Workspace(repo).run({ type: "readfile", file: "a.ts" }, aborted.signal)).toMatch(/abort/i);
	});

	it("retries the file index after an aborted attempt instead of replaying the rejection", async () => {
		const workspace = new Workspace(repo);
		const aborted = new AbortController();
		aborted.abort();
		expect(await workspace.run({ type: "tree", path: "/codebase" }, aborted.signal)).toMatch(/abort/i);
		expect(await workspace.run({ type: "tree", path: "/codebase" })).toContain("/codebase");
	});

	it("refuses a file past the read budget rather than loading it", async () => {
		writeFileSync(join(repo, "huge.txt"), Buffer.alloc(5 * 1024 * 1024, 0x61));
		expect(await new Workspace(repo).run({ type: "readfile", file: "huge.txt" })).toMatch(/read limit/);
	});
});
