import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as {
	version?: unknown;
	repository?: { url?: unknown };
};

export const SERVER_VERSION = typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";

/** Repository page. npm stores a git+ URL; MCP wants the page. */
export const SERVER_WEBSITE =
	typeof pkg.repository?.url === "string" ? pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "") : "";
