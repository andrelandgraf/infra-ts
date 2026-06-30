/**
 * Live Neon e2e — gated behind INFRA_E2E=1 (skipped by `bun test`; run via `bun run test:e2e`).
 * Provisions a throwaway Neon project (Postgres + Neon Auth) against the real API and tears it
 * down in afterAll. Credentials resolve from NEON_API_KEY or the authenticated neon CLI cache.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineInfra } from "@infra-ts/core";
import { apply, checkout, destroy, status } from "@infra-ts/runtime";
import { NeonAuth, NeonPostgres, NeonProject } from "@infra-ts/neon";

const RUN = process.env.INFRA_E2E === "1";
const suffix = `${Date.now().toString(36)}`;
const dir = mkdtempSync(join(tmpdir(), "infra-ts-e2e-neon-"));

const project = new NeonProject({
	name: `infra-ts-e2e-${suffix}`,
	region: "aws-us-east-1",
	org: process.env.NEON_ORG_ID ?? "org_e2e_required",
	compute: { minCu: 0.25, maxCu: 1, suspendTimeout: "5m" },
});
const db = new NeonPostgres({ name: `db-${suffix}`, projectId: project.id });
const auth = new NeonAuth({ name: `auth-${suffix}`, projectId: project.id });
const infra = defineInfra({ entities: [project, db, auth] });
const env = { rootDir: dir, environment: "test" } as const;

describe.skipIf(!RUN)("neon e2e", () => {
	afterAll(async () => {
		try {
			await destroy(infra, env);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("apply provisions project + db + auth and writes the env file", async () => {
		const report = await apply(infra, env);
		expect(
			report.changes.find((c) => c.identifier === project.name)?.action,
		).toBe("create");
		const dotenv = readFileSync(join(dir, ".env.test"), "utf8");
		expect(dotenv).toContain("DATABASE_URL=postgres");
	}, 180_000);

	test("status reports every entity exists; apply is idempotent", async () => {
		const s = await status(infra, env);
		expect(s.entities.every((e) => e.exists)).toBe(true);
		const second = await apply(infra, env);
		expect(second.changes.every((c) => c.action === "noop")).toBe(true);
	}, 120_000);

	test("checkout pulls live env with no drift", async () => {
		const report = await checkout(infra, env);
		expect(report.drift).toHaveLength(0);
		expect(report.env[db.name]?.databaseUrl).toContain("postgres");
	}, 120_000);
});
