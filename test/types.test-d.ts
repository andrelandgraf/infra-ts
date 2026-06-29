/**
 * Type-level regression suite (compiled by `tsc`, never executed). Asserts the v2 public type
 * surface: typed per-entity output refs, cross-entity wiring, provider option types, and the
 * `parseEnv` shape.
 */
import { defineInfra, parseEnv, type Ref } from "infra-ts";
import { NeonAuth, NeonPostgres, NeonProject } from "infra-ts/neon";
import { VercelProject } from "infra-ts/vercel";
import { UpstashRedis, UpstashVector } from "infra-ts/upstash";
import { ResendApiKey } from "infra-ts/resend";
import { MuxSigningKey } from "infra-ts/mux";

const project = new NeonProject({ name: "app", region: "aws-us-east-1" });
const db = new NeonPostgres({ name: "db", projectId: project.id });
const auth = new NeonAuth({ name: "auth", projectId: project.id });

// Output refs are typed.
const pid: Ref<string> = project.id;
const dbUrl: Ref<string> = db.env.databaseUrl;
const jwks: Ref<string> = auth.env.authJwksUrl;

// Cross-entity wiring is typed (a Ref<string> is accepted as a Vercel env value).
const web = new VercelProject({
	name: "app",
	framework: "nextjs",
	settings: { buildCommand: "next build", nodeVersion: "20.x" },
	env: {
		DATABASE_URL: db.env.databaseUrl,
		AUTH_JWKS_URL: auth.env.authJwksUrl,
	},
});

const redis = new UpstashRedis({ name: "cache" });
const vector = new UpstashVector({ name: "vec", dimensionCount: 1536 });
const apiKey = new ResendApiKey({ name: "sending" });
const signingKey = new MuxSigningKey({ name: "mux-key" });

const redisUrl: Ref<string> = redis.env.upstashRedisRestUrl;
const vectorUrl: Ref<string> = vector.env.upstashVectorRestUrl;
const sendKey: Ref<string> = apiKey.env.resendSendingApiKey;
const muxKey: Ref<string> = signingKey.env.muxPrivateKey;

const infra = defineInfra({
	entities: [project, db, auth, web, redis, vector, apiKey, signingKey],
});

// parseEnv resolves to the namespaced env record.
function checkParseEnv() {
	const env = parseEnv(infra);
	const ns: Record<string, string> | undefined = env.db;
	return ns;
}

// ── option-type enforcement ──
// @ts-expect-error — `name` is required.
new NeonProject({ region: "aws-us-east-1" });
// @ts-expect-error — `region` must be a string.
new NeonProject({ name: "x", region: 123 });
// @ts-expect-error — Vercel `nodeVersion` is a string, not a number.
new VercelProject({ name: "x", settings: { nodeVersion: 20 } });

export {
	pid,
	dbUrl,
	jwks,
	web,
	redisUrl,
	vectorUrl,
	sendKey,
	muxKey,
	infra,
	checkParseEnv,
};
