# Database

## Applying the schema

**Locally / self-hosted PostgreSQL:** `npm run migrate` applies
`migrations/*.sql` in filename order, once each, recording a hash so an
already-applied migration cannot be edited underneath you.

**On Supabase:** set `PCT_TARGET=supabase`. `001_local_auth_shim.sql` is then
skipped, because Supabase already provides the `auth` schema, `auth.users` and
`auth.uid()` that it reproduces. Everything else runs unchanged.

`optional/900_pgaudit.sql` is applied by hand, only where the extension exists.

## Layout

| File | Contents |
|---|---|
| `migrations/000_setup.sql` | Extensions and the three-schema split |
| `migrations/001_local_auth_shim.sql` | **Local only.** Reproduces the Supabase auth contract |
| `migrations/002_knowledge.sql` | Rule packs, genes, alleles, drugs, pairs, recommendations, evidence, wording rules |
| `migrations/003_clinical.sql` | Patients, consent, ADR events, genotypes, evaluations, advisories, audit |
| `migrations/004_registry.sql` | De-identified aggregate records and export runs |
| `migrations/005_rls.sql` | Row-level security policies and grants |
| `optional/900_pgaudit.sql` | Statement-level audit, where available |
| `seed/` | The rule pack, the wording rules, the verified figures, demo organisations |

## The three schemas

**`knowledge`** holds published science. No patient ever appears in it. It is
versioned, read-only to application users, and identical across every
deployment. If it leaked tomorrow, nothing bad would happen: it is public
literature.

**`clinical`** holds patients. Locked per organisation, audited on every touch,
minimised to what the job needs.

**`registry`** holds de-identified aggregate. No `org_id`, no case identifier,
no date finer than the month. Service-role access only; RLS denies every
application user by default because no policy grants them anything.

## What is deliberately absent

There is no relatives table. `clinical.advisory_recipient_summary` holds a
relationship type and a count, and has nowhere to put a name. See
`test/rls.test.ts`, which asserts this rather than trusting it.
