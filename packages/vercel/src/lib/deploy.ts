import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Directory/file names never uploaded or hashed. */
const DEFAULT_IGNORE = new Set([
	"node_modules",
	".git",
	".vercel",
	".DS_Store",
	".infra",
	".env",
	".env.local",
]);

export interface DeployFile {
	/** Path relative to the source root (forward slashes). */
	relpath: string;
	abspath: string;
	/** sha1 hex digest of the file bytes (Vercel's upload key). */
	sha1: string;
	size: number;
}

/**
 * Walk a source directory into a stable, sorted file list with sha1 digests, skipping the default
 * ignore set plus any extra name segments. (A full `.vercelignore`/`.gitignore` parser is a future
 * refinement; name-based ignores cover the common cases.)
 */
export function collectFiles(
	root: string,
	extraIgnore: string[] = [],
): DeployFile[] {
	const ignore = new Set([...DEFAULT_IGNORE, ...extraIgnore]);
	const out: DeployFile[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (ignore.has(name)) continue;
			const abspath = join(dir, name);
			const st = statSync(abspath);
			if (st.isDirectory()) {
				walk(abspath);
			} else if (st.isFile()) {
				const bytes = readFileSync(abspath);
				out.push({
					relpath: relative(root, abspath).split("\\").join("/"),
					abspath,
					sha1: createHash("sha1").update(bytes).digest("hex"),
					size: st.size,
				});
			}
		}
	};
	walk(root);
	return out.sort((a, b) => a.relpath.localeCompare(b.relpath));
}

/** A deterministic digest of a file set — the content-hash idempotency key (SPEC §11.4). */
export function contentHash(files: DeployFile[]): string {
	const h = createHash("sha256");
	for (const f of files) h.update(`${f.relpath}:${f.sha1}\n`);
	return h.digest("hex");
}
