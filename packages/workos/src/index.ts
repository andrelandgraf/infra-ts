/**
 * `@infra-ts/workos` — WorkOS entities for infra-ts.
 *
 * `WorkosOrganization` (emits `WORKOS_ORGANIZATION_ID`). Credentials resolve from `WORKOS_API_KEY`.
 * SSO/Directory connections are created through the WorkOS portal at runtime, so they're out of
 * scope for config-as-code.
 */
export {
	WorkosOrganization,
	type WorkosOrganizationOptions,
} from "./lib/entities.js";
