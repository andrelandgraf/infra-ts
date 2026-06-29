import { describe, expect, test } from "bun:test";
import {
	collectRefEntities,
	deepResolve,
	envRefs,
	idRef,
	isRef,
	resolveRef,
	type ResolvedOutputs,
} from "../src/lib/ref.js";

describe("refs", () => {
	test("idRef + isRef", () => {
		const r = idRef("proj");
		expect(isRef(r)).toBe(true);
		expect(r).toEqual({ __infraRef: true, entity: "proj", kind: "id" });
		expect(isRef({})).toBe(false);
	});

	test("envRefs builds one ref per field", () => {
		const refs = envRefs<{ databaseUrl: string; branch: string }>("db", [
			"databaseUrl",
			"branch",
		]);
		expect(refs.databaseUrl).toEqual({
			__infraRef: true,
			entity: "db",
			kind: "env",
			field: "databaseUrl",
		});
	});

	const outputs: ResolvedOutputs = {
		proj: { id: "p-1", env: {} },
		db: { id: "br-1", env: { databaseUrl: "postgres://x" } },
	};

	test("resolveRef resolves id + env", () => {
		expect(resolveRef(idRef("proj"), outputs)).toBe("p-1");
		expect(
			resolveRef(
				{ __infraRef: true, entity: "db", kind: "env", field: "databaseUrl" },
				outputs,
			),
		).toBe("postgres://x");
	});

	test("deepResolve replaces refs anywhere in an object", () => {
		const resolved = deepResolve(
			{
				projectId: idRef("proj"),
				env: {
					DATABASE_URL: envRefs<{ databaseUrl: string }>("db", ["databaseUrl"])
						.databaseUrl,
				},
				plain: "x",
			},
			outputs,
		);
		expect(resolved).toEqual({
			projectId: "p-1",
			env: { DATABASE_URL: "postgres://x" },
			plain: "x",
		});
	});

	test("collectRefEntities finds referenced entity ids", () => {
		const into = new Set<string>();
		collectRefEntities({ a: idRef("proj"), b: [idRef("db")], c: "x" }, into);
		expect([...into].sort()).toEqual(["db", "proj"]);
	});
});
