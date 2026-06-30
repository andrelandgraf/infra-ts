/**
 * `@infra-ts/stripe` — Stripe entities for infra-ts.
 *
 * `StripeWebhookEndpoint` (write-once `STRIPE_WEBHOOK_SECRET`), `StripeProduct`, and `StripePrice`.
 * Credentials resolve from `STRIPE_SECRET_KEY`. Bodies are form-encoded per the Stripe API.
 */
export {
	StripePrice,
	StripeProduct,
	StripeWebhookEndpoint,
	type StripePriceOptions,
	type StripeProductOptions,
	type StripeWebhookEndpointOptions,
} from "./lib/entities.js";
export { toForm } from "./lib/form.js";
