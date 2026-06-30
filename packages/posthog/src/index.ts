/**
 * `@infra-ts/posthog` — PostHog entities for infra-ts.
 *
 * `PosthogProject` (emits `POSTHOG_KEY` + `POSTHOG_HOST`) and `PosthogFeatureFlag`. Credentials
 * resolve from `POSTHOG_API_KEY` (a personal API key). Set `apiHost` / `POSTHOG_API_HOST` for EU
 * or self-hosted instances.
 */
export {
	PosthogFeatureFlag,
	PosthogProject,
	type PosthogFeatureFlagOptions,
	type PosthogProjectOptions,
} from "./lib/entities.js";
