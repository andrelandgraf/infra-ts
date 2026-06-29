import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineInfra } from "@infra-ts/core";
import { envFileFor, toEntries, writeEnvFile } from "../src/lib/dotenv.js";
import { FakeEntity, tempDir } from "./helpers.js";

const infra = defineInfra({
	entities: [
		new FakeEntity({ name: "a" }),
		new FakeEntity({ name: "b", envNames: { value: "B_VALUE" } }),
	],
});

describe("toEntries", () => {
	test("projects each entity's env to OS keys (with renames)", () => {
		expect(toEntries(infra, { a: { value: "x" }, b: { value: "y" } })).toEqual({
			VALUE: "x",
			B_VALUE: "y",
		});
	});
});

describe("envFileFor", () => {
	test("is .env.<environment>", () => {
		expect(envFileFor("production")).toBe(".env.production");
		expect(envFileFor("local")).toBe(".env.local");
	});
});

describe("writeEnvFile", () => {
	test("merges managed keys, preserving other lines; idempotent", () => {
		const { dir, cleanup } = tempDir();
		try {
			writeFileSync(
				join(dir, ".env.test"),
				"# hi\nOTHER=keep\nVALUE=old\n",
				"utf8",
			);
			writeEnvFile(dir, ".env.test", { VALUE: "new" });
			const out = readFileSync(join(dir, ".env.test"), "utf8");
			expect(out).toContain("# hi");
			expect(out).toContain("OTHER=keep");
			expect(out).toContain("VALUE=new");
			expect(out).not.toContain("VALUE=old");
			writeEnvFile(dir, ".env.test", { VALUE: "new" });
			const again = readFileSync(join(dir, ".env.test"), "utf8");
			expect(again.match(/VALUE=new/g)).toHaveLength(1);
		} finally {
			cleanup();
		}
	});
});
