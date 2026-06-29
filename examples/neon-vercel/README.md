# Example: Neon → Vercel

A minimal `infra.ts` that provisions a Neon Postgres project and a Vercel project, wiring Neon's
connection string into a Vercel environment variable — fully typed, no attribute state.

```bash
# from this directory (creds resolved from neonctl + vercel CLI):
infra-ts plan
infra-ts apply
infra-ts status
infra-ts destroy
```

See [`infra.ts`](./infra.ts). The cross-provider wiring is the headline:

```ts
const db = neon({ project: { name: "infra-ts-example" } });
vercel({
	project: { name: "infra-ts-example" },
	env: { DATABASE_URL: db.outputs.databaseUrl },
});
```
