import {
	type Change,
	createRestClient,
	Entity,
	type EntityCommon,
	ErrorCode,
	InfraError,
	type ProvisionContext,
	type ProvisionResult,
	type ReadContext,
	type RestClient,
	type StandardSchemaV1,
} from "@infra-ts/core";
import { z } from "zod";

const API = "https://api.workos.com";

type WorkosCreds = { WORKOS_API_KEY: string };
const credsSchema = z.object({
	WORKOS_API_KEY: z.string().min(1),
}) as unknown as StandardSchemaV1<unknown, WorkosCreds>;

function rest(ctx: { credentials: WorkosCreds }): RestClient {
	return createRestClient({
		provider: "workos",
		baseUrl: API,
		auth: { type: "bearer", token: ctx.credentials.WORKOS_API_KEY },
	});
}

// ─── Organization ──────────────────────────────────────────────────────────────

type OrgEnv = { workosOrganizationId: string };
interface WorkosRemoteOrg {
	id: string;
	name: string;
}
export interface WorkosOrganizationOptions extends EntityCommon<
	OrgEnv,
	{ id: string }
> {
	/** Display name. Defaults to the entity `name`. */
	displayName?: string;
	/** Domains to attach (each marked verified). */
	domains?: string[];
}

export class WorkosOrganization extends Entity<
	WorkosOrganizationOptions,
	WorkosCreds,
	OrgEnv,
	{ id: string },
	WorkosRemoteOrg
> {
	readonly credentialsSchema = credsSchema;
	readonly envSchema = z.object({
		workosOrganizationId: z.string(),
	}) as unknown as StandardSchemaV1<unknown, OrgEnv>;
	readonly stateSchema = z.object({
		id: z.string(),
	}) as unknown as StandardSchemaV1<unknown, { id: string }>;
	readonly envKeys = ["workosOrganizationId"] as const;

	override resolveCredentials(
		bag: Record<string, string | undefined>,
	): unknown {
		return { WORKOS_API_KEY: bag.WORKOS_API_KEY ?? "" };
	}

	private get displayName(): string {
		return this.config.displayName ?? this.name;
	}
	private body(): Record<string, unknown> {
		return {
			name: this.displayName,
			...(this.config.domains
				? {
						domain_data: this.config.domains.map((domain) => ({
							domain,
							state: "verified",
						})),
					}
				: {}),
		};
	}

	async read(
		ctx: ReadContext<WorkosCreds, { id: string }>,
	): Promise<WorkosRemoteOrg | null> {
		if (!ctx.state?.id) return null;
		return rest(ctx).get<WorkosRemoteOrg | null>(
			`/organizations/${ctx.state.id}`,
			{ allowStatuses: [404] },
		);
	}
	diff(remote: WorkosRemoteOrg | null): Change[] {
		if (!remote) {
			return [
				{ action: "create", kind: "organization", identifier: this.name },
			];
		}
		return remote.name !== this.displayName
			? [
					{
						action: "update",
						kind: "organization",
						identifier: this.name,
						detail: "name",
					},
				]
			: [];
	}
	async provision(
		ctx: ProvisionContext<WorkosCreds, { id: string }>,
	): Promise<ProvisionResult<OrgEnv, { id: string }>> {
		const existing = await this.read(ctx);
		if (existing) {
			let action: "noop" | "update" = "noop";
			if (existing.name !== this.displayName) {
				await rest(ctx).put(`/organizations/${existing.id}`, {
					body: this.body(),
				});
				action = "update";
			}
			return {
				action,
				id: existing.id,
				state: { id: existing.id },
				env: { workosOrganizationId: existing.id },
			};
		}
		const org = await rest(ctx).post<WorkosRemoteOrg>("/organizations", {
			body: this.body(),
		});
		return {
			action: "create",
			id: org.id,
			state: { id: org.id },
			env: { workosOrganizationId: org.id },
		};
	}
	async pullEnv(
		ctx: ReadContext<WorkosCreds, { id: string }>,
	): Promise<OrgEnv> {
		if (!ctx.state?.id) {
			throw new InfraError(
				ErrorCode.NotFound,
				`workos: ${this.name} is not provisioned yet — run \`infra apply\` first.`,
			);
		}
		return { workosOrganizationId: ctx.state.id };
	}
	async deprovision(
		ctx: ProvisionContext<WorkosCreds, { id: string }>,
	): Promise<void> {
		if (!ctx.state?.id) return;
		await rest(ctx).delete(`/organizations/${ctx.state.id}`, {
			allowStatuses: [404],
		});
	}
}
