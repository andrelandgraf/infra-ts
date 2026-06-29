import { describe, expect, test } from "bun:test";
import {
	applyRenames,
	emptyState,
	readState,
	writeState,
} from "../src/lib/state-file.js";
import { tempDir } from "./helpers.js";

describe("state file", () => {
	test("empty when absent; round-trips per environment", () => {
		const { dir, cleanup } = tempDir();
		try {
			expect(readState(dir, "prod").entities).toEqual({});
			const s = emptyState("prod");
			s.entities.neon = { id: "p-1" };
			writeState(dir, "prod", s);
			expect(readState(dir, "prod").entities.neon).toEqual({ id: "p-1" });
			// different environment is isolated
			expect(readState(dir, "local").entities).toEqual({});
		} finally {
			cleanup();
		}
	});

	test("applyRenames re-keys state (idempotent) and rejects conflicts", () => {
		const s = emptyState("prod");
		s.entities["old-db"] = { id: "br-1" };
		const moved = applyRenames(s, [{ old: "old-db", new: "db" }]);
		expect(moved.entities.db).toEqual({ id: "br-1" });
		expect(moved.entities["old-db"]).toBeUndefined();
		// idempotent: re-applying when old is gone is a no-op
		expect(
			applyRenames(moved, [{ old: "old-db", new: "db" }]).entities.db,
		).toEqual({ id: "br-1" });
		// conflict: both exist
		const conflict = emptyState("prod");
		conflict.entities.a = { id: "1" };
		conflict.entities.b = { id: "2" };
		expect(() => applyRenames(conflict, [{ old: "a", new: "b" }])).toThrow();
	});
});
