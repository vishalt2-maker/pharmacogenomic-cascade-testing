-- =====================================================================
-- PCT 000_setup.sql
-- Extensions and the three-schema split.
--
-- The split is the point: `knowledge` is public science and contains no
-- patient. `clinical` contains patients and nothing else. `registry` is
-- de-identified aggregate. You can update the science without touching
-- patient data, and audit patient data without wading through science.
-- =====================================================================

-- pgcrypto gives us gen_random_uuid(), digest() for MRN hashing, and
-- gen_random_bytes() for the family link token.
create extension if not exists "pgcrypto";

-- NOTE ON pgaudit: the blueprint calls for pgaudit. It is NOT created here
-- because it is not available on every target (it is absent from PGlite and
-- must be enabled per-project on hosted Postgres). It lives in
-- 900_optional_pgaudit.sql, which is applied only where the extension exists.
-- Database-level audit logging is in addition to clinical.audit_log, never a
-- substitute for it.

create schema if not exists knowledge;
create schema if not exists clinical;
create schema if not exists registry;

comment on schema knowledge is
  'Published science. Versioned, read-only in production, identical across every deployment. Contains no patient data by construction.';
comment on schema clinical is
  'Patient data. Row-level secured per organisation, audited on every touch, minimised. One data subject per record: the index patient.';
comment on schema registry is
  'De-identified aggregate only. No org_id, no case_id, no date finer than month. Service-role access only.';
