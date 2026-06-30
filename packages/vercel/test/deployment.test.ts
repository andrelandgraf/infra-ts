import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, type ExecResult, silentLogger } from "@infra-ts/core";
import { VercelDeployment } from "../src/lib/entities.js";

function fixture(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "vercel-deployment-"));
	writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Records exec calls and returns a deployment URL for `deploy`. */
function recordingExec(): {
	exec: Exec;
	calls: { command: string[]; env?: Record<string, string> }[];
} {
	const calls: { command: string[]; env?: Record<string, string> }[] = [];
	const exec: Exec = async (command, options): Promise<ExecResult> => {
		calls.push({ command, ...(options?.env ? { env: options.env } : {}) });
		if (command.includes("deploy")) {
			return {
				stdout: "Inspect: …\nhttps://my-app-abc.vercel.app\n",
				stderr: "",
				code: 0,
			};
		}
		return { stdout: "", stderr: "", code: 0 };
	};
	return { exec, calls };
}

describe("VercelDeployment (cli mode)", () => {
	test("runs pull + deploy, injects scope env, captures the URL", async () => {
		const { dir, cleanup } = fixture();
		const { exec, calls } = recordingExec();
		try {
			const dep = new VercelDeployment({
				name: "web-deploy",
				project: "prj_123",
				team: "team_abc",
				cwd: dir,
				production: true,
				cliVersion: "vercel@39",
			});
			const res = await dep.provision({
				environment: "production",
				credentials: { VERCEL_TOKEN: "tok" },
				logger: silentLogger,
				state: null,
				exec,
			});

			expect(res.action).toBe("create");
			expect(res.env.deploymentUrl).toBe("https://my-app-abc.vercel.app");
			expect(res.state.id).toBe("my-app-abc.vercel.app");
			expect(res.state.hash).toMatch(/^[0-9a-f]{64}$/);

			// pulled the env, then deployed with --prod
			expect(calls.some((c) => c.command.includes("pull"))).toBe(true);
			const deploy = calls.find((c) => c.command.includes("deploy"));
			expect(deploy?.command).toContain("--prod");
			// no `build` since prebuilt was not set (remote build)
			expect(calls.some((c) => c.command.includes("build"))).toBe(false);
			// scope injected as env, never on the command line
			expect(deploy?.env?.VERCEL_PROJECT_ID).toBe("prj_123");
			expect(deploy?.env?.VERCEL_ORG_ID).toBe("team_abc");
		} finally {
			cleanup();
		}
	});

	test("prebuilt mode runs vercel build", async () => {
		const { dir, cleanup } = fixture();
		const { exec, calls } = recordingExec();
		try {
			const dep = new VercelDeployment({
				name: "web-deploy",
				project: "prj_1",
				team: "team_abc",
				cwd: dir,
				prebuilt: true,
			});
			await dep.provision({
				environment: "preview",
				credentials: { VERCEL_TOKEN: "tok" },
				logger: silentLogger,
				state: null,
				exec,
			});
			expect(calls.some((c) => c.command.includes("build"))).toBe(true);
			expect(
				calls.find((c) => c.command.includes("deploy"))?.command,
			).toContain("--prebuilt");
		} finally {
			cleanup();
		}
	});

	test("requiredTools advertises the vercel CLI in cli mode only", () => {
		const cli = new VercelDeployment({
			name: "d",
			project: "p",
			team: "team_abc",
			cwd: ".",
		});
		expect(cli.requiredTools().map((t) => t.id)).toEqual(["vercel"]);
		const rest = new VercelDeployment({
			name: "d",
			project: "p",
			team: "team_abc",
			cwd: ".",
			mode: "rest",
		});
		expect(rest.requiredTools()).toEqual([]);
	});
});
