# AGENTS.md — infra-ts

infra-ts is a typed, live-reconciled, open standard for infrastructure & config as code (no
attribute state — only identity state). This is a Bun
workspaces monorepo.

## Layout

- `packages/core` (`@infra-ts/core`) — the open standard: the `Entity` contract (+ `Account`),
  `defineInfra`, typed refs + dependency graph, env mapping (`toEnv`/`mergeEnv`/`parseEnv`), REST
  client, the `ctx.exec` capability + `CliTool`, errors. **Pure** (no fs, no child processes).
- `packages/runtime` (`@infra-ts/runtime`) — the engine (imperative shell): config loading, `.infra`
  I/O, `plan`/`apply`/`status`/`checkout`/`destroy`, `login`/`link`, `ensureTools`, `exec`, hooks
  runner, dotenv.
- `packages/{neon,vercel,upstash,resend,mux,sentry,workos,sanity,statsig,dub,stripe,posthog,elevenlabs,openai}`
  — providers (thin REST wrappers; some entities are command-backed, e.g. `VercelDeployment`).
- `packages/cli` (`infra-ts`) — the CLI + umbrella SDK; bundles the providers as subpath imports.

## Architecture rules

- **Functional core, imperative shell.** Keep `@infra-ts/core` pure. All I/O lives in `@infra-ts/runtime`
  and the providers.
- **Everything in the CLI is also an SDK function.** Add the function to `@infra-ts/runtime` first,
  then wire a thin command in `packages/cli/src/cli.ts`.
- **Transport is the entity's choice.** Reconciled config (projects, env, domains) uses thin REST
  via `createRestClient`. Imperative, vendor-owned actions (deploy, auth) may be **command-backed** —
  shell the vendor CLI via `ctx.exec` and declare it in `requiredTools()`. Either way, persist only
  identity state, stay idempotent (content hash), and emit typed env.
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

## Releasing

The published artifact is **`infra-ts`** (the `packages/cli` umbrella); the `@infra-ts/*` packages
are bundled into it. Versioning is [semver](https://semver.org) — pre-1.0, so new features _and_
breaking changes are **minor** bumps; bug fixes are **patch** bumps.

1. **Land + green.** Everything on `main`, working tree clean, and:
   ```bash
   bun run typecheck && bun test && bun run build
   ```
2. **Pick the version.** Minor for features/breaking, patch for fixes.
3. **Bump.** Set the new version in **every** `packages/*/package.json` and in the CLI's
   `.version("…")` (`packages/cli/src/cli.ts`) so they match.
4. **Changelog.** Move `[Unreleased]` items in `CHANGELOG.md` into a new `[x.y.z] - <date>` section
   (group as Added / Changed / Fixed / Removed) and update the compare links at the bottom.
5. **Docs.** If docs/spec changed, confirm the site builds: `cd docs && npm run build`.
6. **Commit + tag.** `git commit -m "release: vX.Y.Z"` then `git tag vX.Y.Z`.
7. **Push.** `git push origin main --tags` — Vercel's GitHub integration auto-redeploys the docs
   site (**infra-ts.dev**) on push to `main`.
8. **Publish to npm** (from an npm-authenticated shell): `bun run build && cd packages/cli &&
npm publish` (its `publishConfig` points `exports`/`bin`/`types` at `dist/`).
9. **Verify.** `npx infra-ts@latest --version`.

Never release with a dirty tree or failing checks. `.infra*` and `.env*` are git-ignored and must
never be committed.
