/**
 * `@infra-ts/resend` — Resend entities for infra-ts.
 *
 * `ResendDomain`, `ResendApiKey` (write-once token, reused from env on checkout), and
 * `ResendAudience`. Credentials resolve from `RESEND_API_KEY`.
 */
export {
	ResendApiKey,
	ResendAudience,
	ResendDomain,
	ResendWebhook,
	type ResendApiKeyOptions,
	type ResendAudienceOptions,
	type ResendDomainOptions,
	type ResendWebhookOptions,
} from "./lib/entities.js";
