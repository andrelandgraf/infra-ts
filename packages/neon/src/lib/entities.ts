import {
	Account,
	type AccountOptions,
	type AccountScope,
	type Change,
	type CliAuth,
	type DiffContext,
	Entity,
	type EntityCommon,
	ErrorCode,
	InfraError,
	type Exec,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
	type Ref,
	refreshOnUnauthorized,
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";
import {
	NeonApi,
	type NeonBranchSnapshot,
	type NeonEndpointSnapshot,
} from "./api.js";
import {
	DEFAULT_NEON_API_HOST,
	neonTokenFromBag,
	readNeonctlToken,
} from "./credentials.js";
import { parseDurationSeconds } from "./duration.js";

const SUSPEND_NEVER = 0;
const DEFAULT_REGION = "aws-us-east-1";
const DEFAULT_PG_VERSION = 17;
const DEFAULT_OWNER_ROLE = "neondb_owner";
const DEFAULT_DATABASE = "neondb";

type NeonCreds = { NEON_API_KEY: string };
const credentialsSchema = z.object({
	NEON_API_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, NeonCreds>;

/** Shared base: Neon credentials (NEON_API_KEY, with neonctl-cache fallback) + an API client. */
abstract class NeonEntity<
	O extends EntityCommon<Env, State>,
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, NeonCreds, Env, State, Remote> {
	readonly credentialsSchema = credentialsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { NEON_API_KEY: neonTokenFromBag(bag) ?? "" };
	}
	protected api(ctx: { credentials: NeonCreds; exec?: Exec }): NeonApi {
		const token = ctx.credentials.NEON_API_KEY;
		// When the token came from the neonctl OAuth cache, refresh it via `neonctl me` on a 401.
		const onUnauthorized = refreshOnUnauthorized({
			exec: ctx.exec,
			refresh: ["neonctl", "me"],
			reread: readNeonctlToken,
			current: token,
		});
		return new NeonApi({
			token,
			apiHost: process.env.NEON_API_HOST ?? DEFAULT_NEON_API_HOST,
			...(onUnauthorized ? { onUnauthorized } : {}),
		});
	}
	/** Find the default branch of a project, or throw if none. */
	protected async defaultBranch(
		api: NeonApi,
		projectId: string,
	): Promise<NeonBranchSnapshot> {
		const branches = await api.listBranches(projectId);
		const branch = branches.find((b) => b.isDefault) ?? branches[0];
		if (!branch) {
			throw new InfraError(
				ErrorCode.NotFound,
				`neon: project ${projectId} has no branches.`,
			);
		}
		return branch;
	}
}

// ─── Project ────────────────────────────────────────────────────────────────

export interface NeonComputeConfig {
	minCu?: number;
	maxCu?: number;
	/** seconds, a duration string ("5m"), or `false` for always-on. */
	suspendTimeout?: number | string | false;
}

export interface NeonProjectOptions extends EntityCommon<
	Record<string, never>,
	NeonProjectState
> {
	/** Neon org id (`org-…`) or an account ref (`account.id`). Omit for your personal account. */
	org?: string | Ref<string>;
	region?: string;
	pgVersion?: number;
	compute?: NeonComputeConfig;
	/** Branch TTL: duration string ("7d") or seconds. */
	ttl?: number | string;
	/** Enable logical replication (`wal_level=logical`) for CDC / outbound replication. One-way. */
	logicalReplication?: boolean;
}
interface NeonProjectState extends Record<string, unknown> {
	id: string;
	orgId?: string;
	branchId: string;
	endpointId?: string;
}
interface NeonProjectRemote {
	projectId: string;
	branch: NeonBranchSnapshot;
	endpoint?: NeonEndpointSnapshot;
	logicalReplication: boolean;
}

/** A Neon project: region, Postgres version, default-branch compute (autoscaling + scale-to-zero) and TTL. */
export class NeonProject extends NeonEntity<
	NeonProjectOptions,
	Record<string, never>,
	NeonProjectState,
	NeonProjectRemote
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = z.object({
		id: z.string(),
		orgId: z.string().optional(),
		branchId: z.string(),
		endpointId: z.string().optional(),
	}) as unknown as StandardSchemaV1<unknown, NeonProjectState>;
	readonly envKeys = [] as const;

	async read(
		ctx: ReadContext<NeonCreds, NeonProjectState>,
	): Promise<NeonProjectRemote | null> {
		if (!ctx.state?.id) return null;
		const api = this.api(ctx);
		const project = await api.getProject(ctx.state.id);
		if (!project) return null;
		const branch = await this.defaultBranch(api, project.id);
		const endpoints = await api.listEndpoints(project.id);
		const endpoint = endpoints.find(
			(e) => e.type === "read_write" && e.branchId === branch.id,
		);
		return {
			projectId: project.id,
			branch,
			...(endpoint ? { endpoint } : {}),
			logicalReplication: project.logicalReplication,
		};
	}

	diff(remote: NeonProjectRemote | null, _ctx: DiffContext): Change[] {
		if (!remote) {
			return [
				{
					action: "create",
					kind: "project",
					identifier: this.name,
					detail: `create Neon project "${this.name}"`,
				},
			];
		}
		const changes: Change[] = [];
		const drift = this.computeDrift(remote.endpoint);
		if (drift) {
			changes.push({
				action: "update",
				kind: "compute",
				identifier: this.name,
				detail: describeCompute(drift),
			});
		}
		if (this.ttlSeconds() !== undefined && this.expiryDrifts(remote.branch)) {
			changes.push({ action: "update", kind: "ttl", identifier: this.name });
		}
		if (this.config.logicalReplication === true && !remote.logicalReplication) {
			changes.push({
				action: "update",
				kind: "logical-replication",
				identifier: this.name,
				detail: "enable logical replication",
			});
		}
		return changes;
	}

	async provision(
		ctx: ProvisionContext<NeonCreds, NeonProjectState>,
	): Promise<ProvisionResult<Record<string, never>, NeonProjectState>> {
		const api = this.api(ctx);
		const o = this.config;
		let state = ctx.state;
		let action: ProvisionResult<
			Record<string, never>,
			NeonProjectState
		>["action"] = "noop";

		if (!state?.id) {
			const created = await api.createProject({
				name: this.name,
				...(o.org ? { orgId: o.org } : {}),
				regionId: o.region ?? DEFAULT_REGION,
				pgVersion: o.pgVersion ?? DEFAULT_PG_VERSION,
				...(o.logicalReplication ? { logicalReplication: true } : {}),
			});
			const branch =
				created.defaultBranch ??
				(await this.defaultBranch(api, created.project.id));
			const endpoints = created.endpoint
				? [created.endpoint]
				: await api.listEndpoints(created.project.id);
			const endpoint = endpoints.find(
				(e) => e.type === "read_write" && e.branchId === branch.id,
			);
			state = {
				id: created.project.id,
				...(created.project.orgId ? { orgId: created.project.orgId } : {}),
				branchId: branch.id,
				...(endpoint ? { endpointId: endpoint.id } : {}),
			};
			action = "create";
		}

		const projectId = state.id;
		const branch = await this.defaultBranch(api, projectId);
		const endpoints = await api.listEndpoints(projectId);
		const endpoint = endpoints.find(
			(e) => e.type === "read_write" && e.branchId === branch.id,
		);

		const drift = this.computeDrift(endpoint);
		const ttlSeconds = this.ttlSeconds();
		const needsTtl = ttlSeconds !== undefined && this.expiryDrifts(branch);
		if (drift || needsTtl) {
			await api.waitForProjectIdle(projectId);
		}
		if (drift && endpoint) {
			await api.updateEndpoint(projectId, endpoint.id, drift);
			if (action === "noop") action = "update";
		}
		if (needsTtl && ttlSeconds !== undefined) {
			await api.updateBranchExpiry(
				projectId,
				branch.id,
				new Date(Date.now() + ttlSeconds * 1000).toISOString(),
			);
			if (action === "noop") action = "update";
		}
		if (o.logicalReplication === true) {
			const project = await api.getProject(projectId);
			if (project && !project.logicalReplication) {
				await api.waitForProjectIdle(projectId);
				await api.updateProjectSettings(projectId, {
					logicalReplication: true,
				});
				if (action === "noop") action = "update";
			}
		}

		return {
			action,
			id: projectId,
			state: {
				id: projectId,
				...(state.orgId ? { orgId: state.orgId } : {}),
				branchId: branch.id,
				...(endpoint ? { endpointId: endpoint.id } : {}),
			},
			env: {},
		};
	}

	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}

	async deprovision(
		ctx: ProvisionContext<NeonCreds, NeonProjectState>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		const api = this.api(ctx);
		await api.waitForProjectIdle(ctx.state.id, { timeoutMs: 30_000 });
		await api.deleteProject(ctx.state.id);
	}

	private ttlSeconds(): number | undefined {
		return this.config.ttl !== undefined
			? parseDurationSeconds(this.config.ttl)
			: undefined;
	}
	private expiryDrifts(branch: NeonBranchSnapshot): boolean {
		const ttl = this.ttlSeconds();
		if (ttl === undefined) return false;
		if (!branch.expiresAt) return true;
		const remaining = Math.round(
			(Date.parse(branch.expiresAt) - Date.now()) / 1000,
		);
		return Math.abs(remaining - ttl) > 60;
	}
	private computeDrift(endpoint: NeonEndpointSnapshot | undefined): {
		autoscalingLimitMinCu?: number;
		autoscalingLimitMaxCu?: number;
		suspendTimeoutSeconds?: number;
	} | null {
		const c = this.config.compute;
		if (!c || !endpoint) return null;
		const patch: {
			autoscalingLimitMinCu?: number;
			autoscalingLimitMaxCu?: number;
			suspendTimeoutSeconds?: number;
		} = {};
		let drift = false;
		if (c.minCu !== undefined && c.minCu !== endpoint.autoscalingLimitMinCu) {
			patch.autoscalingLimitMinCu = c.minCu;
			drift = true;
		}
		if (c.maxCu !== undefined && c.maxCu !== endpoint.autoscalingLimitMaxCu) {
			patch.autoscalingLimitMaxCu = c.maxCu;
			drift = true;
		}
		if (c.suspendTimeout !== undefined) {
			const secs =
				c.suspendTimeout === false
					? SUSPEND_NEVER
					: parseDurationSeconds(c.suspendTimeout);
			if (secs !== endpoint.suspendTimeoutSeconds) {
				patch.suspendTimeoutSeconds = secs;
				drift = true;
			}
		}
		return drift ? patch : null;
	}
}

