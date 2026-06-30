import {
	createRestClient,
	ErrorCode,
	InfraError,
	isInfraError,
	type RestClient,
} from "@infra-ts/core";

/** A Neon project as infra-ts reads it. */
export interface NeonProjectSnapshot {
	id: string;
	name: string;
	orgId?: string;
	regionId: string;
	pgVersion: number;
	/** Whether logical replication (`wal_level=logical`) is enabled. */
	logicalReplication: boolean;
}

/** A Neon branch as infra-ts reads it. */
export interface NeonBranchSnapshot {
	id: string;
	name: string;
	isDefault: boolean;
	isProtected: boolean;
	parentId?: string;
	expiresAt?: string;
}

/** A Neon read-write compute endpoint. */
export interface NeonEndpointSnapshot {
	id: string;
	branchId: string;
	type: string;
	autoscalingLimitMinCu?: number;
	autoscalingLimitMaxCu?: number;
	suspendTimeoutSeconds?: number;
}

/** Settings infra-ts can change on a branch's read-write endpoint. */
export interface NeonComputePatch {
	autoscalingLimitMinCu?: number;
	autoscalingLimitMaxCu?: number;
	suspendTimeoutSeconds?: number;
}

export interface CreateProjectInput {
	name: string;
	orgId?: string;
	regionId: string;
	pgVersion: number;
	/** Enable logical replication at creation (cannot be disabled later). */
	logicalReplication?: boolean;
}

/** Input for {@link NeonApi.createEndpoint}: a new compute endpoint on a branch. */
export interface CreateEndpointInput {
	branchId: string;
	/** `read_write` (primary) or `read_only` (read replica). */
	type: "read_write" | "read_only";
	autoscalingLimitMinCu?: number;
	autoscalingLimitMaxCu?: number;
	suspendTimeoutSeconds?: number;
}

/** Neon Auth integration as infra-ts reads it. */
export interface NeonAuthSnapshot {
	authProviderProjectId: string;
	jwksUrl: string;
	baseUrl?: string;
}

/** Camel-cased subset of the Neon Data API runtime settings. */
export interface NeonDataApiSettings {
	dbAggregatesEnabled?: boolean;
	dbAnonRole?: string;
	dbExtraSearchPath?: string;
	dbMaxRows?: number;
	dbSchemas?: string[];
	jwtRoleClaimKey?: string;
	jwtCacheMaxLifetime?: number;
	openapiMode?: "ignore-privileges" | "disabled";
	serverCorsAllowedOrigins?: string;
	serverTimingEnabled?: boolean;
}

/** Create-time wiring for the Neon Data API integration. */
export interface EnableDataApiInput {
	authProvider?: "neon" | "external";
	jwksUrl?: string;
	providerName?: string;
	jwtAudience?: string;
	settings?: NeonDataApiSettings;
}

/** Neon Data API integration as infra-ts reads it. */
export interface NeonDataApiSnapshot {
	url: string;
	settings?: NeonDataApiSettings;
}

/** Anonymous-access level for a branchable object-storage bucket. */
export type NeonBucketAccessLevel = "private" | "public_read";

/** A Neon object-storage bucket. */
export interface NeonBucketSnapshot {
	name: string;
	accessLevel: NeonBucketAccessLevel;
}

/** A deployed Neon Function. */
export interface NeonFunctionSnapshot {
	id: string;
	slug: string;
	name: string;
	invocationUrl: string;
}

/** Capability a branch-scoped credential may exercise. */
export type NeonCredentialScope =
	| "storage:read"
	| "storage:write"
	| "ai_gateway:invoke"
	| "functions:invoke";

/** A freshly-minted branch credential (secrets returned exactly once). */
export interface NeonCredentialSecret {
	tokenId: string;
	apiToken: string;
	s3SecretAccessKey: string;
}

/** A branch's object-storage configuration. */
export interface NeonBranchStorageSnapshot {
	s3Endpoint: string;
	region: string;
	forcePathStyle: boolean;
}

/** Input for {@link NeonApi.deployFunction}: a built bundle + runtime + env. */
export interface DeployFunctionInput {
	bundle: Uint8Array;
	runtime: string;
	environment: Record<string, string>;
}

/**
 * A thin, typed wrapper around the subset of the Neon management REST API that the infra-ts Neon
 * provider needs. Every method maps to exactly one endpoint and normalizes the snake_case
 * response into the camelCase snapshots above — no caching, no client state.
 */
