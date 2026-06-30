import { ErrorCode, InfraError } from "./errors.js";
import type { Ref } from "./ref.js";

/** An OS-keyed env map: literal values or deferred refs (what a consumer's `env` accepts). */
export type EnvInput = Record<string, string | Ref<string>>;

/**
 * Merge OS-keyed env maps and **throw on any overlapping key**. The loud alternative to a plain
 * object spread (`{ ...a, ...b }`), which silently last-wins. Use with `entity.toEnv()`:
 *
 * ```ts
 * env: mergeEnv(db.toEnv(), analytics.toEnv()); // throws if both define DATABASE_URL
 * ```
 */
export function mergeEnv(...maps: EnvInput[]): EnvInput {
	const out: EnvInput = {};
	const owner: Record<string, number> = {};
	maps.forEach((map, index) => {
		for (const [key, value] of Object.entries(map)) {
			if (key in out) {
				throw new InfraError(
					ErrorCode.EnvCollision,
					`mergeEnv: duplicate env key "${key}" (from input #${owner[key]} and #${index}). Rename one (e.g. envNames) or drop it from the merge.`,
					{ details: { key } },
				);
			}
			out[key] = value;
			owner[key] = index;
		}
	});
	return out;
}
