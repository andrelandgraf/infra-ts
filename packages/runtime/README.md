# @infra-ts/runtime

The [infra-ts](https://github.com/neon-solutions/infra-ts) engine (imperative shell). Loads
`infra.ts` (via jiti), reads/writes the `.infra` link file, and runs the core operations
across providers: `plan`, `apply`, `destroy`, `status`, `pullEnv`, `parseEnv`, plus the
git-driven `gitSync` flow and the lifecycle-hook runner.

```ts
import {
	loadConfig,
	apply,
	plan,
	destroy,
	status,
	pullEnv,
} from "@infra-ts/runtime";

const { config, rootDir } = await loadConfig();
await apply(config, { rootDir });
```

Everything the `infra-ts` CLI does is a function here. See the
[monorepo README → SDK reference](https://github.com/neon-solutions/infra-ts#sdk-reference).
