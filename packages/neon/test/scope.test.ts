import { describe, expect, test } from "bun:test";
import { NeonOrg, NeonProject } from "../src/index.js";

describe("Neon scope requirements", () => {
	test("NeonProject requires an explicit org", () => {
		expect(() => new NeonProject({ name: "app" } as never)).toThrow(
			/requires an org/,
		);
	});

	test("NeonOrg id can satisfy the org requirement", () => {
		const org = new NeonOrg({ name: "neon" });
		const project = new NeonProject({ name: "app", org: org.id });

		expect(project.name).toBe("app");
	});
});
