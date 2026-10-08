/**
 * The local grep backend for code_search. Output contract: `path:line: text` lines, paths
 * relative to the searched directory (bare file name for a file), capped at RESULT_MAX_LINES
 * matches — what workspace.ts re-maps onto the virtual root.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { basename, relative, resolve } from "node:path";
import type { Grep } from "./workspace.ts";

const RESULT_MAX_LINES = 40;

let binaryPromise: Promise<string | undefined> | undefined;

export function resolveRgBinary(): Promise<string | undefined> {
	binaryPromise ??= (async () => {
		const override = process.env.SEARCH_RG_PATH?.trim();
		if (override) return override;
		try {
			const require = createRequire(import.meta.url);
			const rgPath = (require("@vscode/ripgrep") as { rgPath?: unknown }).rgPath;
			if (typeof rgPath === "string" && rgPath) return rgPath;
		} catch {}
		return "rg";
	})();
	return binaryPromise;
}

export function resetRgBinaryForTests(): void {
	binaryPromise = undefined;
}

export function createRgGrep(): Grep {
	return async (pattern, path, glob, signal) => {
		const binary = await resolveRgBinary();
		if (!binary) throw new Error("ripgrep (rg) is not available: install @vscode/ripgrep or add rg to PATH");
		const searchPath = resolve(path);
		const args = ["--json", "--line-number", "--color=never", "--hidden"];
		if (glob) args.push("--glob", glob);
		args.push("--", pattern, searchPath);
		return new Promise<string>((resolvePromise, rejectPromise) => {
			if (signal?.aborted) {
				rejectPromise(new Error("Operation aborted"));
				return;
			}
			const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
			let settled = false;
			const settle = (fn: () => void) => {
				if (!settled) {
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					fn();
				}
			};
			const onAbort = () => child.kill();
			signal?.addEventListener("abort", onAbort, { once: true });

			const lines: string[] = [];
			let count = 0;
			let stderr = "";
			let buffer = "";
			child.stdout.setEncoding("utf-8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				const parts = buffer.split("\n");
				buffer = parts.pop() ?? "";
				for (const line of parts) {
					if (!line.trim() || count >= RESULT_MAX_LINES) continue;
					let event: {
						type?: string;
						data?: {
							path?: { text?: string };
							line_number?: number;
							lines?: { text?: string };
						};
					};
					try {
						event = JSON.parse(line) as typeof event;
					} catch {
						continue;
					}
					if (event.type !== "match") continue;
					const filePath = event.data?.path?.text;
					const lineNumber = event.data?.line_number;
					if (!filePath || typeof lineNumber !== "number") continue;
					count++;
					lines.push(`${formatHit(filePath, searchPath)}:${lineNumber}: ${hitText(event.data?.lines?.text)}`);
					if (count >= RESULT_MAX_LINES) child.kill();
				}
			});
			child.stderr.setEncoding("utf-8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", (error) => {
				settle(() =>
					rejectPromise(
						new Error(
							`Failed to run ripgrep (${binary}): ${error.message}. Install @vscode/ripgrep or add rg to PATH, or set SEARCH_RG_PATH.`,
						),
					),
				);
			});
			child.on("close", (code) => {
				settle(() => {
					if (signal?.aborted) {
						rejectPromise(new Error("Operation aborted"));
						return;
					}
					// rg exits 1 when there are no matches, 2 on a real error.
					if (code !== 0 && code !== 1) {
						rejectPromise(new Error((stderr.trim() || `ripgrep exited with code ${code}`).split("\n")[0]!));
						return;
					}
					resolvePromise(lines.length ? lines.join("\n") : "No matches found");
				});
			});
		});
	};
}

function hitText(text: string | undefined): string {
	return (text ?? "").replace(/\r?\n$/, "").replace(/\r/g, "");
}

function formatHit(filePath: string, searchPath: string): string {
	const rel = relative(searchPath, resolve(filePath));
	if (rel && !rel.startsWith("..")) return rel.split("\\").join("/");
	return basename(filePath);
}
