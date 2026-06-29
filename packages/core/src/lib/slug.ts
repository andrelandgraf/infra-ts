/** Options for {@link slugify}. */
export interface SlugifyOptions {
	/** Maximum length of the produced slug. Default `63` (a safe DNS-label limit). */
	maxLength?: number;
	/** Keep `/` as `-` separators when `false` (the default flattens to a single token). */
	preserveSlashes?: boolean;
	/** Fallback slug when the input reduces to empty. Default `"resource"`. */
	fallback?: string;
}

/**
 * Derive a stable, URL/DNS-safe slug from an arbitrary string (e.g. a git branch like
 * `feat/Add Billing` → `feat-add-billing`). Shared by providers and the git → infra-ts branch
 * mapping so the same input always yields the same resource name. Lowercases, replaces runs of
 * non-alphanumerics with a single `-`, trims leading/trailing `-`, and caps the length.
 */
export function slugify(input: string, options: SlugifyOptions = {}): string {
	const maxLength = options.maxLength ?? 63;
	const fallback = options.fallback ?? "resource";
	const slashReplacement = options.preserveSlashes ? "/" : "-";

	const normalized = input
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\//g, options.preserveSlashes ? "\u0000" : "-")
		.replace(/[^a-z0-9\u0000]+/g, "-")
		.replace(/\u0000/g, slashReplacement)
		.replace(/-+/g, "-")
		.replace(/^[-/]+|[-/]+$/g, "");

	const sliced = normalized.slice(0, maxLength).replace(/[-/]+$/g, "");
	return sliced.length > 0 ? sliced : fallback;
}
