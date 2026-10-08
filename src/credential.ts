import { createHash, randomBytes } from "node:crypto";
import { ENV_KEY } from "./config.ts";

const SESSION_PREFIX = "devin-session-token$";
const AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue";
const TOKEN_URL = "https://api.devin.ai/auth/cli/token";
const MAX_INPUT_CHARS = 16_384;

export function getApiKey(): string | undefined {
	const value = process.env[ENV_KEY]?.trim();
	return value ? toApiKey(value) : undefined;
}

// A Devin session JWT gains its prefix; anything else (an already prefixed key) passes through.
export function toApiKey(token: string): string {
	const value = token.trim();
	return /^eyJ[\w-]*\.[\w-]*\.[\w-]*$/.test(value) ? `${SESSION_PREFIX}${value}` : value;
}

export function looksLikeToken(value: string): boolean {
	return value.startsWith(SESSION_PREFIX) || toApiKey(value) !== value;
}

export interface SignInAttempt {
	url: string;
	verifier: string;
}

// PKCE S256 without a redirect: Devin shows the code in the browser and the user pastes it back.
export function createSignIn(): SignInAttempt {
	const verifier = randomBytes(64).toString("base64url");
	const url = new URL(AUTHORIZE_URL);
	url.search = new URLSearchParams({
		state: randomBytes(32).toString("base64url"),
		prompt: "select_account",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
	}).toString();
	return { url: url.toString(), verifier };
}

export async function exchangeCode(
	attempt: SignInAttempt,
	input: string,
	fetcher: typeof fetch = fetch,
): Promise<string> {
	const code = input.trim();
	if (!code || code.length > MAX_INPUT_CHARS || /\s|[\x00-\x1f\x7f]/.test(code)) {
		throw new Error("That does not look like a Devin authorization code.");
	}
	let response: Response;
	try {
		response = await fetcher(TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ code, code_verifier: attempt.verifier }),
			redirect: "error",
			signal: AbortSignal.timeout(60_000),
		});
	} catch {
		throw new Error("Could not reach Devin. Check your network and run login again.");
	}
	if (!response.ok) {
		throw new Error(`Devin rejected the code (HTTP ${response.status}). Codes are one-time; run login again.`);
	}
	const token = ((await response.json().catch(() => undefined)) as { token?: unknown } | undefined)?.token;
	if (typeof token !== "string" || !token || token.length > MAX_INPUT_CHARS) {
		throw new Error("Devin returned no usable session token.");
	}
	return token;
}