function describeCompute(c: {
	autoscalingLimitMinCu?: number;
	autoscalingLimitMaxCu?: number;
	suspendTimeoutSeconds?: number;
}): string {
	const parts: string[] = [];
	if (c.autoscalingLimitMinCu !== undefined)
		parts.push(`min ${c.autoscalingLimitMinCu} CU`);
	if (c.autoscalingLimitMaxCu !== undefined)
		parts.push(`max ${c.autoscalingLimitMaxCu} CU`);
	if (c.suspendTimeoutSeconds !== undefined)
		parts.push(
			c.suspendTimeoutSeconds === SUSPEND_NEVER
				? "never suspend"
				: `suspend ${c.suspendTimeoutSeconds}s`,
		);
	return parts.join(", ");
}

function pickRole(roles: { name: string }[]): string {
	if (roles.length === 1 && roles[0]) return roles[0].name;
	const owner = roles.find((r) => r.name === DEFAULT_OWNER_ROLE);
	if (owner) return owner.name;
	const managed = new Set(["authenticator", "anonymous", "authenticated"]);
	const app = roles.filter((r) => !managed.has(r.name));
	if (app.length === 1 && app[0]) return app[0].name;
	return roles[0]?.name ?? DEFAULT_OWNER_ROLE;
}
function pickDatabase(databases: { name: string }[]): string {
	if (databases.length === 1 && databases[0]) return databases[0].name;
	const neondb = databases.find((d) => d.name === DEFAULT_DATABASE);
	if (neondb) return neondb.name;
	return databases[0]?.name ?? DEFAULT_DATABASE;
}

