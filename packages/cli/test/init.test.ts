import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("init command", () => {
	test("creates an infra.ts scaffold in the current directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "infra-ts-init-"));
		try {
			const result = spawnSync(process.execPath, [cliPath, "init"], {
				cwd: dir,
				env: { ...process.env, FORCE_COLOR: "0" },
				encoding: "utf8",
			});

			expect(result.status).toBe(0);
			expect(result.stderr).not.toContain("Received undefined");

			const target = join(dir, "infra.ts");
			expect(existsSync(target)).toBe(true);
			expect(readFileSync(target, "utf8")).toContain("defineInfra");
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});
