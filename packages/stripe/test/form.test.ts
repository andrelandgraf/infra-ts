import { describe, expect, test } from "bun:test";
import { toForm } from "../src/lib/form.js";

describe("toForm (Stripe bracket notation)", () => {
	test("flat scalars", () => {
		expect(toForm({ name: "Pro", unit_amount: 1500 })).toEqual({
			name: "Pro",
			unit_amount: "1500",
		});
	});

	test("arrays use indexed brackets", () => {
		expect(toForm({ enabled_events: ["a", "b"] })).toEqual({
			"enabled_events[0]": "a",
			"enabled_events[1]": "b",
		});
	});

	test("nested objects use named brackets", () => {
		expect(
			toForm({ recurring: { interval: "month", interval_count: 1 } }),
		).toEqual({
			"recurring[interval]": "month",
			"recurring[interval_count]": "1",
		});
	});

	test("drops undefined / null", () => {
		expect(toForm({ a: "x", b: undefined, c: null })).toEqual({ a: "x" });
	});

	test("encodes round-trips through URLSearchParams", () => {
		const form = toForm({ url: "https://x.test/hook", enabled_events: ["*"] });
		const encoded = new URLSearchParams(form).toString();
		expect(encoded).toContain("url=https%3A%2F%2Fx.test%2Fhook");
		expect(encoded).toContain("enabled_events%5B0%5D=*");
	});
});
