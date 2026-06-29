import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Infra, osKeyFor } from "@infra-ts/core";

/** Project each entity's resolved logical env into flat OS-level `{ KEY: value }` pairs. */
export function toEntries(
	infra: Infra,
	envByEntity: Record<string, Record<string, string>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entity of infra.entities) {
		const logical = envByEntity[entity.name];
		if (!logical) continue;
		for (const field of entity.envKeys) {
			const value = logical[field];
			if (value === undefined) continue;
			out[osKeyFor(field, entity.envKeyOverride)] = value;
		}
	}
	return out;
}

/** Default env file for an environment: `.env.<environment>`. */
export function envFileFor(environment: string): string {
	return `.env.${environment}`;
}

/** Merge `entries` into `rootDir/relativeFile`, updating managed keys + appending new ones. */
export function writeEnvFile(
	rootDir: string,
	relativeFile: string,
	entries: Record<string, string>,
): string[] {
	const filePath = join(rootDir, relativeFile);
	const keys = Object.keys(entries);
	if (keys.length === 0) return [];
	const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
	const lines = existing.length > 0 ? existing.split("\n") : [];
	const remaining = new Set(keys);
	const updated = lines.map((line) => {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
		if (match && remaining.has(match[1] as string)) {
			const key = match[1] as string;
			remaining.delete(key);
			return `${key}=${formatValue(entries[key] as string)}`;
		}
		return line;
	});
	if (updated.length > 0 && updated[updated.length - 1] === "") updated.pop();
	for (const key of keys) {
		if (remaining.has(key))
			updated.push(`${key}=${formatValue(entries[key] as string)}`);
	}
	writeFileSync(filePath, `${updated.join("\n")}\n`, "utf8");
	return keys;
}

function formatValue(value: string): string {
	if (/[\s"'#]/.test(value)) {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}
