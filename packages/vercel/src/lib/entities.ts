import {
	Account,
	type AccountOptions,
	type AccountScope,
	type Change,
	type CliAuth,
	Entity,
	type EntityCommon,
	ErrorCode,
	InfraError,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
	type Ref,
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";
import {
	VercelApi,
	type VercelAccessGroupSnapshot,
	type VercelDnsRecordSnapshot,
	type VercelEnvTarget,
	type VercelLogDrainSnapshot,
	type VercelProjectSettings,
	type VercelProjectSnapshot,
	VERCEL_SETTING_KEYS,
} from "./api.js";
import { vercelTokenFromBag } from "./credentials.js";
import { DEFAULT_VERCEL_API_HOST } from "./credentials.js";

const ALL_TARGETS: VercelEnvTarget[] = ["production", "preview", "development"];

type VercelCreds = { VERCEL_TOKEN: string };
const credentialsSchema = z.object({
	VERCEL_TOKEN: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, VercelCreds>;

/** Shared base: Vercel credentials (VERCEL_TOKEN, with vercel-CLI fallback) + an API client. */
abstract class VercelEntity<
	O extends EntityCommon<Env, State> & { team?: string | Ref<string> },
	Env extends Record<string, string>,
	State extends Record<string, unknown>,
	Remote,
> extends Entity<O, VercelCreds, Env, State, Remote> {
	readonly credentialsSchema = credentialsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { VERCEL_TOKEN: vercelTokenFromBag(bag) ?? "" };
	}
	protected async api(ctx: { credentials: VercelCreds }): Promise<VercelApi> {
		const token = ctx.credentials.VERCEL_TOKEN;
		const apiHost = process.env.VERCEL_API_HOST ?? DEFAULT_VERCEL_API_HOST;
		let team = this.config.team;
		const base = new VercelApi({ token, apiHost });
		if (team && !team.startsWith("team_")) {
			const resolved = await base.resolveTeamId(team);
			if (!resolved) {
				throw new InfraError(
					ErrorCode.InvalidEntity,
					`vercel: team "${team}" not found for ${this.name}.`,
				);
			}
			team = resolved;
		}
		return new VercelApi({ token, apiHost, ...(team ? { teamId: team } : {}) });
	}
}

// ─── Project (settings + env vars + domains) ──────────────────────────────────

type VercelProjectEnv = { projectId: string; projectName: string };
type VercelEnvInput = Record<string, string | Ref<string>>;

export interface VercelProjectOptions extends EntityCommon<
	VercelProjectEnv,
	{ id: string }
> {
	team?: string | Ref<string>;
	framework?: string | null;
	settings?: VercelProjectSettings;
	env?: VercelEnvInput;
	envTargets?: VercelEnvTarget[];
	domains?: string[];
}

export class VercelProject extends VercelEntity<
	VercelProjectOptions,
	VercelProjectEnv,
	{ id: string },
	VercelProjectSnapshot
> {
	readonly envSchema = z.object({
		projectId: z.string(),
		projectName: z.string(),
	}) as unknown as StandardSchemaV1<unknown, VercelProjectEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["projectId", "projectName"] as const;

	private targets(): VercelEnvTarget[] {
		return this.config.envTargets ?? ALL_TARGETS;
	}
	private desiredSettings(): VercelProjectSettings {
		const o = this.config;
		return {
			...(o.framework !== undefined ? { framework: o.framework } : {}),
			...(o.settings ?? {}),
		};
	}
	private desiredEnv(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(this.config.env ?? {})) {
			if (typeof v === "string") out[k] = v;
		}
		return out;
	}

	async read(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<VercelProjectSnapshot | null> {
		const api = await this.api(ctx);
		return api.getProject(ctx.state?.id ?? this.name);
	}

	diff(remote: VercelProjectSnapshot | null): Change[] {
		if (!remote) {
			return [
				{
					action: "create",
					kind: "project",
					identifier: this.name,
					detail: `create Vercel project "${this.name}"`,
				},
			];
		}
		const changes: Change[] = [];
		const delta = settingsDelta(this.desiredSettings(), remote);
		if (Object.keys(delta).length > 0) {
			changes.push({
				action: "update",
				kind: "settings",
				identifier: this.name,
				detail: Object.keys(delta).join(", "),
			});
		}
		return changes;
	}

	async provision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<ProvisionResult<VercelProjectEnv, { id: string }>> {
		const api = await this.api(ctx);
		let action: ProvisionResult<VercelProjectEnv, { id: string }>["action"] =
			"noop";
		let project = ctx.state?.id ? await api.getProject(ctx.state.id) : null;
		if (!project) {
			project = await api.createProject({
				name: this.name,
				...(this.config.framework !== undefined
					? { framework: this.config.framework }
					: {}),
			});
			action = "create";
		}
		const projectId = project.id;

		// Settings drift → PATCH.
		const delta = settingsDelta(this.desiredSettings(), project);
		if (Object.keys(delta).length > 0) {
			await api.updateProjectSettings(projectId, delta);
			if (action === "noop") action = "update";
		}

		// Env vars (additive + update).
		const targets = this.targets();
		const existingEnv = await api.listEnv(projectId);
		for (const [key, value] of Object.entries(this.desiredEnv())) {
			const match = existingEnv.find(
				(e) => e.key === key && sameTargets(e.target, targets),
			);
			if (!match) {
				await api.createEnv(projectId, {
					key,
					value,
					type: "encrypted",
					target: targets,
				});
				if (action === "noop") action = "update";
			} else {
				const current =
					match.type === "sensitive"
						? undefined
						: await api.getEnvValue(projectId, match.id);
				if (current !== value) {
					await api.updateEnv(projectId, match.id, {
						value,
						target: targets,
						type: "encrypted",
					});
					if (action === "noop") action = "update";
				}
			}
		}

		// Domains (additive).
		for (const domain of this.config.domains ?? []) {
			const existing = await api.listDomains(projectId);
			if (!existing.some((d) => d.name === domain)) {
				await api.addDomain(projectId, domain);
				if (action === "noop") action = "update";
			}
		}

		return {
			action,
			id: projectId,
			state: { id: projectId },
			env: { projectId, projectName: project.name },
		};
	}

	async pullEnv(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<VercelProjectEnv> {
		const api = await this.api(ctx);
		const project = await api.getProject(ctx.state?.id ?? this.name);
		if (!project) {
			throw new InfraError(
				ErrorCode.NotFound,
				`vercel: project ${this.name} not found.`,
			);
		}
		return { projectId: project.id, projectName: project.name };
	}

	async deprovision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		const api = await this.api(ctx);
		await api.deleteProject(ctx.state.id);
	}
}

function settingsDelta(
	desired: VercelProjectSettings,
	current: VercelProjectSnapshot,
): VercelProjectSettings {
	const delta: Record<string, unknown> = {};
	for (const key of VERCEL_SETTING_KEYS) {
		const d = desired[key];
		if (d === undefined) continue;
		if (current[key] !== d) delta[key] = d;
	}
	return delta as VercelProjectSettings;
}
function itemsEqual(
	current: Record<string, unknown>,
	desired: Record<string, unknown>,
): boolean {
	// Desired is authoritative for its own keys (extra live keys are left untouched).
	return Object.entries(desired).every(
		([k, v]) => JSON.stringify(current[k]) === JSON.stringify(v),
	);
}
function sameTargets(a: VercelEnvTarget[], b: VercelEnvTarget[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((t) => set.has(t));
}

// ─── Edge Config ──────────────────────────────────────────────────────────────

type EdgeConfigEnv = { edgeConfigId: string };
export interface VercelEdgeConfigOptions extends EntityCommon<
	EdgeConfigEnv,
	{ id: string }
> {
	team?: string | Ref<string>;
	slug: string;
	items?: Record<string, unknown>;
}

export class VercelEdgeConfig extends VercelEntity<
	VercelEdgeConfigOptions,
	EdgeConfigEnv,
	{ id: string },
	{ id: string }
> {
	readonly envSchema = z.object({
		edgeConfigId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, EdgeConfigEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["edgeConfigId"] as const;

	async read(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<{ id: string } | null> {
		if (!ctx.state?.id) return null;
		const api = await this.api(ctx);
		return api.getEdgeConfig(ctx.state.id);
	}
	diff(remote: { id: string } | null): Change[] {
		return remote
			? []
			: [
					{
						action: "create",
						kind: "edge-config",
						identifier: this.name,
						detail: `create Edge Config "${this.config.slug}"`,
					},
				];
	}
	async provision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<ProvisionResult<EdgeConfigEnv, { id: string }>> {
		const api = await this.api(ctx);
		let ec = ctx.state?.id ? await api.getEdgeConfig(ctx.state.id) : null;
		let action: ProvisionResult<EdgeConfigEnv, { id: string }>["action"] =
			"noop";
		if (!ec) {
			ec = await api.createEdgeConfig(this.config.slug);
			action = "create";
		}
		if (this.config.items) {
			// Only upsert when the live items actually differ — keeps apply idempotent.
			const current =
				action === "create" ? {} : await api.getEdgeConfigItems(ec.id);
			if (!itemsEqual(current, this.config.items)) {
				await api.upsertEdgeConfigItems(ec.id, this.config.items);
				if (action === "noop") action = "update";
			}
		}
		return {
			action,
			id: ec.id,
			state: { id: ec.id },
			env: { edgeConfigId: ec.id },
		};
	}
	async pullEnv(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<EdgeConfigEnv> {
		if (!ctx.state?.id) {
			throw new InfraError(
				ErrorCode.NotFound,
				`vercel: edge config ${this.name} not provisioned.`,
			);
		}
		return { edgeConfigId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		const api = await this.api(ctx);
		await api.deleteEdgeConfig(ctx.state.id);
	}
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

type WebhookEnv = { webhookId: string };
export interface VercelWebhookOptions extends EntityCommon<
	WebhookEnv,
	{ id: string }
> {
	team?: string | Ref<string>;
	url: string | Ref<string>;
	events: string[];
	projectIds?: (string | Ref<string>)[];
}

export class VercelWebhook extends VercelEntity<
	VercelWebhookOptions,
	WebhookEnv,
	{ id: string },
	{ id: string }
> {
	readonly envSchema = z.object({
		webhookId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, WebhookEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["webhookId"] as const;

	async read(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<{ id: string } | null> {
		if (!ctx.state?.id) return null;
		const api = await this.api(ctx);
		const hooks = await api.listWebhooks();
		const found = hooks.find((h) => h.id === ctx.state?.id);
		return found ? { id: found.id } : null;
	}
	diff(remote: { id: string } | null): Change[] {
		return remote
			? []
			: [
					{
						action: "create",
						kind: "webhook",
						identifier: this.name,
						detail: `${this.config.events.join(",")}`,
					},
				];
	}
	async provision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<ProvisionResult<WebhookEnv, { id: string }>> {
		const api = await this.api(ctx);
		if (ctx.state?.id) {
			const hooks = await api.listWebhooks();
			if (hooks.some((h) => h.id === ctx.state?.id)) {
				return {
					action: "noop",
					id: ctx.state.id,
					state: { id: ctx.state.id },
					env: { webhookId: ctx.state.id },
				};
			}
		}
		const url = this.config.url;
		const projectIds = (this.config.projectIds ?? []).filter(
			(p): p is string => typeof p === "string",
		);
		const created = await api.createWebhook({
			url,
			events: this.config.events,
			...(projectIds.length > 0 ? { projectIds } : {}),
		});
		return {
			action: "create",
			id: created.id,
			state: { id: created.id },
			env: { webhookId: created.id },
		};
	}
	async pullEnv(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<WebhookEnv> {
		if (!ctx.state?.id) {
			throw new InfraError(
				ErrorCode.NotFound,
				`vercel: webhook ${this.name} not provisioned.`,
			);
		}
		return { webhookId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		const api = await this.api(ctx);
		await api.deleteWebhook(ctx.state.id);
	}
}

// ─── DNS record ───────────────────────────────────────────────────────────────

export interface VercelDnsRecordOptions extends EntityCommon<
	Record<string, never>,
	{ id: string }
> {
	team?: string | Ref<string>;
	/** The domain the record belongs to (must already be on the account). */
	domain: string | Ref<string>;
	type: "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS" | "SRV" | "CAA" | "ALIAS";
	/** Subdomain (use "" for the apex). */
	recordName: string;
	value: string | Ref<string>;
	ttl?: number;
}

export class VercelDnsRecord extends VercelEntity<
	VercelDnsRecordOptions,
	Record<string, never>,
	{ id: string },
	VercelDnsRecord_Remote
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [] as const;

	private get domain(): string {
		return this.config.domain;
	}
	private matches(r: VercelDnsRecord_Remote): boolean {
		return (
			r.type === this.config.type &&
			r.name === this.config.recordName &&
			r.value === this.config.value
		);
	}
	private async find(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<VercelDnsRecord_Remote | null> {
		const api = await this.api(ctx);
		const records = await api.listDnsRecords(this.domain);
		if (ctx.state?.id) {
			return records.find((r) => r.id === ctx.state?.id) ?? null;
		}
		return records.find((r) => this.matches(r)) ?? null;
	}
	async read(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<VercelDnsRecord_Remote | null> {
		return this.find(ctx);
	}
	diff(remote: VercelDnsRecord_Remote | null): Change[] {
		return remote
			? []
			: [
					{
						action: "create",
						kind: "dns-record",
						identifier: `${this.config.type} ${this.config.recordName || "@"}`,
					},
				];
	}
	async provision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<ProvisionResult<Record<string, never>, { id: string }>> {
		const existing = await this.find(ctx);
		if (existing) {
			return {
				action: "noop",
				id: existing.id,
				state: { id: existing.id },
				env: {},
			};
		}
		const api = await this.api(ctx);
		const created = await api.createDnsRecord(this.domain, {
			type: this.config.type,
			name: this.config.recordName,
			value: this.config.value,
			...(this.config.ttl !== undefined ? { ttl: this.config.ttl } : {}),
		});
		return {
			action: "create",
			id: created.uid,
			state: { id: created.uid },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		const api = await this.api(ctx);
		await api.deleteDnsRecord(this.domain, ctx.state.id);
	}
}
type VercelDnsRecord_Remote = VercelDnsRecordSnapshot;

// ─── Log drain ────────────────────────────────────────────────────────────────

export interface VercelLogDrainOptions extends EntityCommon<
	Record<string, never>,
	{ id: string }
> {
	team?: string | Ref<string>;
	url: string | Ref<string>;
	deliveryFormat?: "json" | "ndjson" | "syslog";
	sources?: ("static" | "lambda" | "edge" | "external" | "build")[];
	projectIds?: (string | Ref<string>)[];
}

export class VercelLogDrain extends VercelEntity<
	VercelLogDrainOptions,
	Record<string, never>,
	{ id: string },
	VercelLogDrain_Remote
> {
	readonly envSchema = z.object({}) as unknown as StandardSchemaV1<
		unknown,
		Record<string, never>
	>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = [] as const;

	private async find(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<VercelLogDrain_Remote | null> {
		if (!ctx.state?.id) return null;
		const api = await this.api(ctx);
		const drains = await api.listLogDrains();
		return drains.find((d) => d.id === ctx.state?.id) ?? null;
	}
	async read(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<VercelLogDrain_Remote | null> {
		return this.find(ctx);
	}
	diff(remote: VercelLogDrain_Remote | null): Change[] {
		return remote
			? []
			: [{ action: "create", kind: "log-drain", identifier: this.name }];
	}
	async provision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<ProvisionResult<Record<string, never>, { id: string }>> {
		const existing = await this.find(ctx);
		if (existing) {
			return {
				action: "noop",
				id: existing.id,
				state: { id: existing.id },
				env: {},
			};
		}
		const api = await this.api(ctx);
		const projectIds = (this.config.projectIds ?? []).filter(
			(p): p is string => typeof p === "string",
		);
		const created = await api.createLogDrain({
			name: this.name,
			url: this.config.url,
			deliveryFormat: this.config.deliveryFormat ?? "json",
			sources: this.config.sources ?? ["lambda", "static", "edge"],
			...(projectIds.length > 0 ? { projectIds } : {}),
		});
		return {
			action: "create",
			id: created.id,
			state: { id: created.id },
			env: {},
		};
	}
	async pullEnv(): Promise<Record<string, never>> {
		return {};
	}
	async deprovision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		const api = await this.api(ctx);
		await api.deleteLogDrain(ctx.state.id);
	}
}
type VercelLogDrain_Remote = VercelLogDrainSnapshot;

// ─── Access group ─────────────────────────────────────────────────────────────

type AccessGroupEnv = { vercelAccessGroupId: string };
export interface VercelAccessGroupOptions extends EntityCommon<
	AccessGroupEnv,
	{ id: string }
> {
	team?: string | Ref<string>;
	/** Display name. Defaults to the entity `name`. */
	groupName?: string;
}

export class VercelAccessGroup extends VercelEntity<
	VercelAccessGroupOptions,
	AccessGroupEnv,
	{ id: string },
	VercelAccessGroup_Remote
> {
	readonly envSchema = z.object({
		vercelAccessGroupId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, AccessGroupEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["vercelAccessGroupId"] as const;

	private get groupName(): string {
		return this.config.groupName ?? this.name;
	}
	async read(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<VercelAccessGroup_Remote | null> {
		if (!ctx.state?.id) return null;
		const api = await this.api(ctx);
		return api.getAccessGroup(ctx.state.id);
	}
	diff(remote: VercelAccessGroup_Remote | null): Change[] {
		if (!remote) {
			return [
				{ action: "create", kind: "access-group", identifier: this.groupName },
			];
		}
		return remote.name !== this.groupName
			? [
					{
						action: "update",
						kind: "access-group",
						identifier: this.groupName,
						detail: "name",
					},
				]
			: [];
	}
	async provision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<ProvisionResult<AccessGroupEnv, { id: string }>> {
		const api = await this.api(ctx);
		const existing = ctx.state?.id
			? await api.getAccessGroup(ctx.state.id)
			: null;
		if (existing) {
			let action: "noop" | "update" = "noop";
			if (existing.name !== this.groupName) {
				await api.updateAccessGroup(existing.accessGroupId, this.groupName);
				action = "update";
			}
			return {
				action,
				id: existing.accessGroupId,
				state: { id: existing.accessGroupId },
				env: { vercelAccessGroupId: existing.accessGroupId },
			};
		}
		const created = await api.createAccessGroup(this.groupName);
		return {
			action: "create",
			id: created.accessGroupId,
			state: { id: created.accessGroupId },
			env: { vercelAccessGroupId: created.accessGroupId },
		};
	}
	async pullEnv(
		ctx: ReadContext<VercelCreds, { id: string }>,
	): Promise<AccessGroupEnv> {
		if (!ctx.state?.id) {
			throw new InfraError(
				ErrorCode.NotFound,
				`vercel: access group ${this.name} not provisioned.`,
			);
		}
		return { vercelAccessGroupId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<VercelCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		const api = await this.api(ctx);
		await api.deleteAccessGroup(ctx.state.id);
	}
}
type VercelAccessGroup_Remote = VercelAccessGroupSnapshot;

// ─── Account (team scope + auth anchor) ───────────────────────────────────────

export type VercelAccountOptions = AccountOptions;

export class VercelAccount extends Account<VercelCreds> {
	readonly credentialsSchema = credentialsSchema;
	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { VERCEL_TOKEN: vercelTokenFromBag(bag) ?? "" };
	}
	cliAuth(): CliAuth {
		return {
			providerId: "vercel",
			envVar: "VERCEL_TOKEN",
			detect: ["vercel", "whoami"],
			login: ["vercel", "login"],
		};
	}
	async listScopes(credentials: VercelCreds): Promise<AccountScope[]> {
		const apiHost = process.env.VERCEL_API_HOST ?? DEFAULT_VERCEL_API_HOST;
		const api = new VercelApi({ token: credentials.VERCEL_TOKEN, apiHost });
		return api.listTeams();
	}
}
