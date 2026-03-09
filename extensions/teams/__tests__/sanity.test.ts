import { describe, it, expect } from "vitest";
import { sanitizeName } from "../names.js";

describe("sanity check", () => {
	it("sanitizeName strips unsafe characters", () => {
		expect(sanitizeName("hello world!")).toBe("hello-world-");
	});

	it("sanitizeName preserves safe characters", () => {
		expect(sanitizeName("agent-1_test")).toBe("agent-1_test");
	});
});
