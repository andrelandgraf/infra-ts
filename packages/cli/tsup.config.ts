import { defineConfig } from "tsup";

/**
 * The `infra-ts` package is the batteries-included entry point users install, so its build bundles
 * the workspace `@infra-ts/*` packages into the output (a self-contained binary + SDK that runs
 * under `npx`/`bunx` with no workspace resolution). Real third-party deps (chalk, commander,
 * jiti) stay external and are declared in `dependencies`.
 */
export default defineConfig({
	entry: {
		index: "src/index.ts",
		neon: "src/neon.ts",
		vercel: "src/vercel.ts",
		upstash: "src/upstash.ts",
		resend: "src/resend.ts",
		mux: "src/mux.ts",
		sentry: "src/sentry.ts",
		workos: "src/workos.ts",
		sanity: "src/sanity.ts",
		statsig: "src/statsig.ts",
		dub: "src/dub.ts",
		stripe: "src/stripe.ts",
		posthog: "src/posthog.ts",
		elevenlabs: "src/elevenlabs.ts",
		openai: "src/openai.ts",
		cli: "src/cli.ts",
	},
	format: ["esm"],
	dts: true,
	clean: true,
	sourcemap: true,
	noExternal: [/^@infra-ts\//],
	external: ["chalk", "commander", "jiti", "esbuild", "fflate"],
	tsconfig: "tsconfig.build.json",
});
