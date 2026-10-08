import { createInterface } from "node:readline";
import { openBrowser } from "./browser.ts";
import { createSignIn, exchangeCode, looksLikeToken, toApiKey } from "./credential.ts";
import { DevinError, webSearch } from "./devin.ts";

export interface LoginHooks {
	open?: (url: string) => void;
	ask?: (prompt: string) => Promise<string>;
	print?: (message: string) => void;
}

export async function login(hooks: LoginHooks = {}): Promise<void> {
	const open = hooks.open ?? openBrowser;
	const ask = hooks.ask ?? askStdin;
	const print = hooks.print ?? ((message) => console.log(message));

	const attempt = createSignIn();
	print("\nOpening Devin's sign-in page in your browser…");
	print(`If it does not open, visit:\n\n  ${attempt.url}\n`);
	open(attempt.url);

	const input = (await ask("Paste the code (or a token) Devin shows you: ")).trim();
	const apiKey = toApiKey(looksLikeToken(input) ? input : await exchangeCode(attempt, input));

	try {
		await webSearch(apiKey, "Devin", 1);
		print("\nVerified with Devin.");
	} catch (error) {
		if (!(error instanceof DevinError)) throw error;
		print(`\nWarning: ${error.message} The key was still minted; paste it and try a search.`);
	}

	print("\nPaste this as SEARCH_KEY in your MCP client config:\n");
	print(`  ${apiKey}\n`);
	print("The server reads it from the client's env on every call and stores nothing on disk.");
}

function askStdin(question: string): Promise<string> {
	return new Promise((resolveAsk) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		let answered = false;
		rl.question(question, (answer: string) => {
			answered = true;
			rl.close();
			resolveAsk(answer);
		});
		rl.on("close", () => {
			if (!answered) resolveAsk("");
		});
	});
}
