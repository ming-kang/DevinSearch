import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRgGrep, resetRgBinaryForTests, resolveRgBinary } from "../src/grep.ts";
import { ENV_RG_PATH } from "../src/config.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "devin-search-grep-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "retry.ts"), "export function retry() {\n  return 1;\n}\n");
	writeFileSync(join(root, "src", "notes.md"), "# notes\n");
	delete process.env[ENV_RG_PATH];
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("rg backend", () => {
	it("has a binary to run (bundled @vscode/ripgrep or PATH rg)", async () => {
		expect(await resolveRgBinary()).toBeTruthy();
	});

	it("returns workspace-relative hits the workspace can re-map onto the virtual root", async () => {
		const grep = createRgGrep();
		await expect(grep("export function retry", join(root, "src"), undefined)).resolves.toBe(
			"retry.ts:1: export function retry() {",
		);
	});

	it("applies the first include glob", async () => {
		const grep = createRgGrep();
		await expect(grep("retry", root, "**/*.ts", undefined)).resolves.toContain("src/retry.ts:1: export function retry() {");
		await expect(grep("notes", root, "**/*.md", undefined)).resolves.toContain("notes.md:1: # notes");
		await expect(grep("notes", root, "**/*.ts", undefined)).resolves.toBe("No matches found");
	});

	it("respects .gitignore inside a git repo like ripgrep does", async () => {
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, ".gitignore"), "ignored/\n");
		mkdirSync(join(root, "ignored"));
		writeFileSync(join(root, "ignored", "hidden.ts"), "export const retry = 1;\n");
		const grep = createRgGrep();
		await expect(grep("export const retry", root, undefined)).resolves.toBe("No matches found");
	});

	it("reports a spawn failure instead of hanging when the binary is missing", async () => {
		resetRgBinaryForTests();
		process.env[ENV_RG_PATH] = "/definitely/not/rg";
		await expect(createRgGrep()("retry", root, undefined)).rejects.toThrow(/Failed to run ripgrep/);
		resetRgBinaryForTests();
	});
});
