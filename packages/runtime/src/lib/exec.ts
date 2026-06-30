import { spawn } from "node:child_process";
import {
	ErrorCode,
	type Exec,
	type ExecResult,
	InfraError,
} from "@infra-ts/core";

/** Project a resolved credentials object into env vars (e.g. `{ VERCEL_TOKEN }`). */
export function credentialsEnv(credentials: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (credentials && typeof credentials === "object") {
		for (const [k, v] of Object.entries(credentials)) {
			if (typeof v === "string" && v.length > 0) out[k] = v;
		}
	}
	return out;
}

/**
 * Build an {@link Exec} bound to a base env (the entity's resolved credentials). Streams stderr
 * (progress) live, captures stdout, and throws {@link InfraError} on a non-zero exit.
 */
export function createExec(baseEnv: Record<string, string> = {}): Exec {
	return (command, options = {}) =>
		new Promise<ExecResult>((resolve, reject) => {
			const [cmd, ...args] = command;
			if (!cmd) {
				reject(new InfraError(ErrorCode.RequestFailed, "exec: empty command"));
				return;
			}
			const child = spawn(cmd, args, {
				...(options.cwd ? { cwd: options.cwd } : {}),
				env: { ...process.env, ...baseEnv, ...options.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			child.stderr.on("data", (d: Buffer) => {
				stderr += d.toString();
				process.stderr.write(d);
			});
			if (options.input !== undefined) child.stdin.write(options.input);
			child.stdin.end();
			child.on("error", (err) => {
				reject(
					new InfraError(
						ErrorCode.RequestFailed,
						`exec: \`${command.join(" ")}\` failed to start: ${(err as Error).message}`,
						{ cause: err, details: { command } },
					),
				);
			});
			child.on("close", (code) => {
				const result: ExecResult = { stdout, stderr, code: code ?? 0 };
				if ((code ?? 0) === 0) {
					resolve(result);
					return;
				}
				const detail =
					stderr.trim().slice(0, 500) ||
					stdout.trim().slice(0, 500) ||
					"(no output)";
				reject(
					new InfraError(
						ErrorCode.RequestFailed,
						`exec: \`${command.join(" ")}\` exited ${code}: ${detail}`,
						{ details: { command, code } },
					),
				);
			});
		});
}