// ─── Postgres (connection strings for a project's default branch) ─────────────

type PostgresEnv = { databaseUrl: string; databaseUrlUnpooled: string };
export interface NeonPostgresOptions extends EntityCommon<
	PostgresEnv,
	{ id: string }
> {
	projectId: string | Ref<string>;
	database?: string;
	role?: string;
}

export class NeonPostgres extends NeonEntity<
	NeonPostgresOptions,
	PostgresEnv,
	{ id: string },
	{ branchId: string }
> {
	readonly envSchema = z.object({
		databaseUrl: z.string(),
		databaseUrlUnpooled: z.string(),
	}) as unknown as StandardSchemaV1<unknown, PostgresEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["databaseUrl", "databaseUrlUnpooled"] as const;

	private projectId(): string {
		const id = this.config.projectId;
		if (!id) {
			throw new InfraError(
				ErrorCode.NotFound,
				`neon: ${this.name} has no projectId (is the Neon project provisioned?).`,
			);
		}
		return id;
	}

	async read(
		ctx: ReadContext<NeonCreds, { id: string }>,
	): Promise<{ branchId: string } | null> {
		const id = this.config.projectId;
		if (!id) return null;
		const api = this.api(ctx);
		const project = await api.getProject(id);
		if (!project) return null;
		const branch = await this.defaultBranch(api, id);
		return { branchId: branch.id };
	}

	diff(remote: { branchId: string } | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "postgres", identifier: this.name }];
	}

	async provision(
		ctx: ProvisionContext<NeonCreds, { id: string }>,
	): Promise<ProvisionResult<PostgresEnv, { id: string }>> {
		const env = await this.resolveEnv(ctx);
		const branchId = await this.branchId(ctx);
		return {
			action: ctx.state ? "noop" : "create",
			id: branchId,
			state: { id: branchId },
			env,
		};
	}

	async pullEnv(
		ctx: ReadContext<NeonCreds, { id: string }>,
	): Promise<PostgresEnv> {
		return this.resolveEnv(ctx);
	}

	async deprovision(): Promise<void> {
		// The connection lives with the project; deleting the NeonProject tears it down.
	}

	private async branchId(ctx: { credentials: NeonCreds }): Promise<string> {
		const api = this.api(ctx);
		return (await this.defaultBranch(api, this.projectId())).id;
	}
	private async resolveEnv(ctx: {
		credentials: NeonCreds;
	}): Promise<PostgresEnv> {
		const api = this.api(ctx);
		const projectId = this.projectId();
		const branch = await this.defaultBranch(api, projectId);
		const [databases, roles] = await Promise.all([
			api.listBranchDatabases(projectId, branch.id),
			api.listBranchRoles(projectId, branch.id),
		]);
		const role = this.config.role ?? pickRole(roles);
		const database = this.config.database ?? pickDatabase(databases);
		const [pooled, unpooled] = await Promise.all([
			api.getConnectionUri(projectId, {
				branchId: branch.id,
				databaseName: database,
				roleName: role,
				pooled: true,
			}),
			api.getConnectionUri(projectId, {
				branchId: branch.id,
				databaseName: database,
				roleName: role,
				pooled: false,
			}),
		]);
		return { databaseUrl: pooled, databaseUrlUnpooled: unpooled };
	}
}

