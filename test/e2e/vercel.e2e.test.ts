/**
 * Live Vercel e2e — gated behind INFRA_E2E=1 (skipped by `bun test`; run via `bun run test:e2e`).
 * Provisions a throwaway Vercel project (settings + an env var + an Edge Config) against the real
 * API and tears it down in afterAll. Credentials resolve from VERCEL_TOKEN or the vercel CLI cache.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineInfra } from "@infra-ts/core";
import { apply, checkout, destroy, status } from "@infra-ts/runtime";
import { VercelEdgeConfig, VercelProject } from "@infra-ts/vercel";

const RUN = process.env.INFRA_E2E === "1";
const suffix = `${Date.now().toString(36)}`;
const dir = mkdtempSync(join(tmpdir(), "infra-ts-e2e-vercel-"));
const team = process.env.VERCEL_TEAM ?? "team_e2e_required";

const project = new VercelProject({
	name: `infra-ts-e2e-${suffix}`,
	team,
	framework: "nextjs",
	settings: { buildCommand: "next build", nodeVersion: "20.x" },
	env: { FOO: "bar" },
});
const edge = new VercelEdgeConfig({
	name: `edge-${suffix}`,
	team,
	slug: `infra-ts-e2e-${suffix}`,
	items: { greeting: "hello" },
});
const infra = defineInfra({ entities: [project, edge] });
const env = { rootDir: dir, environment: "test" } as const;

describe.skipIf(!RUN)("vercel e2e", () => {
	afterAll(async () => {
		try {
			await destroy(infra, env);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("apply creates the project + edge config", async () => {
		const report = await apply(infra, env);
		expect(
			report.changes.find((c) => c.identifier === project.name)?.action,
		).toBe("create");
		expect(report.env[project.name]?.projectId).toBeTruthy();
	}, 120_000);

	test("status reports existence; apply is idempotent", async () => {
		const s = await status(infra, env);
		expect(s.entities.every((e) => e.exists)).toBe(true);
		const second = await apply(infra, env);
		expect(second.changes.every((c) => c.action === "noop")).toBe(true);
	}, 120_000);

	test("checkout pulls live env without drift", async () => {
		const report = await checkout(infra, env);
		expect(report.drift).toHaveLength(0);
	}, 120_000);
});
