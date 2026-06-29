import { basename } from "node:path";
import { ErrorCode, InfraError } from "@infra-ts/core";

/**
 * Re-creates `require` / `__filename` / `__dirname` in the ESM output so bundled CommonJS
 * dependencies that call `require(...)` work inside the single `index.mjs` (matches neon.ts).
 */
const ESM_CJS_INTEROP_BANNER =
	"import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'url';import{dirname as ___d}from'path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);";

/**
 * Build the deployable ZIP bundle for a Neon Function: esbuild-bundle the entry to a single
 * minified `index.mjs` (Node built-ins external, deps inlined), then zip it. esbuild + fflate
 * are dynamically imported so a config that never deploys a function never loads them.
 *
 * Mirrors `@neondatabase/config-runtime`'s `buildFunctionBundle`.
 */
export async function bundleFunction(source: string): Promise<Uint8Array> {
	const esbuild = await loadEsbuild();
	let result: Awaited<ReturnType<typeof esbuild.build>>;
	try {
		result = await esbuild.build({
			entryPoints: [source],
			bundle: true,
			write: false,
			outfile: "index.mjs",
			minify: true,
			format: "esm",
			platform: "node",
			banner: { js: ESM_CJS_INTEROP_BANNER },
			logLevel: "silent",
		});
	} catch (cause) {
		throw new InfraError(
			ErrorCode.InvalidConfig,
			`Failed to bundle function from ${source}: ${(cause as Error)?.message ?? String(cause)}`,
			{ cause },
		);
	}
	const entries: Record<string, Uint8Array> = {};
	for (const file of result.outputFiles ?? []) {
		entries[basename(file.path)] = file.contents;
	}
	const { zipSync } = await loadFflate();
	return zipSync(entries, { level: 6 });
}

async function loadEsbuild(): Promise<typeof import("esbuild")> {
	try {
		return await import("esbuild");
	} catch (cause) {
		throw new InfraError(
			ErrorCode.InvalidConfig,
			"Deploying Neon Functions requires `esbuild`. Reinstall dependencies (it ships with @infra-ts/neon).",
			{ cause },
		);
	}
}

async function loadFflate(): Promise<typeof import("fflate")> {
	try {
		return await import("fflate");
	} catch (cause) {
		throw new InfraError(
			ErrorCode.InvalidConfig,
			"Deploying Neon Functions requires `fflate`. Reinstall dependencies (it ships with @infra-ts/neon).",
			{ cause },
		);
	}
}
