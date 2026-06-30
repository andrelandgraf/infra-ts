# Changelog

All notable changes to `infra-ts` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: new features and breaking
changes both land in minor releases).

## [Unreleased]

## [0.3.0] - 2026-06-30

### Added

- **`infra` command alias.** The CLI now installs both `infra-ts` and `infra` bins, so
  `npm i -g infra-ts && infra login` works alongside the existing `infra-ts` command.
- **Self-healing CLI auth.** The REST client gained an `onUnauthorized` hook and a reusable
  `refreshOnUnauthorized({ exec, refresh, reread, current })` util: when a request uses a provider
  CLI's cached OAuth token and gets a `401`, infra-ts refreshes it (Neon runs `neonctl me`),
  re-reads the cache, and retries once. Explicit env-var keys fail fast.
- **Hook path anchor.** Every hook context now includes `rootDir`/`cwd`, so function hooks can
  resolve relative paths against the config root (shell hooks already run there).

## [0.2.0] - 2026-06-30

### Added

- **Command-backed entities.** Transport is now the entity's choice (REST, a vendor CLI, or both).
  The runtime hands `provision` a `ctx.exec` capability that injects resolved credentials as env and
  normalizes failures to `InfraError`, and entities declare needed CLIs via `requiredTools()`.
- **`ensureTools()` in `infra login`** — detects required CLIs, prefers ephemeral `npx`/`bunx`, and
  offers a confirmed global install.
- **`VercelDeployment`** — deploys a project, defaulting to the documented `vercel pull → build →
deploy --prebuilt` CLI flow (content-hash idempotent, deployment id/URL captured into identity
  state), with a `mode: "rest"` source-upload fallback. New `VercelApi` deployment methods.

### Changed

- Vercel deployments are now first-class (previously documented as out of scope); the provider
  "design rule" is clarified: thin REST for reconciled config, CLI delegation for imperative
  build/ship actions.

## [0.1.1] - 2026-06-29

### Added

- **Accounts** (`NeonAccount`, `VercelAccount`) plus `infra login` (CLI OAuth passthrough) and
  `infra link` (pick an org/team → `.infra.<env>`); entities take account refs (`org`/`team`).
- **Typed cross-entity wiring**: `entity.toEnv()` (OS-keyed ref bundle) and `mergeEnv()`.
- **Flat, CLI-aligned hooks**: `beforeApply`/`afterApply`, `beforeCheckout`/`afterCheckout`,
  `beforeDestroy`/`afterDestroy`.
- **New providers**: Sentry, WorkOS, Sanity, Statsig, Dub, Stripe (form-encoded), PostHog,
  ElevenLabs, OpenAI — plus extensions to Resend (Webhook), Vercel (DnsRecord, LogDrain,
  AccessGroup, EdgeConfig, Webhook), Upstash (QStash schedules/topics), and Mux (simulcast target).
- **Neon**: read replicas (`NeonReadReplica`) and the logical-replication project setting.
- **Docs site** at [infra-ts.dev](https://infra-ts.dev).

### Changed

- Dependency edges are inferred from refs (`entity.id`, `entity.env.*`, `entity.toEnv()`); the
  standalone `link` ordering option was removed.

## [0.1.0] - 2026-06-28

### Added

- Initial release: the v2 Entity model (`defineInfra`, typed refs + dependency graph, identity
  state in `.infra.<env>`, `parseEnv`), the `plan`/`apply`/`status`/`checkout`/`destroy` engine, the
  CLI + SDK, and the Neon, Vercel, Upstash, Resend, and Mux providers.

[Unreleased]: https://github.com/andrelandgraf/infra-ts/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/andrelandgraf/infra-ts/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/andrelandgraf/infra-ts/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/andrelandgraf/infra-ts/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/andrelandgraf/infra-ts/releases/tag/v0.1.0
