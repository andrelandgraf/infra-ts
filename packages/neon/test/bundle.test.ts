import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { bundleFunction } from "../src/lib/bundle.js";

describe("bundleFunction", () => {
	test("bundles a TS entry into a zip containing index.mjs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "infra-ts-bundle-"));
		try {
			writeFileSync(
				join(dir, "hello.ts"),
				`export default { fetch: (req: Request) => new Response("hi") };`,
				"utf8",
			);
			const zip = await bundleFunction(join(dir, "hello.ts"));
			expect(zip.byteLength).toBeGreaterThan(0);
			const files = unzipSync(zip);
			expect(Object.keys(files)).toContain("index.mjs");
			const code = new TextDecoder().decode(files["index.mjs"]);
			expect(code).toContain("fetch");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("throws a clear error for a missing source file", async () => {
		await expect(
			bundleFunction("/nonexistent/does-not-exist.ts"),
		).rejects.toThrow();
	});
});
