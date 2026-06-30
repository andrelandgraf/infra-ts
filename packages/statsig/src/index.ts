/**
 * `@infra-ts/statsig` — Statsig entities for infra-ts.
 *
 * `StatsigGate`, `StatsigDynamicConfig`, and `StatsigExperiment` (Console API). Credentials
 * resolve from `STATSIG_CONSOLE_API_KEY` (sent as the `STATSIG-API-KEY` header).
 */
export {
	StatsigDynamicConfig,
	StatsigExperiment,
	StatsigGate,
	type StatsigResource,
	type StatsigResourceOptions,
} from "./lib/entities.js";
