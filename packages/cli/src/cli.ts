#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	type Change,
	consoleLogger,
	isInfraError,
	type Logger,
} from "@infra-ts/core";
import {
	apply,
	checkout,
	destroy,
	loadConfig,
	type LoadedConfig,
	plan,
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

const program = new Command();
program
	.name("infra-ts")
	.description(
		"Typed, live-reconciled infrastructure & config as code (no attribute state). Declare entities in infra.ts; plan/apply against live REST APIs.",
	)
	.version("0.2.0")
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

program.parseAsync(process.argv);

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
	const target = join(rootOf(f), "infra.ts");
	if (existsSync(target)) {
		info(`infra.ts already exists at ${target}`);
		return;
	}
	writeFileSync(target, INIT_TEMPLATE, "utf8");
	info(chalk.green(`Created ${target}`));
	info(
		"Next: edit your entities, then run `infra-ts plan` and `infra-ts apply`.",
	);
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
async function confirm(prompt: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(prompt)).trim());
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
\tname: "my-app",
\tregion: "aws-us-east-1",
\tcompute: { minCu: 0.25, maxCu: 1, suspendTimeout: "5m" },
});
const db = new NeonPostgres({ name: "my-db", projectId: project.id });

export default defineInfra({
\tentities: [
\t\tproject,
\t\tdb,
\t\tnew VercelProject({
\t\t\tname: "my-app",
\t\t\tframework: "nextjs",
\t\t\tenv: { DATABASE_URL: db.env.databaseUrl },
\t\t}),
\t],
});
`;
