/**
 * Flatten a nested object into Stripe's `application/x-www-form-urlencoded` bracket notation:
 * `{ enabled_events: ["a", "b"] }` → `{ "enabled_events[0]": "a", "enabled_events[1]": "b" }`,
 * `{ recurring: { interval: "month" } }` → `{ "recurring[interval]": "month" }`.
 * `undefined` / `null` values are dropped.
 */
export function toForm(
	obj: Record<string, unknown>,
	prefix = "",
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		const key = prefix ? `${prefix}[${k}]` : k;
		if (Array.isArray(v)) {
			v.forEach((item, i) => {
				const ak = `${key}[${i}]`;
				if (item && typeof item === "object") {
					Object.assign(out, toForm(item as Record<string, unknown>, ak));
				} else {
					out[ak] = String(item);
				}
			});
		} else if (typeof v === "object") {
			Object.assign(out, toForm(v as Record<string, unknown>, key));
		} else {
			out[key] = String(v);
		}
	}
	return out;
}
