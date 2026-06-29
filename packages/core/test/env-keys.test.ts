import { describe, expect, test } from "bun:test";
import { constantCase, osKeyFor } from "../src/lib/env-keys.js";

describe("constantCase", () => {
	test("camelCase → CONSTANT_CASE", () => {
		expect(constantCase("databaseUrl")).toBe("DATABASE_URL");
		expect(constantCase("databaseUrlUnpooled")).toBe("DATABASE_URL_UNPOOLED");
		expect(constantCase("upstashRedisRestUrl")).toBe("UPSTASH_REDIS_REST_URL");
		expect(constantCase("authJwksUrl")).toBe("AUTH_JWKS_URL");
	});
	test("handles digits", () => {
		expect(constantCase("s3Endpoint")).toBe("S3_ENDPOINT");
	});
	test("already-constant stays", () => {
		expect(constantCase("DATABASE_URL")).toBe("DATABASE_URL");
	});
});

describe("osKeyFor", () => {
	test("default uses constantCase", () => {
		expect(osKeyFor("databaseUrl")).toBe("DATABASE_URL");
	});
	test("envNames map overrides a specific key", () => {
		expect(
			osKeyFor("databaseUrl", { envNames: { databaseUrl: "MY_DB" } }),
		).toBe("MY_DB");
		// unspecified keys keep the default
		expect(osKeyFor("branch", { envNames: { databaseUrl: "MY_DB" } })).toBe(
			"BRANCH",
		);
	});
	test("envName callback overrides all", () => {
		expect(
			osKeyFor("databaseUrl", { envName: (k) => `APP_${constantCase(k)}` }),
		).toBe("APP_DATABASE_URL");
	});
});
