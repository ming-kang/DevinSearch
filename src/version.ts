import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const SERVER_VERSION: string =
	((require("../package.json") as { version?: unknown }).version as string | undefined) ?? "0.0.0";
