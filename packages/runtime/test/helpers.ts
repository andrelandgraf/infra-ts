import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Account,
	type AccountScope,
	type Change,
	type CliAuth,
	Entity,
	type EntityCommon,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
	type Ref,
	type StandardSchemaV1,
} from "@infra-ts/core";

/** A trivial passthrough Standard Schema (no validator dep needed for tests). */
export function passthrough<T>(): StandardSchemaV1<unknown, T> {
	return {
		"~standard": {
			version: 1,
			vendor: "infra-ts-test",
			validate: (value) => ({ value: value as T }),
		},
	};
}

/** In-memory "remote" shared by all FakeEntity instances in a test. */
export const fakeRemote = new Map<string, string>();
export function resetFakeRemote(): void {
	fakeRemote.clear();
}

type FakeEnv = { value: string };
type FakeState = { id: string };
export interface FakeOptions extends EntityCommon<FakeEnv, FakeState> {
	/** A literal or a ref to another entity's `value` (to exercise cross-entity wiring). */
	value?: string | Ref<string>;
}

/** A network-free entity backed by {@link fakeRemote} — exercises the real engine end to end. */
export class FakeEntity extends Entity<
	FakeOptions,
	Record<string, never>,
	FakeEnv,
	FakeState,
	{ value: string }
> {
	readonly credentialsSchema = passthrough<Record<string, never>>();
	readonly envSchema = passthrough<FakeEnv>();
	readonly stateSchema = passthrough<FakeState>();
	readonly envKeys = ["value"] as const;
	override resolveCredentials(): unknown {
		return {};
	}
	async read(): Promise<{ value: string } | null> {
		return fakeRemote.has(this.name)
			? { value: fakeRemote.get(this.name) as string }
			: null;
	}
	diff(remote: { value: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "fake", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<Record<string, never>, FakeState>,
	): Promise<ProvisionResult<FakeEnv, FakeState>> {
		const value = this.config.value ?? `v-${this.name}`;
		const existed = fakeRemote.has(this.name);
		fakeRemote.set(this.name, value);
		return {
			action: existed ? "noop" : "create",
			id: this.name,
			state: { id: this.name },
			env: { value },
		};
	}
	async pullEnv(
		_ctx: ReadContext<Record<string, never>, FakeState>,
	): Promise<FakeEnv> {
		return { value: fakeRemote.get(this.name) ?? `v-${this.name}` };
	}
	async deprovision(): Promise<void> {
		fakeRemote.delete(this.name);
	}
}

/** A network-free Account for exercising login/link + scope wiring. */
export class FakeAccount extends Account<Record<string, never>> {
	readonly credentialsSchema = passthrough<Record<string, never>>();
	override resolveCredentials(): unknown {
		return {};
	}
	cliAuth(): CliAuth {
		return {
			providerId: "fake",
			envVar: "FAKE_TOKEN",
			detect: ["true"],
			login: ["true"],
		};
	}
	async listScopes(): Promise<AccountScope[]> {
		return [
			{ id: "scope-1", name: "One" },
			{ id: "scope-2", name: "Two" },
		];
	}
}

export function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "infra-ts-test-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
