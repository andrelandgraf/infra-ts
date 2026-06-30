import { createRestClient, type RestClient } from "@infra-ts/core";

export type VercelEnvTarget = "production" | "preview" | "development";
export type VercelEnvType = "plain" | "encrypted" | "sensitive";

/**
 * Reconcilable Vercel project settings (the PATCH `/v9/projects/{id}` surface). Field names
 * mirror the Vercel REST API exactly. Every field is optional; only the ones you set are
 * reconciled, the rest are left as-is on the remote.
 */
export interface VercelProjectSettings {
	framework?: string | null;
	buildCommand?: string | null;
	devCommand?: string | null;
	installCommand?: string | null;
	/** Command whose non-zero exit cancels a build. */
	commandForIgnoringBuildStep?: string | null;
	outputDirectory?: string | null;
	rootDirectory?: string | null;
	/** e.g. `"20.x"`, `"22.x"`. */
	nodeVersion?: string;
	serverlessFunctionRegion?: string;
	directoryListing?: boolean;
	publicSource?: boolean | null;
	autoExposeSystemEnvs?: boolean;
	gitForkProtection?: boolean;
	enablePreviewFeedback?: boolean | null;
	/** Skew protection window, in seconds (0 disables). */
	skewProtectionMaxAge?: number;
	customerSupportCodeVisibility?: boolean;
}

/** The settings keys, used to read the current values from a project for drift detection. */
export const VERCEL_SETTING_KEYS: (keyof VercelProjectSettings)[] = [
	"framework",
	"buildCommand",
	"devCommand",
	"installCommand",
	"commandForIgnoringBuildStep",
	"outputDirectory",
	"rootDirectory",
	"nodeVersion",
	"serverlessFunctionRegion",
	"directoryListing",
	"publicSource",
	"autoExposeSystemEnvs",
	"gitForkProtection",
	"enablePreviewFeedback",
	"skewProtectionMaxAge",
	"customerSupportCodeVisibility",
];

export interface VercelProjectSnapshot extends VercelProjectSettings {
	id: string;
	name: string;
}

export interface VercelDomainSnapshot {
	name: string;
	verified: boolean;
}

export interface VercelEnvSnapshot {
	id: string;
	key: string;
	/** Decrypted value (present for `plain`/`encrypted`; absent for `sensitive`). */
	value?: string;
	target: VercelEnvTarget[];
	type: VercelEnvType;
}

export interface CreateEnvInput {
	key: string;
	value: string;
	type: VercelEnvType;
	target: VercelEnvTarget[];
}

/**
 * A thin, typed wrapper around the subset of the Vercel REST API the infra-ts Vercel provider
 * needs (projects + project environment variables). Each method maps to one endpoint; the
 * `teamId` (when the provider targets a team rather than your personal scope) is applied to
 * every request as a query param.
 */
export class VercelApi {
	private readonly rest: RestClient;
	private readonly teamId: string | undefined;

