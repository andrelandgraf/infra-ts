import { defineInfra } from "infra-ts";
import { NeonPostgres, NeonProject } from "infra-ts/neon";
import { VercelProject } from "infra-ts/vercel";

/**
 * Example infra-ts config (v2, Entity model): a Neon project + Postgres whose connection string
 * is wired into a Vercel project's env — fully typed, no attribute state, just TypeScript.
 */
const project = new NeonProject({
	name: "infra-ts-example",
	region: "aws-us-east-1",
	compute: { minCu: 0.25, maxCu: 1, suspendTimeout: "5m" },
});

const db = new NeonPostgres({
	name: "infra-ts-example-db",
	projectId: project.id,
});

export default defineInfra({
	entities: [
		project,
		db,
		new VercelProject({
			name: "infra-ts-example",
			framework: "nextjs",
			settings: { buildCommand: "next build", nodeVersion: "20.x" },
			// Typed cross-entity wiring: spread Neon's whole env (DATABASE_URL,
			// DATABASE_URL_UNPOOLED) into Vercel. The refs also create the dependency edge.
			env: { ...db.toEnv() },
		}),
	],
});