// ─── Read replica (read-only compute endpoint) ────────────────────────────────

function computeEndpointInput(c?: NeonComputeConfig): {
	autoscalingLimitMinCu?: number;
	autoscalingLimitMaxCu?: number;
	suspendTimeoutSeconds?: number;
} {
	if (!c) return {};
	const out: {
		autoscalingLimitMinCu?: number;
		autoscalingLimitMaxCu?: number;
		suspendTimeoutSeconds?: number;
	} = {};
	if (c.minCu !== undefined) out.autoscalingLimitMinCu = c.minCu;
	if (c.maxCu !== undefined) out.autoscalingLimitMaxCu = c.maxCu;
	if (c.suspendTimeout !== undefined) {
		out.suspendTimeoutSeconds =
			c.suspendTimeout === false
				? SUSPEND_NEVER
				: parseDurationSeconds(c.suspendTimeout);
	}
	return out;
}

type ReadReplicaEnv = {
	readReplicaUrl: string;
	readReplicaUrlUnpooled: string;
};
export interface NeonReadReplicaOptions extends EntityCommon<
	ReadReplicaEnv,
	{ id: string }
> {
	projectId: string | Ref<string>;
	/** Branch id to attach the replica to (default: the project's default branch). */
	branch?: string | Ref<string>;
	/** Autoscaling + scale-to-zero for the replica's compute. */
	compute?: NeonComputeConfig;
	database?: string;
	role?: string;
}

