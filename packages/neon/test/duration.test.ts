import { describe, expect, test } from "bun:test";
import { InfraError } from "@infra-ts/core";
import { parseDurationSeconds } from "../src/lib/duration.js";

describe("parseDurationSeconds", () => {
	test("parses unit strings", () => {
		expect(parseDurationSeconds("30s")).toBe(30);
		expect(parseDurationSeconds("5m")).toBe(300);
		expect(parseDurationSeconds("1h")).toBe(3600);
		expect(parseDurationSeconds("7d")).toBe(604800);
		expect(parseDurationSeconds("2w")).toBe(1209600);
	});

	test("passes through positive numbers as seconds", () => {
		expect(parseDurationSeconds(300)).toBe(300);
	});

	test("rejects a bare numeric string (ambiguous)", () => {
		expect(() => parseDurationSeconds("7")).toThrow(InfraError);
	});

	test("rejects unknown units and non-positive numbers", () => {
		expect(() => parseDurationSeconds("5y")).toThrow(InfraError);
		expect(() => parseDurationSeconds(0)).toThrow(InfraError);
		expect(() => parseDurationSeconds(-5)).toThrow(InfraError);
	});
});
