import { ErrorCode, InfraError } from "@infra-ts/core";

const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86400,
	w: 604800,
};

/**
 * Parse a duration into whole seconds. Accepts a number (already seconds) or a
 * `<integer><unit>` string where unit is `s` / `m` / `h` / `d` / `w` (e.g. `"7d"`, `"5m"`).
 * A bare numeric string like `"7"` is rejected — pass a number for raw seconds. Throws
 * {@link InfraError} (`InvalidConfig`) on an invalid value.
 */
export function parseDurationSeconds(value: string | number): number {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value <= 0) {
			throw new InfraError(
				ErrorCode.InvalidConfig,
				`Invalid duration: ${value}. Expected a positive number of seconds.`,
			);
		}
		return Math.round(value);
	}
	const match = /^(\d+)([smhdw])$/.exec(value.trim());
	if (!match) {
		throw new InfraError(
			ErrorCode.InvalidConfig,
			`Invalid duration string: ${JSON.stringify(value)}. Use <integer><unit> with unit s/m/h/d/w (e.g. "7d"), or a number of seconds.`,
		);
	}
	const amount = Number.parseInt(match[1] as string, 10);
	const unit = match[2] as string;
	return amount * (UNIT_SECONDS[unit] as number);
}
