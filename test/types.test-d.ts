/**
 * Type-level regression suite (compiled by `tsc`, never executed). Asserts the v2 public type
 * surface: typed per-entity output refs, cross-entity wiring, provider option types, and the
 * `parseEnv` shape.
 */
import { defineInfra, parseEnv, type Ref } from "infra-ts";
import {
	NeonAccount,
	NeonAuth,
	NeonOrg,
	NeonPostgres,
	NeonProject,
	NeonReadReplica,
} from "infra-ts/neon";
import { VercelDeployment, VercelProject, VercelTeam } from "infra-ts/vercel";
import { UpstashRedis, UpstashVector } from "infra-ts/upstash";
import { ResendApiKey } from "infra-ts/resend";
import { MuxSigningKey } from "infra-ts/mux";
import { SentryClientKey, SentryProject } from "infra-ts/sentry";
import { WorkosOrganization } from "infra-ts/workos";
import { SanityDataset } from "infra-ts/sanity";
import { StatsigGate } from "infra-ts/statsig";
import { DubDomain } from "infra-ts/dub";
import { StripePrice, StripeWebhookEndpoint } from "infra-ts/stripe";
import {
	NeonPostgres as ProjectsNeonPostgres,
	StripeProjectsService,
	UpstashRedis as ProjectsUpstashRedis,
} from "infra-ts/stripe-projects";
import { PosthogProject } from "infra-ts/posthog";
import { ElevenLabsAgent } from "infra-ts/elevenlabs";
import { OpenAiServiceAccount } from "infra-ts/openai";

const account = new NeonAccount({ name: "personal" });
const neonOrg = new NeonOrg({ name: "work" });
const vercelTeam = new VercelTeam({ name: "vercel" });
const project = new NeonProject({
	name: "app",
	region: "aws-us-east-1",
	org: account.id, // account scope ref → org
	logicalReplication: true,
});
const db = new NeonPostgres({ name: "db", projectId: project.id });
const auth = new NeonAuth({ name: "auth", projectId: project.id });
const replica = new NeonReadReplica({
	name: "app-replica",
	projectId: project.id,
	compute: { minCu: 0.25, maxCu: 2 },
});
const replicaUrl: Ref<string> = replica.env.readReplicaUrl;

// Output refs are typed.
const pid: Ref<string> = project.id;
const dbUrl: Ref<string> = db.env.databaseUrl;
const jwks: Ref<string> = auth.env.authJwksUrl;

// Cross-entity wiring is typed (a Ref<string> is accepted as a Vercel env value).
const web = new VercelProject({
	name: "app",
	team: vercelTeam.id,
	framework: "nextjs",
	settings: { buildCommand: "next build", nodeVersion: "20.x" },
	env: {
		DATABASE_URL: db.env.databaseUrl,
		AUTH_JWKS_URL: auth.env.authJwksUrl,
	},
});
const deployment = new VercelDeployment({
	name: "web-deploy",
	team: vercelTeam.id,
	project: web.id,
	cwd: "./apps/web",
	production: true,
});
const deploymentUrl: Ref<string> = deployment.env.deploymentUrl;

const redis = new UpstashRedis({ name: "cache" });
const vector = new UpstashVector({ name: "vec", dimensionCount: 1536 });
const apiKey = new ResendApiKey({ name: "sending" });
const signingKey = new MuxSigningKey({ name: "mux-key" });

const redisUrl: Ref<string> = redis.env.upstashRedisRestUrl;
const vectorUrl: Ref<string> = vector.env.upstashVectorRestUrl;
const sendKey: Ref<string> = apiKey.env.resendSendingApiKey;
const muxKey: Ref<string> = signingKey.env.muxPrivateKey;

// ── new providers ──
const sentryProject = new SentryProject({
	name: "app",
	org: "acme",
	team: "core",
});
const dsn = new SentryClientKey({
	name: "app-dsn",
	org: "acme",
	project: sentryProject.id,
});
const sentryDsn: Ref<string> = dsn.env.sentryDsn;