/**
 * A Neon **read replica**: a `read_only` compute endpoint on a branch, with its own connection
 * string (`READ_REPLICA_URL` / `READ_REPLICA_URL_UNPOOLED`). Rename via `envNames` if your app
 * expects a different var.
 */
export class NeonReadReplica extends NeonEntity<
	NeonReadReplicaOptions,
	ReadReplicaEnv,
	{ id: string },
	NeonEndpointSnapshot
> {
	readonly envSchema = z.object({
		readReplicaUrl: z.string(),
		readReplicaUrlUnpooled: z.string(),
	}) as unknown as StandardSchemaV1<unknown, ReadReplicaEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["readReplicaUrl", "readReplicaUrlUnpooled"] as const;

	private projectId(): string {
		const id = this.config.projectId;
		if (!id) {
			throw new InfraError(
				ErrorCode.NotFound,
				`neon: ${this.name} has no projectId (is the Neon project provisioned?).`,
			);
		}
		return id;
	}
	private async branch(api: NeonApi): Promise<NeonBranchSnapshot> {
		const bid = this.config.branch;
		if (bid) {
			const branches = await api.listBranches(this.projectId());
			const found = branches.find((b) => b.id === bid);
			if (found) return found;
		}
		return this.defaultBranch(api, this.projectId());
	}
	private async findEndpoint(
		api: NeonApi,
		endpointId: string | undefined,
	): Promise<NeonEndpointSnapshot | undefined> {
		if (!endpointId) return undefined;
		const endpoints = await api.listEndpoints(this.projectId());
		return endpoints.find((e) => e.id === endpointId);
	}

	async read(
		ctx: ReadContext<NeonCreds, { id: string }>,
	): Promise<NeonEndpointSnapshot | null> {
		if (!ctx.state?.id || !this.config.projectId) return null;
		const api = this.api(ctx);
		return (await this.findEndpoint(api, ctx.state.id)) ?? null;
	}
	diff(remote: NeonEndpointSnapshot | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "read-replica", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<NeonCreds, { id: string }>,
	): Promise<ProvisionResult<ReadReplicaEnv, { id: string }>> {
		const api = this.api(ctx);
		const projectId = this.projectId();
		const branch = await this.branch(api);
		let endpoint = await this.findEndpoint(api, ctx.state?.id);
		let action: ProvisionResult<ReadReplicaEnv, { id: string }>["action"] =
			"noop";
		if (!endpoint) {
			await api.waitForProjectIdle(projectId);
			endpoint = await api.createEndpoint(projectId, {
				branchId: branch.id,
				type: "read_only",
				...computeEndpointInput(this.config.compute),
			});
			action = "create";
		}
		const env = await this.resolveEnv(ctx, branch, endpoint.id);
		return { action, id: endpoint.id, state: { id: endpoint.id }, env };
	}
	async pullEnv(
		ctx: ReadContext<NeonCreds, { id: string }>,
	): Promise<ReadReplicaEnv> {
		const api = this.api(ctx);
		const branch = await this.branch(api);
		if (!ctx.state?.id) {
			throw new InfraError(
				ErrorCode.NotFound,
				`neon: read replica ${this.name} is not provisioned yet — run \`infra apply\` first.`,
			);
		}
		return this.resolveEnv(ctx, branch, ctx.state.id);
	}
	async deprovision(
		ctx: ProvisionContext<NeonCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id || !this.config.projectId) return;
		const api = this.api(ctx);
		await api.deleteEndpoint(this.projectId(), ctx.state.id);
	}

	private async resolveEnv(
		ctx: { credentials: NeonCreds },
		branch: NeonBranchSnapshot,
		endpointId: string,
	): Promise<ReadReplicaEnv> {
		const api = this.api(ctx);
		const projectId = this.projectId();
		const [databases, roles] = await Promise.all([
			api.listBranchDatabases(projectId, branch.id),
			api.listBranchRoles(projectId, branch.id),
		]);
		const role = this.config.role ?? pickRole(roles);
		const database = this.config.database ?? pickDatabase(databases);
		const [pooled, unpooled] = await Promise.all([
			api.getConnectionUri(projectId, {
				branchId: branch.id,
				databaseName: database,
				roleName: role,
				pooled: true,
				endpointId,
			}),
			api.getConnectionUri(projectId, {
				branchId: branch.id,
				databaseName: database,
				roleName: role,
				pooled: false,
				endpointId,
			}),
		]);
		return { readReplicaUrl: pooled, readReplicaUrlUnpooled: unpooled };
	}
}

