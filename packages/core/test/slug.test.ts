import { describe, expect, test } from "bun:test";
import { slugify } from "../src/lib/slug.js";

describe("slugify", () => {
	test("lowercases and replaces non-alphanumerics with a single dash", () => {
		expect(slugify("Feat: Add Billing")).toBe("feat-add-billing");
	});

	test("flattens slashes by default", () => {
		expect(slugify("feature/add-search")).toBe("feature-add-search");
	});

	test("keeps slashes when preserveSlashes is true", () => {
		expect(slugify("feature/add-search", { preserveSlashes: true })).toBe(
			"feature/add-search",
		);
	});

	test("trims leading/trailing separators", () => {
		expect(slugify("--Hello--")).toBe("hello");
	});

	test("strips diacritics", () => {
		expect(slugify("Café Münchën")).toBe("cafe-munchen");
	});

	test("caps the length and trims a trailing dash", () => {
		const out = slugify("a".repeat(100), { maxLength: 10 });
		expect(out.length).toBeLessThanOrEqual(10);
	});

	test("falls back when input reduces to empty", () => {
		expect(slugify("!!!", { fallback: "branch" })).toBe("branch");
	});

	test("is stable: same input → same output", () => {
		expect(slugify("My Cool Branch")).toBe(slugify("My Cool Branch"));
	});
});
