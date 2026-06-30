#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	type Change,
	consoleLogger,
	isInfraError,
	type Logger,
} from "@infra-ts/core";
import {
	accountCredentials,
	apply,
	checkout,
	collectAccounts,
	destroy,
	ensureTools,
	link,
	loadConfig,
	type LoadedConfig,
	login,
	plan,
	resolveEnvironment,
	status,
	toEntries,
} from "@infra-ts/runtime";
import chalk from "chalk";
import { Command } from "commander";

interface GlobalFlags {
	cwd?: string;
	config?: string;
	env?: string;
	json?: boolean;
	only?: string[];
	verbose?: boolean;
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

const program = new Command();
program
	.name("infra-ts")
	.description(
		"Typed, live-reconciled infrastructure & config as code (no attribute state). Declare entities in infra.ts; plan/apply against live REST APIs.",
	)
	.version(packageJson.version)
	.option("-C, --cwd <dir>", "run as if started in <dir>")
	.option("--config <path>", "path to an infra.ts config file")
	.option("-e, --env <environment>", "target environment (default: local)")
	.option("--only <ids...>", "limit to these entity ids")
	.option("--json", "machine-readable JSON output")
	.option("--verbose", "print debug logging");

program
	.command("init")
	.description("scaffold an infra.ts config in the current directory")
	.action(() => withErrors(cmdInit));
program
	.command("login")
	.description("authenticate each account's provider (CLI OAuth passthrough)")
	.argument("[providers...]", "limit to these provider ids (e.g. neon vercel)")
	.action((providers: string[]) => withErrors(() => cmdLogin(providers)));
program
	.command("link")
	.description("pick an org/team per account; write the scope to .infra.<env>")
	.argument("[accounts...]", "limit to these account names")
	.action((accounts: string[]) => withErrors(() => cmdLink(accounts)));
program
	.command("plan")
	.description("show the changes apply would make (dry run; no mutations)")
	.action(() => withErrors(cmdPlan));
program
	.command("apply")
	.description("reconcile remote to infra.ts, write .env.<env>, run hooks")
	.option("--prune", "report entities in state but no longer in config")
	.action((opts: { prune?: boolean }) => withErrors(() => cmdApply(opts)));
program
	.command("status")
	.description("live state of every entity")
	.action(() => withErrors(cmdStatus));
program
	.command("checkout")
	.description(
		"pull typed env from live remote into .env.<env> (+ drift guard)",
	)
	.option("--ignore-diff", "pull even if the remote drifted from config")
	.action((opts: { ignoreDiff?: boolean }) =>
		withErrors(() => cmdCheckout(opts)),
	);
program
	.command("destroy")
	.description("tear down every entity (destructive)")
	.option("-y, --yes", "skip the confirmation prompt")
	.action((opts: { yes?: boolean }) =>
		withErrors(() => cmdDestroy(opts.yes === true)),
	);
program
	.command("run")
	.description("inject the resolved env into a child command")
	.argument("<command...>", "e.g. `infra-ts run -- npm run dev`")
	.action((command: string[]) => withErrors(() => cmdRun(command)));

// ───────────────────────────── commands ─────────────────────────────

function flags(): GlobalFlags {
	return program.opts<GlobalFlags>();
}
function rootOf(f: GlobalFlags): string {
	return resolve(f.cwd ?? process.cwd());
}
async function load(f: GlobalFlags): Promise<LoadedConfig> {
	return loadConfig({
		...(f.cwd ? { cwd: f.cwd } : {}),
		...(f.config ? { configPath: f.config } : {}),
	});
}
function engineOptions(f: GlobalFlags, rootDir: string) {
	return {
		rootDir,
		...(f.env ? { environment: f.env } : {}),
		...(f.only ? { only: f.only } : {}),
		logger: f.verbose ? consoleLogger : silentish(),
	};
}

async function cmdInit(): Promise<void> {
	const f = flags();
	const rootDir = rootOf(f);
	const target = join(rootDir, "infra.ts");
	const existingPackageJson = readPackageJson(rootDir);
	const hasConfig = existsSync(target);
	const packageHasInfraTs =
		existingPackageJson !== undefined &&
		hasInfraTsDependency(existingPackageJson);

	if (hasConfig) {
		info(`infra.ts already exists at ${target}; leaving it unchanged.`);
	} else if (packageHasInfraTs) {
		info(
			"package.json already depends on infra-ts; updating the package and leaving infra.ts untouched.",
		);
	} else {
		writeFileSync(target, INIT_TEMPLATE, "utf8");
		info(chalk.green(`Created ${target}`));
	}
	await installInfraTsDevDependency(rootDir);
	info(
		"Next: edit your entities, then run `infra-ts plan` and `infra-ts apply`.",
	);
}

async function cmdLogin(providers: string[]): Promise<void> {
	const f = flags();
	const loaded = await load(f);
	const results = await login(loaded.infra, {
		...(providers.length > 0 ? { only: providers } : {}),
		logger: consoleLogger,
	});
	if (f.json) return printJson(results);
	if (results.length === 0) {
		info(chalk.dim("No accounts in this config — nothing to log in to."));
		return;
	}
	for (const r of results) {
		const mark =
			r.status === "already" || r.status === "logged-in"
				? chalk.green("✓")
				: chalk.red("✖");
		info(`${mark} ${r.provider} (${r.accounts.join(", ")}) — ${r.status}`);
	}

	const tools = await ensureTools(loaded.infra, {
		logger: consoleLogger,
		confirm: (tool) =>
			confirm(
				chalk.yellow(
					`Install the ${tool.id} CLI globally? (${(tool.install ?? []).join(" ")}) (y/N) `,
				),
			),
	});
	for (const t of tools) {
		if (t.status === "missing" || t.status === "declined") {
			info(
				chalk.yellow(`• ${t.id} CLI: ${t.status} (runs via npx if available)`),
			);
		} else if (t.status === "installed") {
			info(chalk.green(`✓ ${t.id} CLI installed`));
		}
	}
}

async function cmdLink(names: string[]): Promise<void> {
	const f = flags();
	const loaded = await load(f);
	const environment = resolveEnvironment(loaded.infra, {
		...(f.env ? { environment: f.env } : {}),
	});
	const accounts = collectAccounts(loaded.infra).filter(
		(a) => names.length === 0 || names.includes(a.name),
	);
	if (accounts.length === 0) {
		info(chalk.dim("No accounts to link in this config."));
		return;
	}
	const scopes: Record<string, string> = {};
	for (const account of accounts) {
		const creds = accountCredentials(loaded.infra, account, environment);
		const options = await account.listScopes(creds);
		if (options.length === 0) {
			info(
				chalk.yellow(`No scopes available for "${account.name}" — skipping.`),
			);
			continue;
		}
		const picked = await choose(
			`Link "${account.name}" to:`,
			options.map((o) => ({
				label: `${o.name}  ${chalk.dim(o.id)}`,
				value: o.id,
			})),
		);
		if (picked) scopes[account.name] = picked;
	}
	if (Object.keys(scopes).length === 0) return;
	const results = await link(loaded.infra, {
		rootDir: loaded.rootDir,
		environment,
		scopes,
	});
	for (const r of results) {
		info(chalk.green(`Linked ${r.account} → ${r.scopeId} (${environment})`));
	}
}

async function cmdPlan(): Promise<void> {
	const f = flags();
	const loaded = await load(f);
	const report = await plan(loaded.infra, engineOptions(f, loaded.rootDir));
	if (f.json) return printJson(report);
	info(chalk.dim(`environment: ${report.environment}`));
	printChanges("Planned changes", report.changes);
}

async function cmdApply(opts: { prune?: boolean }): Promise<void> {
	const f = flags();
	const loaded = await load(f);
	const report = await apply(loaded.infra, engineOptions(f, loaded.rootDir));
	if (f.json) return printJson(report);
	info(chalk.dim(`environment: ${report.environment}`));
	printChanges("Applied changes", report.changes);
	if (report.envFile && report.envKeysWritten.length > 0) {
		info(
			chalk.cyan(
				`Wrote ${report.envKeysWritten.length} env var(s) to ${report.envFile}: ${report.envKeysWritten.join(", ")}`,
			),
		);
	}
	if (opts.prune && report.orphans.length > 0) {
		info(
			chalk.yellow(
				`Orphans in state (removed from config): ${report.orphans.join(", ")} — keep them in config and run \`infra-ts destroy\` to tear down.`,
			),
		);
	}
}

async function cmdStatus(): Promise<void> {
	const f = flags();
	const loaded = await load(f);
	const report = await status(loaded.infra, engineOptions(f, loaded.rootDir));
	if (f.json) return printJson(report);
	info(chalk.dim(`environment: ${report.environment}`));
	for (const e of report.entities) {
		const mark = e.exists ? chalk.green("●") : chalk.yellow("○");
		const drift =
			e.changes.length > 0
				? chalk.yellow(` (${e.changes.length} change(s) pending)`)
				: "";
		info(`${mark} ${e.name}${drift}`);
	}
}

async function cmdCheckout(opts: { ignoreDiff?: boolean }): Promise<void> {
	const f = flags();
	const loaded = await load(f);
	const report = await checkout(loaded.infra, {
		...engineOptions(f, loaded.rootDir),
		...(opts.ignoreDiff ? { ignoreDiff: true } : {}),
	});
	if (f.json) return printJson(report);
	if (report.envFile) {
		info(
			chalk.cyan(
				`Pulled ${report.envKeysWritten.length} env var(s) into ${report.envFile}`,
			),
		);
	}
}

async function cmdDestroy(yes: boolean): Promise<void> {
	const f = flags();
	const loaded = await load(f);
	if (!yes) {
		const ok = await confirm(
			chalk.red(
				`This deletes every resource infra-ts provisioned for "${f.env ?? "local"}". Continue? (y/N) `,
			),
		);
		if (!ok) return info("Aborted.");
	}
	const report = await destroy(loaded.infra, engineOptions(f, loaded.rootDir));
	if (f.json) return printJson(report);
	printChanges("Destroyed", report.changes);
}

async function cmdRun(command: string[]): Promise<void> {
	const f = flags();
	const loaded = await load(f);
	const report = await checkout(loaded.infra, {
		...engineOptions(f, loaded.rootDir),
		writeEnv: false,
		ignoreDiff: true,
	});
	const entries = toEntries(loaded.infra, report.env);
	const [bin, ...args] = command;
	if (!bin) throw new Error("infra-ts run: no command provided.");
	const child = spawn(bin, args, {
		stdio: "inherit",
		cwd: loaded.rootDir,
		env: { ...process.env, ...entries },
	});
	await new Promise<void>((res) => {
		child.on("close", (code) => {
			process.exitCode = code ?? 0;
			res();
		});
	});
}

// ───────────────────────────── helpers ─────────────────────────────

function silentish(): Logger {
	return {
		debug() {},
		info() {},
		warn: (m) => process.stderr.write(`${chalk.yellow(m)}\n`),
		error: (m) => process.stderr.write(`${chalk.red(m)}\n`),
	};
}
function printChanges(title: string, changes: Change[]): void {
	if (changes.length === 0) return info(`${title}: ${chalk.dim("no changes")}`);
	info(chalk.bold(title));
	for (const c of changes) {
		const color =
			c.action === "create"
				? chalk.green
				: c.action === "update"
					? chalk.yellow
					: c.action === "delete"
						? chalk.red
						: chalk.dim;
		const provider = c.provider ? `${c.provider} ` : "";
		info(
			`  ${color(c.action.padEnd(6))} ${provider}${chalk.dim(c.kind)} ${c.identifier}${c.detail ? chalk.dim(` — ${c.detail}`) : ""}`,
		);
	}
}
function info(message: string): void {
	process.stdout.write(`${message}\n`);
}
function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function readPackageJson(rootDir: string): Record<string, unknown> | undefined {
	const packagePath = join(rootDir, "package.json");
	if (!existsSync(packagePath)) return undefined;
	return JSON.parse(readFileSync(packagePath, "utf8")) as Record<
		string,
		unknown
	>;
}
function ensurePackageJson(rootDir: string): Record<string, unknown> {
	const existing = readPackageJson(rootDir);
	if (existing) return existing;
	const created = {
		name: packageNameFromDir(rootDir),
		private: true,
	};
	writeFileSync(
		join(rootDir, "package.json"),
		`${JSON.stringify(created, null, "\t")}\n`,
		"utf8",
	);
	info(chalk.green(`Created ${join(rootDir, "package.json")}`));
	return created;
}
function packageNameFromDir(rootDir: string): string {
	return (
		basename(rootDir)
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "infra-app"
	);
}
function hasInfraTsDependency(packageJson: Record<string, unknown>): boolean {
	return [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	].some((field) => {
		const dependencies = packageJson[field];
		return (
			typeof dependencies === "object" &&
			dependencies !== null &&
			"infra-ts" in dependencies
		);
	});
}
function detectPackageManager(
	rootDir: string,
): "bun" | "npm" | "pnpm" | "yarn" {
	const packageManager = readPackageJson(rootDir)?.packageManager;
	if (typeof packageManager === "string") {
		const name = packageManager.split("@")[0];
		if (
			name === "bun" ||
			name === "npm" ||
			name === "pnpm" ||
			name === "yarn"
		) {
			return name;
		}
	}
	if (
		existsSync(join(rootDir, "bun.lock")) ||
		existsSync(join(rootDir, "bun.lockb"))
	) {
		return "bun";
	}
	if (existsSync(join(rootDir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(rootDir, "yarn.lock"))) return "yarn";
	if (
		existsSync(join(rootDir, "package-lock.json")) ||
		existsSync(join(rootDir, "npm-shrinkwrap.json"))
	) {
		return "npm";
	}
	return "npm";
}
function installCommand(packageManager: "bun" | "npm" | "pnpm" | "yarn"): {
	bin: string;
	args: string[];
} {
	switch (packageManager) {
		case "bun":
			return { bin: "bun", args: ["add", "-d", "infra-ts@latest"] };
		case "pnpm":
			return { bin: "pnpm", args: ["add", "-D", "infra-ts@latest"] };
		case "yarn":
			return { bin: "yarn", args: ["add", "-D", "infra-ts@latest"] };
		case "npm":
			return { bin: "npm", args: ["install", "-D", "infra-ts@latest"] };
	}
}
async function installInfraTsDevDependency(rootDir: string): Promise<void> {
	ensurePackageJson(rootDir);
	const packageManager = detectPackageManager(rootDir);
	const { bin, args } = installCommand(packageManager);
	info(chalk.dim(`Installing infra-ts with ${bin} ${args.join(" ")}...`));
	await runChild(bin, args, rootDir);
	info(chalk.green("Installed infra-ts as a dev dependency at latest."));
}
async function runChild(
	bin: string,
	args: string[],
	cwd: string,
): Promise<void> {
	const child = spawn(bin, args, {
		cwd,
		env: process.env,
		stdio: "inherit",
	});
	await new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) return resolve();
			reject(
				new Error(`${bin} ${args.join(" ")} exited with code ${code ?? 1}`),
			);
		});
	});
}
async function confirm(prompt: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(prompt)).trim());
	} finally {
		rl.close();
	}
}
async function choose(
	prompt: string,
	options: { label: string; value: string }[],
): Promise<string | undefined> {
	if (options.length === 1) return options[0]?.value;
	if (!process.stdin.isTTY) {
		throw new Error(
			`${prompt} — multiple options but no TTY to choose. Pass \`scope\` on the account or run interactively.`,
		);
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		info(chalk.bold(prompt));
		options.forEach((o, i) =>
			info(`  ${chalk.cyan(String(i + 1))}. ${o.label}`),
		);
		const answer = (await rl.question("  # ")).trim();
		const idx = Number.parseInt(answer, 10) - 1;
		return options[idx]?.value;
	} finally {
		rl.close();
	}
}
async function withErrors(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (error) {
		if (isInfraError(error)) {
			process.stderr.write(`${chalk.red(`✖ ${error.message}`)}\n`);
			process.stderr.write(chalk.dim(`  [${error.code}]\n`));
		} else {
			process.stderr.write(
				`${chalk.red(`✖ ${(error as Error)?.message ?? String(error)}`)}\n`,
			);
		}
		process.exitCode = 1;
	}
}

const INIT_TEMPLATE = `import { defineInfra } from "infra-ts";
import { NeonProject, NeonPostgres } from "infra-ts/neon";
import { VercelProject } from "infra-ts/vercel";

const project = new NeonProject({
\tname: "my-app-neon",
\tregion: "aws-us-east-1",
\tcompute: { minCu: 0.25, maxCu: 1, suspendTimeout: "5m" },
});
const db = new NeonPostgres({ name: "my-db", projectId: project.id });

export default defineInfra({
\tentities: [
\t\tproject,
\t\tdb,
\t\tnew VercelProject({
\t\t\tname: "my-app-vercel",
\t\t\tframework: "nextjs",
\t\t\tenv: { DATABASE_URL: db.env.databaseUrl },
\t\t}),
\t],
});
`;

program.parseAsync(process.argv);
