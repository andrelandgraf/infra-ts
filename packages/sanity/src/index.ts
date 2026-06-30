/**
 * `@infra-ts/sanity` — Sanity entities for infra-ts.
 *
 * `SanityDataset` (emits `SANITY_DATASET`), `SanityToken` (write-once `SANITY_API_TOKEN`), and
 * `SanityCorsOrigin`. Credentials resolve from `SANITY_AUTH_TOKEN`; each entity takes a `projectId`.
 */
export {
	SanityCorsOrigin,
	SanityDataset,
	SanityToken,
	type SanityCorsOriginOptions,
	type SanityDatasetOptions,
	type SanityTokenOptions,
} from "./lib/entities.js";
