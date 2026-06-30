import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
				env: {
					...process.env,
					FORCE_COLOR: "0",
					npm_config_before: "2026-07-01T00:00:00.000Z",
				},
				encoding: "utf8",
				timeout: 120_000,
			});

			expect(result.status).toBe(0);
			expect(result.stderr).not.toContain("Received undefined");

			const target = join(dir, "infra.ts");
			expect(existsSync(target)).toBe(true);
			const config = readFileSync(target, "utf8");
			expect(config).toContain("defineInfra");
			expect(config).toContain('name: "my-app-neon"');
			expect(config).toContain('name: "my-app-vercel"');

			const packageJson = JSON.parse(
				readFileSync(join(dir, "package.json"), "utf8"),
			);
			expect(packageJson.devDependencies["infra-ts"]).toBeString();

			const loginResult = spawnSync(process.execPath, [cliPath, "login"], {
				cwd: dir,
				env: { ...process.env, FORCE_COLOR: "0" },
				encoding: "utf8",
				timeout: 120_000,
			});
			expect(loginResult.status).toBe(0);
			expect(loginResult.stderr).not.toContain("Duplicate entity id");
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	test("leaves an existing infra.ts untouched and updates infra-ts", () => {
		const dir = mkdtempSync(join(tmpdir(), "infra-ts-init-existing-config-"));
		try {
			const originalConfig = "export default { custom: true };\n";
			writeFileSync(join(dir, "infra.ts"), originalConfig, "utf8");
			writeFileSync(
				join(dir, "package.json"),
				`${JSON.stringify(
					{
						name: "existing-config",
						private: true,
						devDependencies: { "infra-ts": "0.0.0" },
					},
					null,
					"\t",
				)}\n`,
				"utf8",
			);

			const result = spawnSync(process.execPath, [cliPath, "init"], {
				cwd: dir,
				env: {
					...process.env,
					FORCE_COLOR: "0",
					npm_config_before: "2026-07-01T00:00:00.000Z",
				},
				encoding: "utf8",
				timeout: 120_000,
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("leaving it unchanged");
			expect(readFileSync(join(dir, "infra.ts"), "utf8")).toBe(originalConfig);

			const packageJson = JSON.parse(
				readFileSync(join(dir, "package.json"), "utf8"),
			);
			expect(packageJson.devDependencies["infra-ts"]).not.toBe("0.0.0");
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	test("does not create infra.ts when package.json already depends on infra-ts", () => {
		const dir = mkdtempSync(join(tmpdir(), "infra-ts-init-existing-package-"));
		try {
			writeFileSync(
				join(dir, "package.json"),
				`${JSON.stringify(
					{
						name: "existing-package",
						private: true,
						dependencies: { "infra-ts": "0.0.0" },
					},
					null,
					"\t",
				)}\n`,
				"utf8",
			);

			const result = spawnSync(process.execPath, [cliPath, "init"], {
				cwd: dir,
				env: {
					...process.env,
					FORCE_COLOR: "0",
					npm_config_before: "2026-07-01T00:00:00.000Z",
				},
				encoding: "utf8",
				timeout: 120_000,
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("already depends on infra-ts");
			expect(existsSync(join(dir, "infra.ts"))).toBe(false);

			const packageJson = JSON.parse(
				readFileSync(join(dir, "package.json"), "utf8"),
			);
			const installedVersion =
				packageJson.devDependencies?.["infra-ts"] ??
				packageJson.dependencies?.["infra-ts"];
			expect(installedVersion).toBeString();
			expect(installedVersion).not.toBe("0.0.0");
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});