// ─── Auth (Neon Auth / Better Auth) ───────────────────────────────────────────

type AuthEnv = { authBaseUrl: string; authJwksUrl: string };
export interface NeonAuthOptions extends EntityCommon<AuthEnv, { id: string }> {
	projectId: string | Ref<string>;
}

export class NeonAuth extends NeonEntity<
	NeonAuthOptions,
	AuthEnv,
	{ id: string },
	{ enabled: true }
> {
	readonly envSchema = z.object({
		authBaseUrl: z.string(),
		authJwksUrl: z.string(),
	}) as unknown as StandardSchemaV1<unknown, AuthEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["authBaseUrl", "authJwksUrl"] as const;

	private pid(): string {
		const id = this.config.projectId;
		if (!id)
			throw new InfraError(
				ErrorCode.NotFound,
				`neon: ${this.name} has no projectId.`,
			);
		return id;
	}

	async read(
		ctx: ReadContext<NeonCreds, { id: string }>,
	): Promise<{ enabled: true } | null> {
		const id = this.config.projectId;
		if (!id) return null;
		const api = this.api(ctx);
		const branch = await this.defaultBranch(api, id);
		const auth = await api.getNeonAuth(id, branch.id);
		return auth ? { enabled: true } : null;
	}

	diff(remote: { enabled: true } | null): Change[] {
		return remote
			? []
			: [
					{
						action: "create",
						kind: "service",
						identifier: "auth",
						detail: "enable Neon Auth",
					},
				];
	}

	async provision(
		ctx: ProvisionContext<NeonCreds, { id: string }>,
	): Promise<ProvisionResult<AuthEnv, { id: string }>> {
		const api = this.api(ctx);
		const projectId = this.pid();
		const branch = await this.defaultBranch(api, projectId);
		const existing = await api.getNeonAuth(projectId, branch.id);
		if (!existing) await api.enableNeonAuth(projectId, branch.id, {});
		const env = await this.resolveEnv(ctx);
		return {
			action: existing ? "noop" : "create",
			id: `${projectId}:auth`,
			state: { id: `${projectId}:auth` },
			env,
		};
	}

	async pullEnv(ctx: ReadContext<NeonCreds, { id: string }>): Promise<AuthEnv> {
		return this.resolveEnv(ctx);
	}
	async deprovision(): Promise<void> {}

	private async resolveEnv(ctx: { credentials: NeonCreds }): Promise<AuthEnv> {
		const api = this.api(ctx);
		const projectId = this.pid();
		const branch = await this.defaultBranch(api, projectId);
		const auth = await api.getNeonAuth(projectId, branch.id);
		if (!auth) {
			throw new InfraError(
				ErrorCode.NotFound,
				`neon: auth not enabled for ${this.name}; run \`infra apply\` first.`,
			);
		}
		return { authBaseUrl: auth.baseUrl ?? "", authJwksUrl: auth.jwksUrl };
	}
}

// ─── Data API (PostgREST) ─────────────────────────────────────────────────────

type DataApiEnv = { dataApiUrl: string };
export interface NeonDataApiOptions extends EntityCommon<
	DataApiEnv,
	{ id: string }
