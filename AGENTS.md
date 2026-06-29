# AGENTS.md — infra-ts

infra-ts is a typed, live-reconciled, open standard for infrastructure & config as code (no
attribute state — only identity state). This is a Bun
workspaces monorepo.

## Layout

- `packages/core` (`@infra-ts/core`) — the open standard: `Provider` contract, `defineConfig`,
  `InfraEnv`, `Ref`, state shape, REST client, errors. **Pure** (no fs, no child processes).
- `packages/runtime` (`@infra-ts/runtime`) — the engine (imperative shell): config loading, `.infra`
  I/O, `plan`/`apply`/`destroy`/`status`/`pullEnv`/`parseEnv`, hooks runner, git workflow.
- `packages/neon`, `packages/vercel` — providers (thin REST wrappers).
- `packages/cli` (`infra-ts`) — the CLI + umbrella SDK; bundles the providers.

## Architecture rules

- **Functional core, imperative shell.** Keep `@infra-ts/core` pure. All I/O lives in `@infra-ts/runtime`
  and the providers.
- **Everything in the CLI is also an SDK function.** Add the function to `@infra-ts/runtime` first,
  then wire a thin command in `packages/cli/src/cli.ts`.
- **Providers are thin REST wrappers.** Use `createRestClient` from `@infra-ts/core`. No CLI shelling.
- **No type casting.** Use type narrowing / assert functions. The only sanctioned boundary
  assertion is `result as InfraEnv<P>` where a runtime-validated shape equals the typed env.
- **No attribute state.** Never persist resource attributes; `.infra` holds only identity bindings (IDs). The reconciler is stateless; the live remote is the source of truth.

## Workflow

```bash
bun install
bun run typecheck      # must pass (includes type-level tests in test/types.test-d.ts)
bun test               # unit + type tests, no network
INFRA_E2E=1 bun test  # live e2e against real Neon + Vercel (creates + destroys throwaway projects)
bun run build          # JS + d.ts for all packages
bun run fmt
```

## Testing

Reverse test pyramid, **no mocks**. Pure functions get unit tests; provider behavior is tested
end-to-end against real APIs. E2e tests must create uniquely-named `infra-ts-e2e-*` resources and
**always clean up** (per-test `finally` / `afterAll`).
