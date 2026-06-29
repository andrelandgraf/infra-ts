# infra-ts

Typed, live-reconciled infrastructure & config as code (no attribute state). Declare your providers in an `infra.ts` file
and `plan`/`apply` them against live REST APIs — no state backend, just TypeScript.

```bash
npx infra-ts init
npx infra-ts plan
npx infra-ts apply
```

This is the batteries-included package: it ships the `infra-ts` CLI, the SDK (re-exports
`@infra-ts/core` + `@infra-ts/runtime`), and the bundled providers at `infra-ts/neon` and
`infra-ts/vercel`.

```ts
import { defineConfig } from "infra-ts";
import { neon } from "infra-ts/neon";
import { vercel } from "infra-ts/vercel";

const db = neon({ project: { name: "my-app" } });
export default defineConfig({
	providers: [
		db,
		vercel({
			project: { name: "my-app" },
			env: { DATABASE_URL: db.outputs.databaseUrl },
		}),
	],
});
```

See the [monorepo README](https://github.com/neon-solutions/infra-ts) for the full CLI and
SDK reference.
