import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, contentHash } from "../src/lib/deploy.js";

function fixture(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "vercel-deploy-"));
	writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
	mkdirSync(join(dir, "node_modules"));
	writeFileSync(join(dir, "node_modules", "junk.js"), "should be ignored");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("collectFiles", () => {
	test("walks files, sorts, skips default ignores", () => {
		const { dir, cleanup } = fixture();
		try {
			const files = collectFiles(dir);
			expect(files.map((f) => f.relpath)).toEqual([
				"assets/app.js",
				"index.html",
			]);
			expect(files.every((f) => /^[0-9a-f]{40}$/.test(f.sha1))).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("honors extra ignores", () => {
		const { dir, cleanup } = fixture();
		try {
			const files = collectFiles(dir, ["assets"]);
			expect(files.map((f) => f.relpath)).toEqual(["index.html"]);
		} finally {
			cleanup();
		}
	});
});

describe("contentHash", () => {
	test("is stable and changes with content", () => {
		const { dir, cleanup } = fixture();
		try {
			const a = contentHash(collectFiles(dir));
			expect(a).toBe(contentHash(collectFiles(dir)));
			writeFileSync(join(dir, "index.html"), "<h1>changed</h1>");
			expect(contentHash(collectFiles(dir))).not.toBe(a);
		} finally {
			cleanup();
		}
	});
});