	constructor(options: {
		token: string;
		apiHost: string;
		teamId?: string;
		fetch?: typeof fetch;
	}) {
		this.rest = createRestClient({
			provider: "vercel",
			baseUrl: options.apiHost,
			auth: { type: "bearer", token: options.token },
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
		this.teamId = options.teamId;
	}

	private q(extra?: Record<string, string | number | boolean | undefined>) {
		return { ...(this.teamId ? { teamId: this.teamId } : {}), ...extra };
	}

	/** List the teams the authenticated user belongs to (for `infra link`). */
	async listTeams(): Promise<{ id: string; name: string }[]> {
		const res = await this.rest.get<{
			teams?: { id: string; name?: string; slug?: string }[];
		}>("/v2/teams");
		return (res.teams ?? []).map((t) => ({
			id: t.id,
			name: t.name ?? t.slug ?? t.id,
		}));
	}

	/** Resolve a team slug to its team id. Returns `null` when no team matches. */
	async resolveTeamId(slug: string): Promise<string | null> {
		const res = await this.rest.get<{ id?: string } | null>("/v2/teams", {
			query: { slug },
			allowStatuses: [404],
		});
		return res?.id ?? null;
	}

	async createProject(input: {
		name: string;
		framework?: string | null;
	}): Promise<VercelProjectSnapshot> {
		const res = await this.rest.post<RawProject>("/v11/projects", {
			query: this.q(),
			body: {
				name: input.name,
				...(input.framework !== undefined
					? { framework: input.framework }
					: {}),
			},
		});
		return mapProject(res);
	}

	/** Get a project by id or name, or `null` when it doesn't exist (404). */
	async getProject(idOrName: string): Promise<VercelProjectSnapshot | null> {
		const res = await this.rest.get<RawProject | null>(
			`/v9/projects/${encodeURIComponent(idOrName)}`,
			{ query: this.q(), allowStatuses: [404] },
		);
		return res ? mapProject(res) : null;
	}

	/** Update project settings (the reconcilable PATCH surface). */
	async updateProjectSettings(
		idOrName: string,
		patch: VercelProjectSettings,
	): Promise<VercelProjectSnapshot> {
		const res = await this.rest.patch<RawProject>(
			`/v9/projects/${encodeURIComponent(idOrName)}`,
			{ query: this.q(), body: patch },
		);
		return mapProject(res);
	}

	async deleteProject(idOrName: string): Promise<void> {
		await this.rest.delete(`/v9/projects/${encodeURIComponent(idOrName)}`, {
			query: this.q(),
			allowStatuses: [404],
		});
	}

	// ─── domains ──────────────────────────────────────────────────────────────

	async listDomains(projectId: string): Promise<VercelDomainSnapshot[]> {
		const res = await this.rest.get<{ domains: RawDomain[] }>(
			`/v9/projects/${projectId}/domains`,
			{ query: this.q() },
		);
		return (res.domains ?? []).map((d) => ({
			name: d.name,
			verified: d.verified === true,
		}));
	}

	async addDomain(
		projectId: string,
		name: string,
	): Promise<VercelDomainSnapshot> {
		const res = await this.rest.post<RawDomain>(
			`/v10/projects/${projectId}/domains`,
			{ query: this.q(), body: { name } },
		);
		return { name: res.name, verified: res.verified === true };
	}

	async removeDomain(projectId: string, name: string): Promise<void> {
		await this.rest.delete(
			`/v9/projects/${projectId}/domains/${encodeURIComponent(name)}`,
			{ query: this.q(), allowStatuses: [404] },
		);
	}

	// ─── edge config ────────────────────────────────────────────────────────

	async getEdgeConfig(
		id: string,
	): Promise<{ id: string; slug: string } | null> {
		const res = await this.rest.get<{ id: string; slug: string } | null>(
			`/v1/edge-config/${id}`,
			{ query: this.q(), allowStatuses: [404] },
		);
		return res ? { id: res.id, slug: res.slug } : null;
	}
	async createEdgeConfig(slug: string): Promise<{ id: string; slug: string }> {
		const res = await this.rest.post<{ id: string; slug: string }>(
			"/v1/edge-config",
			{ query: this.q(), body: { slug } },
		);
		return { id: res.id, slug: res.slug };
	}
	async getEdgeConfigItems(id: string): Promise<Record<string, unknown>> {
		const res = await this.rest.get<{ key: string; value: unknown }[]>(
			`/v1/edge-config/${id}/items`,
			{ query: this.q() },
		);
		const out: Record<string, unknown> = {};
		for (const item of res) out[item.key] = item.value;
		return out;
	}
	async upsertEdgeConfigItems(
		id: string,
		items: Record<string, unknown>,
	): Promise<void> {
		const ops = Object.entries(items).map(([key, value]) => ({
			operation: "upsert",
			key,
			value,
		}));
		if (ops.length === 0) return;
		await this.rest.patch(`/v1/edge-config/${id}/items`, {
			query: this.q(),
			body: { items: ops },
		});
	}
	async deleteEdgeConfig(id: string): Promise<void> {
		await this.rest.delete(`/v1/edge-config/${id}`, {
			query: this.q(),
			allowStatuses: [404],
		});
	}

	// ─── webhooks ──────────────────────────────────────────────────────────

	async listWebhooks(): Promise<
		{ id: string; url: string; events: string[] }[]
	> {
		const res = await this.rest.get<
			{ id: string; url: string; events: string[] }[]
		>("/v1/webhooks", { query: this.q() });
		return Array.isArray(res) ? res : [];
	}
	async createWebhook(input: {
		url: string;
		events: string[];
		projectIds?: string[];
	}): Promise<{ id: string }> {
		const res = await this.rest.post<{ id: string }>("/v1/webhooks", {
			query: this.q(),
			body: {
				url: input.url,
				events: input.events,
				...(input.projectIds ? { projectIds: input.projectIds } : {}),
			},
		});
		return { id: res.id };
	}
	async deleteWebhook(id: string): Promise<void> {
		await this.rest.delete(`/v1/webhooks/${id}`, {
			query: this.q(),
			allowStatuses: [404],
		});
	}

	async listEnv(projectId: string): Promise<VercelEnvSnapshot[]> {
		const res = await this.rest.get<{ envs: RawEnv[] }>(
			`/v9/projects/${projectId}/env`,
			{ query: this.q({ decrypt: "true" }) },
		);
		return (res.envs ?? []).map(mapEnv);
	}

	/**
	 * Fetch a single env var's **decrypted** value (the list endpoint returns the encrypted
	 * envelope even with `decrypt=true`; the single-item endpoint returns plaintext). Returns
	 * `undefined` for `sensitive` vars (write-only) or a missing id.
	 */
	async getEnvValue(
		projectId: string,
		envId: string,
	): Promise<string | undefined> {
		const res = await this.rest.get<{ value?: string } | null>(
			`/v9/projects/${projectId}/env/${envId}`,
			{ query: this.q(), allowStatuses: [404] },
		);
		return res?.value;
	}

	async createEnv(projectId: string, input: CreateEnvInput): Promise<void> {
		await this.rest.post(`/v10/projects/${projectId}/env`, {
			query: this.q(),
			body: {
				key: input.key,
				value: input.value,
				type: input.type,
				target: input.target,
			},
		});
	}

	async updateEnv(
		projectId: string,
		envId: string,
		patch: { value?: string; target?: VercelEnvTarget[]; type?: VercelEnvType },
	): Promise<void> {
		await this.rest.patch(`/v9/projects/${projectId}/env/${envId}`, {
			query: this.q(),
			body: {
				...(patch.value !== undefined ? { value: patch.value } : {}),
				...(patch.target !== undefined ? { target: patch.target } : {}),
				...(patch.type !== undefined ? { type: patch.type } : {}),
			},
		});
	}

	async deleteEnv(projectId: string, envId: string): Promise<void> {
		await this.rest.delete(`/v9/projects/${projectId}/env/${envId}`, {
			query: this.q(),
			allowStatuses: [404],
		});
	}

	// ─── DNS records ────────────────────────────────────────────────────────

	async listDnsRecords(domain: string): Promise<VercelDnsRecordSnapshot[]> {
		const res = await this.rest.get<{ records?: VercelDnsRecordSnapshot[] }>(
			`/v4/domains/${domain}/records`,
			{ query: this.q() },
		);
		return res.records ?? [];
	}
	async createDnsRecord(
		domain: string,
		input: { type: string; name: string; value: string; ttl?: number },
	): Promise<{ uid: string }> {
		return this.rest.post<{ uid: string }>(`/v2/domains/${domain}/records`, {
			query: this.q(),
			body: {
				type: input.type,
				name: input.name,
				value: input.value,
				...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
			},
		});
	}
	async deleteDnsRecord(domain: string, recordId: string): Promise<void> {
		await this.rest.delete(`/v2/domains/${domain}/records/${recordId}`, {
			query: this.q(),
			allowStatuses: [404],
		});
	}

	// ─── Log drains (configurable) ──────────────────────────────────────────

	async listLogDrains(): Promise<VercelLogDrainSnapshot[]> {
		const res = await this.rest.get<VercelLogDrainSnapshot[]>(
			"/v1/log-drains",
			{
				query: this.q(),
			},
		);
		return res ?? [];
	}
	async createLogDrain(input: {
		name: string;
		url: string;
		deliveryFormat: "json" | "ndjson" | "syslog";
		sources: string[];
		projectIds?: string[];
	}): Promise<VercelLogDrainSnapshot> {
		return this.rest.post<VercelLogDrainSnapshot>("/v1/log-drains", {
			query: this.q(),
			body: {
				name: input.name,
				url: input.url,
				deliveryFormat: input.deliveryFormat,
				sources: input.sources,
				...(input.projectIds ? { projectIds: input.projectIds } : {}),
			},
		});
	}
	async deleteLogDrain(id: string): Promise<void> {
		await this.rest.delete(`/v1/log-drains/${id}`, {
			query: this.q(),
			allowStatuses: [404],
		});
	}

	// ─── Access groups ──────────────────────────────────────────────────────

	async getAccessGroup(id: string): Promise<VercelAccessGroupSnapshot | null> {
		return this.rest.get<VercelAccessGroupSnapshot | null>(
			`/v1/access-groups/${id}`,
			{
				query: this.q(),
				allowStatuses: [404],
			},
		);
	}
	async createAccessGroup(name: string): Promise<VercelAccessGroupSnapshot> {
		return this.rest.post<VercelAccessGroupSnapshot>("/v1/access-groups", {
			query: this.q(),
			body: { name },
		});
	}
	async updateAccessGroup(id: string, name: string): Promise<void> {
		await this.rest.post(`/v1/access-groups/${id}`, {
			query: this.q(),
			body: { name },
		});
	}
	async deleteAccessGroup(id: string): Promise<void> {
		await this.rest.delete(`/v1/access-groups/${id}`, {
			query: this.q(),
			allowStatuses: [404],
		});
	}
}

export interface VercelDnsRecordSnapshot {
	id: string;
	type: string;
	name: string;
	value: string;
}
export interface VercelLogDrainSnapshot {
	id: string;
	name?: string;
	url: string;
}
export interface VercelAccessGroupSnapshot {
	accessGroupId: string;
	name: string;
}

type RawProject = {
	id: string;
	name: string;
} & Partial<Record<keyof VercelProjectSettings, unknown>>;

interface RawDomain {
	name: string;
	verified?: boolean;
}
interface RawEnv {
	id: string;
	key: string;
	value?: string;
	target?: VercelEnvTarget[] | string;
	type: VercelEnvType;
}

function mapProject(p: RawProject): VercelProjectSnapshot {
	const settings: Record<string, unknown> = {};
	for (const key of VERCEL_SETTING_KEYS) {
		const value = p[key];
		// The API echoes each setting back with its native type; copy through verbatim.
		if (value !== undefined) settings[key] = value;
	}
	return { id: p.id, name: p.name, ...settings } as VercelProjectSnapshot;
}
function mapEnv(e: RawEnv): VercelEnvSnapshot {
	const target: VercelEnvTarget[] = Array.isArray(e.target)
		? e.target
		: typeof e.target === "string"
			? [e.target as VercelEnvTarget]
			: [];
	return {
		id: e.id,
		key: e.key,
		...(e.value !== undefined ? { value: e.value } : {}),
		target,
		type: e.type,
	};
}
