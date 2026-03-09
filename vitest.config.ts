import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["extensions/**/*.test.ts", "scripts/**/*.test.ts"],
		environment: "node",
		globals: false,
		testTimeout: 10_000,
	},
});
