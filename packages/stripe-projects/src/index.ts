/**
 * `@infra-ts/stripe-projects` — declare infrastructure that **Stripe Projects** provisions across
 * providers, instead of going to each provider directly.
 *
 * These entities compose the Stripe CLI (`stripe projects …`) rather than a REST API: identity is
 * the declared entity `name`, live truth comes from `stripe projects status`, and nothing is
 * persisted to `.infra` (Stripe Projects' own `.projects/` manifest stays its own business). Auth
 * is the local Stripe CLI session, so no infra-ts credentials are needed.
 */
export {
	StripeProjectsEntity,
	StripeProjectsService,
	NeonPostgres,
	UpstashRedis,
	type StripeProjectsResource,
	type StripeProjectsServiceOptions,
	type NeonPostgresOptions,
	type UpstashRedisOptions,
} from "./lib/entities.js";
