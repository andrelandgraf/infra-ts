import { describe, expect, test } from "bun:test";
import { defineInfra, type Infra, silentLogger } from "@infra-ts/core";
import { apply } from "../src/lib/engine.js";
import { collectAccounts, link } from "../src/lib/accounts.js";
import { readState } from "../src/lib/state-file.js";
import {
	FakeAccount,
	FakeEntity,
	fakeRemote,
	resetFakeRemote,
	tempDir,
} from "./helpers.js";

const ctx = {
	environment: "test",
	credentials: {} as Record<string, never>,
	logger: silentLogger,
	state: null,
};

describe("Account node", () => {
	test("provision throws until linked", async () => {
		const account = new FakeAccount({ name: "acct" });
		await expect(account.provision(ctx)).rejects.toThrow(/not linked/);
	});

	test("explicit scope option satisfies provision", async () => {
		const account = new FakeAccount({ name: "acct", scope: "org-x" });
		const res = await account.provision(ctx);
		expect(res.id).toBe("org-x");
		expect(res.state).toEqual({ scopeId: "org-x" });
	});

	test("collectAccounts finds only accounts", () => {
		const account = new FakeAccount({ name: "acct" });
		const infra = defineInfra({
			entities: [account, new FakeEntity({ name: "e" })],
		});
		expect(collectAccounts(infra).map((a) => a.name)).toEqual(["acct"]);
	});

	test("collectAccounts recognizes account-like entities across package copies", () => {
		const foreignAccount = {
			name: "foreign",
			cliAuth: () => ({
				providerId: "fake",
				envVar: "FAKE_TOKEN",
				detect: ["fake", "me"],
				login: ["fake", "login"],
			}),
			listScopes: async () => [],
		};
		const infra = {
			entities: [foreignAccount],
			ordered: [foreignAccount],
			defaultEnvironment: "local",
			renames: [],
		} as unknown as Infra;
		expect(collectAccounts(infra).map((a) => a.name)).toEqual(["foreign"]);
	});
});

describe("link", () => {
	test("writes the chosen scope into .infra.<env>", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const account = new FakeAccount({ name: "acct" });
			const infra = defineInfra({ entities: [account] });
			await link(infra, {
				rootDir: dir,
				environment: "test",
				scopes: { acct: "org-123" },
			});
			expect(readState(dir, "test").entities.acct).toEqual({
				scopeId: "org-123",
			});
		} finally {
			cleanup();
		}
	});

	test("rejects a name that isn't an account", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const infra = defineInfra({
				entities: [new FakeAccount({ name: "acct" })],
			});
			await expect(
				link(infra, {
					rootDir: dir,
					environment: "test",
					scopes: { nope: "x" },
				}),
			).rejects.toThrow(/not an Account/);
		} finally {
			cleanup();
		}
	});
});

describe("account scope flows into entities via ref", () => {
	test("link → apply wires the scope id into a dependent entity", async () => {
		const { dir, cleanup } = tempDir();
		try {
			const account = new FakeAccount({ name: "acct" });
			const entity = new FakeEntity({ name: "e", value: account.id });
			const infra = defineInfra({ entities: [account, entity] });
			await link(infra, {
				rootDir: dir,
				environment: "test",
				scopes: { acct: "org-123" },
			});
			await apply(infra, { rootDir: dir, environment: "test" });
			expect(fakeRemote.get("e")).toBe("org-123");
		} finally {
			resetFakeRemote();
			cleanup();
		}
	});
});