> {
	projectId: string | Ref<string>;
	authProvider?: "neon" | "external";
	jwksUrl?: string;
	providerName?: string;
	jwtAudience?: string;
}

export class NeonDataApi extends NeonEntity<
	NeonDataApiOptions,
	DataApiEnv,
	{ id: string },
	{ url: string }
> {
	readonly envSchema = z.object({
		dataApiUrl: z.string(),
	}) as unknown as StandardSchemaV1<unknown, DataApiEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["dataApiUrl"] as const;

	private pid(): string {
		const id = this.config.projectId;
		if (!id)
			throw new InfraError(
				ErrorCode.NotFound,
				`neon: ${this.name} has no projectId.`,
			);
		return id;
	}

	async read(
		ctx: ReadContext<NeonCreds, { id: string }>,
	): Promise<{ url: string } | null> {
		const id = this.config.projectId;
		if (!id) return null;
		const api = this.api(ctx);
		const branch = await this.defaultBranch(api, id);
		const db = pickDatabase(await api.listBranchDatabases(id, branch.id));
		const snap = await api.getNeonDataApi(id, branch.id, db);
		return snap ? { url: snap.url } : null;
	}

	diff(remote: { url: string } | null): Change[] {
		return remote
			? []
			: [
					{
						action: "create",
						kind: "service",
						identifier: "dataApi",
						detail: "enable Neon Data API",
					},
				];
	}

	async provision(
		ctx: ProvisionContext<NeonCreds, { id: string }>,
	): Promise<ProvisionResult<DataApiEnv, { id: string }>> {
		const api = this.api(ctx);
		const projectId = this.pid();
		const branch = await this.defaultBranch(api, projectId);
		const db = pickDatabase(
			await api.listBranchDatabases(projectId, branch.id),
		);
		const existing = await api.getNeonDataApi(projectId, branch.id, db);
		const o = this.config;
		if (!existing) {
			await api.enableNeonDataApi(projectId, branch.id, db, {
				authProvider: o.authProvider ?? "neon",
				...(o.jwksUrl ? { jwksUrl: o.jwksUrl } : {}),
				...(o.providerName ? { providerName: o.providerName } : {}),
				...(o.jwtAudience ? { jwtAudience: o.jwtAudience } : {}),
			});
		}
		const snap = await api.getNeonDataApi(projectId, branch.id, db);
		return {
			action: existing ? "noop" : "create",
			id: `${projectId}:dataapi`,
			state: { id: `${projectId}:dataapi` },
			env: { dataApiUrl: snap?.url ?? "" },
		};
	}

	async pullEnv(
		ctx: ReadContext<NeonCreds, { id: string }>,
	): Promise<DataApiEnv> {
		const api = this.api(ctx);
		const projectId = this.pid();
		const branch = await this.defaultBranch(api, projectId);
		const db = pickDatabase(
			await api.listBranchDatabases(projectId, branch.id),
		);
		const snap = await api.getNeonDataApi(projectId, branch.id, db);
		if (!snap) {
			throw new InfraError(
				ErrorCode.NotFound,
				`neon: Data API not enabled for ${this.name}; run \`infra apply\` first.`,
			);
		}
		return { dataApiUrl: snap.url };
	}
	async deprovision(): Promise<void> {}
}

// ─── Account (org scope + auth anchor) ────────────────────────────────────────

export type NeonAccountOptions = AccountOptions;

export class NeonAccount extends Account<NeonCreds> {
	readonly credentialsSchema = credentialsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { NEON_API_KEY: neonTokenFromBag(bag) ?? "" };
	}
	cliAuth(): CliAuth {
		return {
			providerId: "neon",
			envVar: "NEON_API_KEY",
			detect: ["neonctl", "me"],
			login: ["neonctl", "auth"],
		};
	}
	async listScopes(credentials: NeonCreds): Promise<AccountScope[]> {
		const api = new NeonApi({
			token: credentials.NEON_API_KEY,
			apiHost: process.env.NEON_API_HOST ?? DEFAULT_NEON_API_HOST,
		});
		const orgs = await api.listOrganizations();
		return orgs.map((o) => ({ id: o.id, name: o.name }));
	}
}
