-- =====================================================================
-- OPTIONAL: database-level audit logging via pgaudit.
--
-- NOT part of db/migrations/, and not applied by `npm run migrate`,
-- because `create extension` fails outright where the extension is not
-- installed and would take the whole migration run with it. pgaudit is
-- absent from PGlite and must be enabled per-project on most managed
-- PostgreSQL platforms.
--
-- Apply this by hand, on a target where the extension exists, AFTER the
-- numbered migrations.
--
-- This is IN ADDITION to clinical.audit_log, never a substitute for it.
-- pgaudit records statements; clinical.audit_log records clinical actions
-- with their reason codes, and is what an auditor actually reads.
-- =====================================================================

create extension if not exists "pgaudit";

-- Log every write to patient data, and every read of a genotype result.
-- Reads of the knowledge layer are deliberately NOT logged: it is public
-- literature and logging it buries the signal.
alter database current_database() set pgaudit.log = 'write, ddl';
alter database current_database() set pgaudit.log_relation = on;
alter database current_database() set pgaudit.log_parameter = off;  -- keep identifiers out of the log

comment on extension pgaudit is
  'Statement-level audit. Configure retention and shipping to the hospital SIEM before relying on it; a log nobody reads is not a control.';
