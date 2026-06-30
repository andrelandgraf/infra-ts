/**
 * `@infra-ts/dub` — Dub entities for infra-ts.
 *
 * `DubDomain`, `DubTag`, and `DubLink` (emits `DUB_SHORT_LINK`). Credentials resolve from
 * `DUB_API_KEY`.
 */
export {
	DubDomain,
	DubLink,
	DubTag,
	type DubDomainOptions,
	type DubLinkOptions,
	type DubTagOptions,
} from "./lib/entities.js";