export class NeonApi {
	private readonly rest: RestClient;
	private readonly token: string;
	private readonly apiHost: string;
	private readonly doFetch: typeof fetch;

	constructor(options: {
		token: string;
		apiHost: string;
		fetch?: typeof fetch;
	}) {
		this.token = options.token;
		this.apiHost = options.apiHost.replace(/\/$/, "");
		this.doFetch = options.fetch ?? globalThis.fetch;
		this.rest = createRestClient({
			provider: "neon",
			baseUrl: options.apiHost,
			auth: { type: "bearer", token: options.token },
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
	}

	/** List the organizations the authenticated user belongs to (for `infra link`). */
	async listOrganizations(): Promise<{ id: string; name: string }[]> {
		const res = await this.rest.get<{
			organizations?: { id: string; name: string }[];
		}>("/users/me/organizations");
		return res.organizations ?? [];
	}

	async createProject(input: CreateProjectInput): Promise<{
		project: NeonProjectSnapshot;
		defaultBranch?: NeonBranchSnapshot;
		endpoint?: NeonEndpointSnapshot;
	}> {
		const body: Record<string, unknown> = {
			project: {
				name: input.name,
				region_id: input.regionId,
				pg_version: input.pgVersion,
				...(input.orgId ? { org_id: input.orgId } : {}),
				...(input.logicalReplication
					? { settings: { enable_logical_replication: true } }
					: {}),
			},
		};
		const res = await this.rest.post<{
			project: RawProject;
			branches?: RawBranch[];
			endpoints?: RawEndpoint[];
		}>("/projects", { body });
		const branch = res.branches?.[0];
		const endpoint = res.endpoints?.[0];
		return {
			project: mapProject(res.project),
			...(branch ? { defaultBranch: mapBranch(branch) } : {}),
			...(endpoint ? { endpoint: mapEndpoint(endpoint) } : {}),
		};
	}

	/** Get a project, or `null` when it no longer exists (404). */
	async getProject(projectId: string): Promise<NeonProjectSnapshot | null> {
		const res = await this.rest.get<{ project: RawProject } | null>(
			`/projects/${projectId}`,
			{ allowStatuses: [404] },
		);
		return res ? mapProject(res.project) : null;
	}

	async listBranches(projectId: string): Promise<NeonBranchSnapshot[]> {
		const res = await this.rest.get<{ branches: RawBranch[] }>(
			`/projects/${projectId}/branches`,
		);
		return res.branches.map(mapBranch);
	}

	async listEndpoints(projectId: string): Promise<NeonEndpointSnapshot[]> {
		const res = await this.rest.get<{ endpoints: RawEndpoint[] }>(
			`/projects/${projectId}/endpoints`,
		);
		return res.endpoints.map(mapEndpoint);
	}

	/** Create a compute endpoint (e.g. a `read_only` read replica) on a branch. */
	async createEndpoint(
		projectId: string,
		input: CreateEndpointInput,
	): Promise<NeonEndpointSnapshot> {
		const endpoint: Record<string, unknown> = {
			branch_id: input.branchId,
			type: input.type,
		};
		if (input.autoscalingLimitMinCu !== undefined)
			endpoint.autoscaling_limit_min_cu = input.autoscalingLimitMinCu;
		if (input.autoscalingLimitMaxCu !== undefined)
			endpoint.autoscaling_limit_max_cu = input.autoscalingLimitMaxCu;
		if (input.suspendTimeoutSeconds !== undefined)
			endpoint.suspend_timeout_seconds = input.suspendTimeoutSeconds;
		const res = await this.withLockRetry(projectId, () =>
			this.rest.post<{ endpoint: RawEndpoint }>(
				`/projects/${projectId}/endpoints`,
				{ body: { endpoint } },
			),
		);
		return mapEndpoint(res.endpoint);
	}

	async deleteEndpoint(projectId: string, endpointId: string): Promise<void> {
		await this.withLockRetry(projectId, () =>
			this.rest.delete(`/projects/${projectId}/endpoints/${endpointId}`, {
				allowStatuses: [404],
			}),
		);
	}

	/** Update project-level settings (e.g. enable logical replication — one-way). */
	async updateProjectSettings(
		projectId: string,
		settings: { logicalReplication?: boolean },
	): Promise<void> {
		const apiSettings: Record<string, unknown> = {};
		if (settings.logicalReplication !== undefined)
			apiSettings.enable_logical_replication = settings.logicalReplication;
		if (Object.keys(apiSettings).length === 0) return;
		await this.withLockRetry(projectId, () =>
			this.rest.patch(`/projects/${projectId}`, {
				body: { project: { settings: apiSettings } },
			}),
		);
	}

	async updateBranchExpiry(
		projectId: string,
		branchId: string,
		expiresAt: string | null,
	): Promise<void> {
		await this.withLockRetry(projectId, () =>
			this.rest.patch(`/projects/${projectId}/branches/${branchId}`, {
				body: { branch: { expires_at: expiresAt } },
			}),
		);
	}

	async updateEndpoint(
		projectId: string,
		endpointId: string,
		patch: NeonComputePatch,
	): Promise<void> {
		const endpoint: Record<string, unknown> = {};
		if (patch.autoscalingLimitMinCu !== undefined)
			endpoint.autoscaling_limit_min_cu = patch.autoscalingLimitMinCu;
		if (patch.autoscalingLimitMaxCu !== undefined)
			endpoint.autoscaling_limit_max_cu = patch.autoscalingLimitMaxCu;
		if (patch.suspendTimeoutSeconds !== undefined)
			endpoint.suspend_timeout_seconds = patch.suspendTimeoutSeconds;
		await this.withLockRetry(projectId, () =>
			this.rest.patch(`/projects/${projectId}/endpoints/${endpointId}`, {
				body: { endpoint },
			}),
		);
	}

	/**
	 * Run a mutation, retrying on `423 Locked` (the project briefly locks while an operation is
	 * in flight). Between attempts we wait for the project to go idle, so this resolves as soon
	 * as the lock clears rather than busy-looping.
	 */
	private async withLockRetry<T>(
		projectId: string,
		fn: () => Promise<T>,
		attempts = 6,
	): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				return await fn();
			} catch (error) {
				if (isInfraError(error) && error.details?.status === 423) {
					lastError = error;
					await this.waitForProjectIdle(projectId, { timeoutMs: 30_000 });
					await sleep(1000);
					continue;
				}
				throw error;
			}
		}
		throw lastError;
	}

	async listBranchDatabases(
		projectId: string,
		branchId: string,
	): Promise<{ name: string; ownerName: string }[]> {
		const res = await this.rest.get<{
			databases: { name: string; owner_name: string }[];
		}>(`/projects/${projectId}/branches/${branchId}/databases`);
		return res.databases.map((d) => ({
			name: d.name,
			ownerName: d.owner_name,
		}));
	}

	async listBranchRoles(
		projectId: string,
		branchId: string,
	): Promise<{ name: string }[]> {
		const res = await this.rest.get<{ roles: { name: string }[] }>(
			`/projects/${projectId}/branches/${branchId}/roles`,
		);
		return res.roles.map((r) => ({ name: r.name }));
	}

	async getConnectionUri(
		projectId: string,
		params: {
			branchId: string;
			databaseName: string;
			roleName: string;
			pooled: boolean;
			/** Target a specific endpoint (e.g. a read replica) instead of the branch default. */
			endpointId?: string;
		},
	): Promise<string> {
		const res = await this.rest.get<{ uri: string }>(
			`/projects/${projectId}/connection_uri`,
			{
				query: {
					branch_id: params.branchId,
					database_name: params.databaseName,
					role_name: params.roleName,
					pooled: params.pooled,
					...(params.endpointId ? { endpoint_id: params.endpointId } : {}),
				},
			},
		);
		return res.uri;
	}

	/** List the project's operations (used to wait for create/update to settle). */
	async listOperations(projectId: string): Promise<{ status: string }[]> {
		const res = await this.rest.get<{ operations: { status: string }[] }>(
			`/projects/${projectId}/operations`,
		);
		return res.operations ?? [];
	}

	/**
	 * Poll the project's operations until none are pending. A freshly created (or just-mutated)
	 * Neon project briefly holds a lock; mutating it during that window returns `423 Locked`, so
	 * callers wait for idle first. Resolves when idle or after `timeoutMs` (best-effort).
	 */
	async waitForProjectIdle(
		projectId: string,
		options: { timeoutMs?: number; intervalMs?: number } = {},
	): Promise<void> {
		const timeoutMs = options.timeoutMs ?? 90_000;
		const intervalMs = options.intervalMs ?? 1500;
		const pending = new Set(["running", "scheduling", "cancelling"]);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const operations = await this.listOperations(projectId);
			if (!operations.some((op) => pending.has(op.status))) return;
			await sleep(intervalMs);
		}
	}

	// ─── Neon Auth ──────────────────────────────────────────────────────────

	/** Get the branch's Neon Auth integration, or `null` when none exists (404). */
	async getNeonAuth(
		projectId: string,
		branchId: string,
	): Promise<NeonAuthSnapshot | null> {
		const res = await this.rest.get<RawAuth | null>(
			`/projects/${projectId}/branches/${branchId}/auth`,
			{ allowStatuses: [404] },
		);
		return res ? mapAuth(res) : null;
	}

	/** Enable Neon Auth (Better Auth) on a branch. Idempotent: a 409 re-fetches the existing one. */
	async enableNeonAuth(
		projectId: string,
		branchId: string,
		input: { databaseName?: string } = {},
	): Promise<NeonAuthSnapshot> {
		const existing = await this.rest.post<RawAuth | null>(
			`/projects/${projectId}/branches/${branchId}/auth`,
			{
				body: {
					auth_provider: "better_auth",
					...(input.databaseName ? { database_name: input.databaseName } : {}),
				},
				allowStatuses: [409],
			},
		);
		if (existing) return mapAuth(existing);
		const fetched = await this.getNeonAuth(projectId, branchId);
		if (fetched) return fetched;
		throw gateError("Neon Auth", undefined);
	}

	// ─── Neon Data API ──────────────────────────────────────────────────────

	private dataApiPath(pid: string, bid: string, db: string): string {
		return `/projects/${pid}/branches/${bid}/databases/${db}/data_api`;
	}

	async getNeonDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<NeonDataApiSnapshot | null> {
		try {
			const res = await this.rest.get<RawDataApi | null>(
				this.dataApiPath(projectId, branchId, databaseName),
				{ allowStatuses: [404] },
			);
			return res ? mapDataApi(res) : null;
		} catch (error) {
			throw gateOrRethrow(error, "Neon Data API");
		}
	}

	async enableNeonDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
		input?: EnableDataApiInput,
	): Promise<NeonDataApiSnapshot> {
		try {
			const res = await this.withLockRetry(projectId, () =>
				this.rest.post<RawDataApi>(
					this.dataApiPath(projectId, branchId, databaseName),
					{ body: dataApiCreateBody(input), allowStatuses: [409] },
				),
			);
			if (res) return mapDataApi(res);
			const fetched = await this.getNeonDataApi(
				projectId,
				branchId,
				databaseName,
			);
			if (fetched) return fetched;
			throw gateError("Neon Data API", undefined);
		} catch (error) {
			throw gateOrRethrow(error, "Neon Data API");
		}
	}

	async updateNeonDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
		settings: NeonDataApiSettings,
	): Promise<void> {
		await this.withLockRetry(projectId, () =>
			this.rest.patch(this.dataApiPath(projectId, branchId, databaseName), {
				body: { settings: dataApiSettingsToApi(settings) },
			}),
		);
	}

	// ─── Experimental: object-storage buckets ─────────────────────────────────

	async listBranchBuckets(
		projectId: string,
		branchId: string,
	): Promise<NeonBucketSnapshot[]> {
		try {
			const res = await this.rest.get<{ buckets: RawBucket[] }>(
				`/projects/${projectId}/branches/${branchId}/buckets`,
			);
			return (res.buckets ?? []).map(mapBucket);
		} catch (error) {
			throw gateOrRethrow(error, "Object storage (buckets)");
		}
	}

	async createBranchBucket(
		projectId: string,
		branchId: string,
		input: { name: string; accessLevel: NeonBucketAccessLevel },
	): Promise<NeonBucketSnapshot> {
		try {
			const res = await this.withLockRetry(projectId, () =>
				this.rest.post<{ bucket: RawBucket }>(
					`/projects/${projectId}/branches/${branchId}/buckets`,
					{ body: { name: input.name, access_level: input.accessLevel } },
				),
			);
			return mapBucket(res.bucket);
		} catch (error) {
			throw gateOrRethrow(error, "Object storage (buckets)");
		}
	}

	async deleteBranchBucket(
		projectId: string,
		branchId: string,
		name: string,
	): Promise<void> {
		await this.rest.delete(
			`/projects/${projectId}/branches/${branchId}/buckets/${encodeURIComponent(name)}`,
			{ allowStatuses: [404] },
		);
	}

	async getBranchStorage(
		projectId: string,
		branchId: string,
	): Promise<NeonBranchStorageSnapshot | null> {
		try {
			const res = await this.rest.get<RawStorage | null>(
				`/projects/${projectId}/branches/${branchId}/storage`,
				{ allowStatuses: [404] },
			);
			return res
				? {
						s3Endpoint: res.s3_endpoint,
						region: res.region,
						forcePathStyle: res.force_path_style,
					}
				: null;
		} catch (error) {
			throw gateOrRethrow(error, "Object storage");
		}
	}

	// ─── Experimental: functions ──────────────────────────────────────────────

	async listBranchFunctions(
		projectId: string,
		branchId: string,
	): Promise<NeonFunctionSnapshot[]> {
		try {
			const res = await this.rest.get<{ functions: RawFunction[] }>(
				`/projects/${projectId}/branches/${branchId}/functions`,
			);
			return (res.functions ?? []).map(mapFunction);
		} catch (error) {
			throw gateOrRethrow(error, "Functions");
		}
	}

	/** Deploy a built bundle to a function (multipart/form-data). Creates it on first deploy. */
	async deployBranchFunction(
		projectId: string,
		branchId: string,
		slug: string,
		input: DeployFunctionInput,
	): Promise<{ id: number; status: string }> {
		const form = new FormData();
		form.set(
			"zip",
			new Blob([input.bundle], { type: "application/zip" }),
			"bundle.zip",
		);
		form.set("runtime", input.runtime);
		if (Object.keys(input.environment).length > 0) {
			form.set("environment", JSON.stringify(input.environment));
		}
		const url = `${this.apiHost}/projects/${projectId}/branches/${branchId}/functions/${encodeURIComponent(slug)}/deployments`;
		let response: Response;
		try {
			response = await this.doFetch(url, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.token}` },
				body: form,
			});
		} catch (cause) {
			throw new InfraError(
				ErrorCode.RequestFailed,
				`neon: deploy function ${slug} failed to connect: ${(cause as Error)?.message ?? String(cause)}`,
				{ cause },
			);
		}
		const text = await response.text();
		if (!response.ok) {
			const err = new InfraError(
				ErrorCode.RequestFailed,
				`neon: deploy function ${slug} → ${response.status}: ${text.slice(0, 200)}`,
				{ details: { status: response.status, body: text } },
			);
			throw gateOrRethrow(err, "Functions");
		}
		const parsed = JSON.parse(text) as {
			deployment: { id: number; status: string };
		};
		return parsed.deployment;
	}

	async deleteBranchFunction(
		projectId: string,
		branchId: string,
		slug: string,
	): Promise<void> {
		await this.rest.delete(
			`/projects/${projectId}/branches/${branchId}/functions/${encodeURIComponent(slug)}`,
			{ allowStatuses: [404] },
		);
	}

	// ─── Experimental: branch-scoped credentials ──────────────────────────────

	async createCredential(
		projectId: string,
		branchId: string,
		input: { scopes: NeonCredentialScope[]; name?: string },
	): Promise<NeonCredentialSecret> {
		try {
			const res = await this.withLockRetry(projectId, () =>
				this.rest.post<RawCredential>(
					`/projects/${projectId}/branches/${branchId}/credentials`,
					{
						body: {
							scopes: input.scopes,
							principal_type: "user",
							...(input.name ? { name: input.name } : {}),
						},
					},
				),
			);
			return {
				tokenId: res.token_id,
				apiToken: res.api_token,
				s3SecretAccessKey: res.s3_secret_access_key,
			};
		} catch (error) {
			throw gateOrRethrow(error, "Branch credentials");
		}
	}

	async deleteProject(projectId: string): Promise<void> {
		await this.withLockRetry(projectId, () =>
			this.rest.delete(`/projects/${projectId}`, { allowStatuses: [404] }),
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawProject {
	id: string;
	name: string;
	org_id?: string;
	region_id: string;
	pg_version: number;
	settings?: { enable_logical_replication?: boolean };
}
interface RawBranch {
	id: string;
	name: string;
	default?: boolean;
	protected?: boolean;
	parent_id?: string;
	expires_at?: string;
}
interface RawEndpoint {
	id: string;
	branch_id: string;
	type: string;
	autoscaling_limit_min_cu?: number;
	autoscaling_limit_max_cu?: number;
	suspend_timeout_seconds?: number;
}

function mapProject(p: RawProject): NeonProjectSnapshot {
	return {
		id: p.id,
		name: p.name,
		...(p.org_id ? { orgId: p.org_id } : {}),
		regionId: p.region_id,
		pgVersion: p.pg_version,
		logicalReplication: p.settings?.enable_logical_replication === true,
	};
}
function mapBranch(b: RawBranch): NeonBranchSnapshot {
	return {
		id: b.id,
		name: b.name,
		isDefault: b.default === true,
		isProtected: b.protected === true,
		...(b.parent_id ? { parentId: b.parent_id } : {}),
		...(b.expires_at ? { expiresAt: b.expires_at } : {}),
	};
}
function mapEndpoint(e: RawEndpoint): NeonEndpointSnapshot {
	return {
		id: e.id,
		branchId: e.branch_id,
		type: e.type,
		...(e.autoscaling_limit_min_cu !== undefined
			? { autoscalingLimitMinCu: e.autoscaling_limit_min_cu }
			: {}),
		...(e.autoscaling_limit_max_cu !== undefined
			? { autoscalingLimitMaxCu: e.autoscaling_limit_max_cu }
			: {}),
		...(e.suspend_timeout_seconds !== undefined
			? { suspendTimeoutSeconds: e.suspend_timeout_seconds }
			: {}),
	};
}

// ─── experimental raw shapes + mappers ──────────────────────────────────────

interface RawAuth {
	auth_provider_project_id: string;
	jwks_url: string;
	base_url?: string;
}
interface RawDataApi {
	url: string;
	settings?: RawDataApiSettings;
}
interface RawDataApiSettings {
	db_aggregates_enabled?: boolean;
	db_anon_role?: string;
	db_extra_search_path?: string;
	db_max_rows?: number;
	db_schemas?: string[];
	jwt_role_claim_key?: string;
	jwt_cache_max_lifetime?: number;
	openapi_mode?: string;
	server_cors_allowed_origins?: string;
	server_timing_enabled?: boolean;
}
interface RawBucket {
	name: string;
	access_level?: string;
}
interface RawFunction {
	id: string;
	slug: string;
	name: string;
	invocation_url: string;
}
interface RawCredential {
	token_id: string;
	api_token: string;
	s3_secret_access_key: string;
}
interface RawStorage {
	s3_endpoint: string;
	region: string;
	force_path_style: boolean;
}

function mapAuth(a: RawAuth): NeonAuthSnapshot {
	return {
		authProviderProjectId: a.auth_provider_project_id,
		jwksUrl: a.jwks_url,
		...(a.base_url ? { baseUrl: a.base_url } : {}),
	};
}
function mapBucket(b: RawBucket): NeonBucketSnapshot {
	return {
		name: b.name,
		accessLevel: b.access_level === "public_read" ? "public_read" : "private",
	};
}
function mapFunction(f: RawFunction): NeonFunctionSnapshot {
	return {
		id: f.id,
		slug: f.slug,
		name: f.name,
		invocationUrl: f.invocation_url,
	};
}
function mapDataApi(d: RawDataApi): NeonDataApiSnapshot {
	const settings = dataApiSettingsFromApi(d.settings);
	return { url: d.url, ...(settings ? { settings } : {}) };
}

function dataApiCreateBody(
	input: EnableDataApiInput | undefined,
): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (!input) return body;
	if (input.authProvider !== undefined)
		body.auth_provider =
			input.authProvider === "neon" ? "neon_auth" : "external";
	if (input.jwksUrl !== undefined) body.jwks_url = input.jwksUrl;
	if (input.providerName !== undefined) body.provider_name = input.providerName;
	if (input.jwtAudience !== undefined) body.jwt_audience = input.jwtAudience;
	if (input.settings) {
		const settings = dataApiSettingsToApi(input.settings);
		if (Object.keys(settings).length > 0) body.settings = settings;
	}
	return body;
}

function dataApiSettingsToApi(
	settings: NeonDataApiSettings,
): RawDataApiSettings {
	const out: RawDataApiSettings = {};
	if (settings.dbAggregatesEnabled !== undefined)
		out.db_aggregates_enabled = settings.dbAggregatesEnabled;
	if (settings.dbAnonRole !== undefined) out.db_anon_role = settings.dbAnonRole;
	if (settings.dbExtraSearchPath !== undefined)
		out.db_extra_search_path = settings.dbExtraSearchPath;
	if (settings.dbMaxRows !== undefined) out.db_max_rows = settings.dbMaxRows;
	if (settings.dbSchemas !== undefined) out.db_schemas = settings.dbSchemas;
	if (settings.jwtRoleClaimKey !== undefined)
		out.jwt_role_claim_key = settings.jwtRoleClaimKey;
	if (settings.jwtCacheMaxLifetime !== undefined)
		out.jwt_cache_max_lifetime = settings.jwtCacheMaxLifetime;
	if (settings.openapiMode !== undefined)
		out.openapi_mode = settings.openapiMode;
	if (settings.serverCorsAllowedOrigins !== undefined)
		out.server_cors_allowed_origins = settings.serverCorsAllowedOrigins;
	if (settings.serverTimingEnabled !== undefined)
		out.server_timing_enabled = settings.serverTimingEnabled;
	return out;
}

function dataApiSettingsFromApi(
	settings: RawDataApiSettings | null | undefined,
): NeonDataApiSettings | undefined {
	if (!settings) return undefined;
	const out: NeonDataApiSettings = {};
	if (settings.db_aggregates_enabled !== undefined)
		out.dbAggregatesEnabled = settings.db_aggregates_enabled;
	if (settings.db_anon_role !== undefined)
		out.dbAnonRole = settings.db_anon_role;
	if (settings.db_extra_search_path !== undefined)
		out.dbExtraSearchPath = settings.db_extra_search_path;
	if (settings.db_max_rows !== undefined) out.dbMaxRows = settings.db_max_rows;
	if (settings.db_schemas !== undefined) out.dbSchemas = settings.db_schemas;
	if (settings.jwt_role_claim_key !== undefined)
		out.jwtRoleClaimKey = settings.jwt_role_claim_key;
	if (settings.jwt_cache_max_lifetime !== undefined)
		out.jwtCacheMaxLifetime = settings.jwt_cache_max_lifetime;
	if (
		settings.openapi_mode === "ignore-privileges" ||
		settings.openapi_mode === "disabled"
	)
		out.openapiMode = settings.openapi_mode;
	if (settings.server_cors_allowed_origins !== undefined)
		out.serverCorsAllowedOrigins = settings.server_cors_allowed_origins;
	if (settings.server_timing_enabled !== undefined)
		out.serverTimingEnabled = settings.server_timing_enabled;
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Whether an error means an experimental feature simply isn't available for this
 * project/branch/region (a private-preview gate), as opposed to a real failure. Neon signals
 * this with a `503 platform service not available` or a `404 this route does not exist`.
 */
function isGated(error: unknown): boolean {
	if (!isInfraError(error)) return false;
	const status = error.details?.status;
	const body = error.details?.body;
	const message = (
		typeof body === "string"
			? body
			: typeof (body as { message?: unknown })?.message === "string"
				? (body as { message: string }).message
				: error.message
	).toLowerCase();
	const mentions =
		message.includes("not available") ||
		message.includes("does not exist") ||
		message.includes("not enabled");
	return (status === 503 || status === 404 || status === 501) && mentions;
}

/** Build a clear "experimental feature unavailable" error for a gated feature. */
function gateError(feature: string, cause: unknown): InfraError {
	return new InfraError(
		ErrorCode.NotFound,
		`${feature} is an experimental Neon feature that isn't available for this project's region/account yet. Request preview access, or use a region where it's enabled. Remove it from your infra.ts to proceed without it.`,
		{ ...(cause !== undefined ? { cause } : {}), details: { feature } },
	);
}

/** Re-throw a gated error as a clear {@link gateError}; pass anything else through unchanged. */
function gateOrRethrow(error: unknown, feature: string): unknown {
	return isGated(error) ? gateError(feature, error) : error;
}
