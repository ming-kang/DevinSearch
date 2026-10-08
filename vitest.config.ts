import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: { target: "node18" },
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 20_000,
	},
});
