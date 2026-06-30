# Changelog

All notable changes to `infra-ts` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: new features and breaking
changes both land in minor releases).

## [Unreleased]

## [0.4.1] - 2026-06-30

### Fixed

- Fixed globally installed `infra` collecting no scope entities when `infra.ts` imports a project-local
  copy of `infra-ts`. Account/scope detection now works across package copies, so global CLI installs
  can login/link local configs.

## [0.4.0] - 2026-06-30

### Changed

- Neon and Vercel resources now require an explicit org/team scope. `NeonProject` requires `org`,
  and Vercel resources require `team`, preventing accidental provisioning into provider defaults.
- `infra init` now scaffolds explicit `NeonOrg` and `VercelTeam` scope entities and wires projects
  through their `.id` refs.

### Added

- Added provider-native `NeonOrg` and `VercelTeam` scope names. Existing `NeonAccount` and
  `VercelAccount` exports remain as compatibility aliases.

## [0.3.3] - 2026-06-30

### Added

- `infra init` now installs `infra-ts` as a dev dependency in the target repo, using the repo's
  package manager when it can be detected. Existing `infra.ts` files are left untouched, and
  existing `infra-ts` package entries are updated to `latest`.

### Fixed

- The generated `infra.ts` scaffold now uses unique entity names, so follow-up commands like
  `infra login` can load it without duplicate entity id errors.

## [0.3.2] - 2026-06-30

### Fixed

- `infra init` now scaffolds `infra.ts` correctly instead of failing before the template is
  initialized.

## [0.3.1] - 2026-06-30

### Fixed

- Scoped provider packages now publish package entrypoints that point at `dist`, so direct installs
  like `@infra-ts/core` and `@infra-ts/vercel` resolve correctly from npm.

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

[Unreleased]: https://github.com/andrelandgraf/infra-ts/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/andrelandgraf/infra-ts/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/andrelandgraf/infra-ts/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/andrelandgraf/infra-ts/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/andrelandgraf/infra-ts/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/andrelandgraf/infra-ts/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/andrelandgraf/infra-ts/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/andrelandgraf/infra-ts/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/andrelandgraf/infra-ts/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/andrelandgraf/infra-ts/releases/tag/v0.1.0
