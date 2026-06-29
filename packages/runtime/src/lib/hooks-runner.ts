import { spawn } from "node:child_process";
import { ErrorCode, type Hook, InfraError } from "@infra-ts/core";

export interface RunHookOptions {
	cwd?: string;
	/** Extra env injected into shell-command hooks, merged over `process.env`. */
	env?: Record<string, string | undefined>;
	onOutput?: (chunk: string) => void;
}

/**
 * Run a lifecycle hook. Function hooks are awaited; shell-command hooks (string / string[]) run
 * sequentially and non-interactively (`CI=1`, stdin detached) with the resolved env injected.
 * A non-zero exit throws {@link InfraError} (`HookFailed`).
 */
export async function runHook<Ctx>(
	hook: Hook<Ctx> | undefined,
	ctx: Ctx,
	options: RunHookOptions = {},
): Promise<void> {
	if (hook === undefined) return;
	if (typeof hook === "function") {
		await hook(ctx);
		return;
	}
	const commands = Array.isArray(hook) ? hook : [hook];
	for (const command of commands) await runOne(command, options);
}

function runOne(command: string, options: RunHookOptions): Promise<void> {
	return new Promise((resolveP, reject) => {
		const child = spawn(command, {
			shell: true,
			cwd: options.cwd ?? process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			env: buildEnv(options.env),
		});
		child.stdout?.on("data", (c: Buffer) => options.onOutput?.(c.toString()));
		child.stderr?.on("data", (c: Buffer) => options.onOutput?.(c.toString()));
		child.on("error", (cause) =>
			reject(
				new InfraError(
					ErrorCode.HookFailed,
					`Hook command failed to start: ${command}`,
					{ cause, details: { command } },
				),
			),
		);
		child.on("close", (code, signal) => {
			if (code === 0) return resolveP();
			reject(
				new InfraError(
					ErrorCode.HookFailed,
					`Hook command exited ${signal ? `with signal ${signal}` : `with code ${code}`}: ${command}`,
					{ details: { command, code, signal } },
				),
			);
		});
	});
}

function buildEnv(
	extra: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
	if (extra) {
		for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
	}
	return env;
}
