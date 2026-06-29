import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * Walk up from `startDir` looking for the first directory that contains any of `fileNames`.
 * Returns the absolute path to the found file, or `undefined` at the filesystem root.
 */
export function findUp(
	startDir: string,
	fileNames: string[],
): string | undefined {
	let dir = startDir;
	const { root } = parse(dir);
	while (true) {
		for (const name of fileNames) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
		if (dir === root) return undefined;
		dir = dirname(dir);
	}
}
