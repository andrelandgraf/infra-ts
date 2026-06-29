# @infra-ts/core

The [infra-ts](https://github.com/neon-solutions/infra-ts) open standard: the `Provider`
contract every provider implements, plus `defineConfig`, the typed-env mapping (`InfraEnv`),
output references (`Ref`), the `.infra` link-file shape, lifecycle-hook types, a small REST
client, errors, and logging.

Runtime-free (no filesystem, no child processes) so it's the only dependency a provider needs.

```ts
import {
	defineConfig,
	type Provider,
	createRestClient,
	makeRefs,
} from "@infra-ts/core";
```

See the [monorepo README → Authoring a provider](https://github.com/neon-solutions/infra-ts#authoring-a-provider).
