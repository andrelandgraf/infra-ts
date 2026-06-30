/**
 * `@infra-ts/sentry` — Sentry entities for infra-ts.
 *
 * `SentryTeam`, `SentryProject`, and `SentryClientKey` (emits `SENTRY_DSN`). Credentials resolve
 * from `SENTRY_AUTH_TOKEN`; each entity takes the Sentry `org` slug.
 */
export {
	SentryClientKey,
	SentryProject,
	SentryTeam,
	type SentryClientKeyOptions,
	type SentryProjectOptions,
	type SentryTeamOptions,
} from "./lib/entities.js";