const ph = new PosthogProject({ name: "analytics", org: "acme" });
const phKey: Ref<string> = ph.env.posthogKey;

const sa = new OpenAiServiceAccount({ name: "svc", project: "proj_123" });
const openaiKey: Ref<string> = sa.env.openaiApiKey;

const webhook = new StripeWebhookEndpoint({
	name: "hook",
	url: "https://example.com/stripe",
	events: ["checkout.session.completed"],
});
const whSecret: Ref<string> = webhook.env.stripeWebhookSecret;

// ── stripe-projects: entities provisioned through Stripe Projects ──
const projectsDb = new ProjectsNeonPostgres({ name: "db", tier: "launch" });
const projectsCache = new ProjectsUpstashRedis({ name: "cache" });
const projectsSearch = new StripeProjectsService({
	name: "search",
	provider: "algolia",
	service: "application",
	exposes: ["algoliaAppId", "algoliaApiKey"],
});
// Typed produced-env refs wire into any consumer, exactly like the REST providers.
const projectsDbUrl: Ref<string> = projectsDb.env.databaseUrl;
const projectsRedisTok: Ref<string> = projectsCache.env.redisRestToken;
const webWithProjects = new VercelProject({
	name: "web-projects",
	team: vercelTeam.id,
	env: { DATABASE_URL: projectsDb.env.databaseUrl },
});
// @ts-expect-error — `provider` is required on the generic service.
new StripeProjectsService({ name: "x", service: "application" });

const org = new WorkosOrganization({ name: "acme", domains: ["acme.com"] });
const dataset = new SanityDataset({ name: "production", projectId: "p1" });
const gate = new StatsigGate({ name: "new-checkout" });
const dubDomain = new DubDomain({ name: "go.acme.com" });
const agent = new ElevenLabsAgent({ name: "support", prompt: "be helpful" });

// @ts-expect-error — Sentry `org` is required.
new SentryProject({ name: "x", team: "core" });
new StripePrice({
	name: "x",
	product: "prod_1",
	currency: "usd",
	// @ts-expect-error — `unitAmount` must be a number.
	unitAmount: "10",
});

const infra = defineInfra({
	entities: [
		account,
		neonOrg,
		vercelTeam,
		project,
		db,
		auth,
		replica,
		deployment,
		web,
		redis,
		vector,
		apiKey,
		signingKey,
		sentryProject,
		dsn,
		ph,
		sa,
		webhook,
		org,
		dataset,
		gate,
		dubDomain,
		agent,
		projectsDb,
		projectsCache,
		projectsSearch,
		webWithProjects,
	],
});

// parseEnv resolves to the namespaced env record.
function checkParseEnv() {
	const env = parseEnv(infra);
	const ns: Record<string, string> | undefined = env.db;
	return ns;
}

// ── option-type enforcement ──
// @ts-expect-error — `name` and `org` are required.
new NeonProject({ region: "aws-us-east-1" });
// @ts-expect-error — `region` must be a string.
new NeonProject({ name: "x", org: neonOrg.id, region: 123 });
// @ts-expect-error — Neon `org` is required.
new NeonProject({ name: "x" });
new VercelProject({
	name: "x",
	team: vercelTeam.id,
	// @ts-expect-error — Vercel `nodeVersion` is a string, not a number.
	settings: { nodeVersion: 20 },
});
// @ts-expect-error — Vercel `team` is required.
new VercelProject({ name: "x" });

export {
	pid,
	dbUrl,
	jwks,
	replicaUrl,
	deploymentUrl,
	web,
	redisUrl,
	vectorUrl,
	sendKey,
	muxKey,
	sentryDsn,
	phKey,
	openaiKey,
	whSecret,
	org,
	dataset,
	gate,
	dubDomain,
	agent,
	projectsDbUrl,
	projectsRedisTok,
	webWithProjects,
	infra,
	checkParseEnv,
};
