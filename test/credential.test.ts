import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_KEY } from "../src/config.ts";
import { createSignIn, exchangeCode, getApiKey, looksLikeToken } from "../src/credential.ts";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uX2lkIjoieCJ9.c2ln";

afterEach(() => delete process.env[ENV_KEY]);

describe("credential", () => {
	it("reads only SEARCH_KEY and prefixes the bare JWT Devin's sign-in returns", () => {
		process.env[ENV_KEY] = JWT;
		expect(getApiKey()).toBe(`devin-session-token$${JWT}`);
	});

	it("passes an already prefixed token through unchanged", () => {
		process.env[ENV_KEY] = `devin-session-token$${JWT}`;
		expect(getApiKey()).toBe(`devin-session-token$${JWT}`);
	});

	it("ignores a blank SEARCH_KEY and never falls back to any file", () => {
		process.env[ENV_KEY] = "   ";
		expect(getApiKey()).toBeUndefined();
	});

	it("tells a raw token apart from a one-time authorization code", () => {
		expect(looksLikeToken(`devin-session-token$${JWT}`)).toBe(true);
		expect(looksLikeToken(JWT)).toBe(true);
		expect(looksLikeToken("abc123")).toBe(false);
	});

	it("binds the authorization code to the verifier whose S256 hash was in the sign-in URL", async () => {
		const attempt = createSignIn();
		const challenge = new URL(attempt.url).searchParams.get("code_challenge");
		const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as { code: string; code_verifier: string };
			expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(challenge);
			expect(body.code).toBe("abc123");
			return new Response(JSON.stringify({ token: JWT }));
		});
		await expect(exchangeCode(attempt, "  abc123 ", fetcher as unknown as typeof fetch)).resolves.toBe(JWT);
	});

	it("reports a rejected code without saving anything anywhere", async () => {
		const fetcher = vi.fn(async () => new Response("{}", { status: 400 }));
		await expect(exchangeCode(createSignIn(), "abc", fetcher as unknown as typeof fetch)).rejects.toThrow(
			/rejected the code/,
		);
	});
});
