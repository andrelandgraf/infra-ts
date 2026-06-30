import { describe, expect, test } from "bun:test";
import { VercelProject, VercelTeam } from "../src/index.js";

describe("Vercel scope requirements", () => {
	test("VercelProject requires an explicit team", () => {
		expect(() => new VercelProject({ name: "app" } as never)).toThrow(
			/requires a team/,
		);
	});

	test("VercelTeam id can satisfy the team requirement", () => {
		const team = new VercelTeam({ name: "vercel" });
		const project = new VercelProject({ name: "app", team: team.id });

		expect(project.name).toBe("app");
	});
});
