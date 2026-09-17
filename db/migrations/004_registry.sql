-- =====================================================================
-- PCT 004_registry.sql -- de-identified, aggregate only.
--
-- This is the durable asset. There is no Indian national pharmacogenomic
-- SCAR registry; every case this system processes generates exactly the
-- data that is missing. The software is not the moat. This table is.
--
-- No org_id. No case_id. No date finer than month. Export only where
-- registry_deidentified consent is active, and suppress any cell below the
-- threshold before publishing, because small cells re-identify.
-- =====================================================================

create table registry.cascade_records (
  id                  uuid primary key default gen_random_uuid(),
  state               text,
  year_month          text check (year_month ~ '^[0-9]{4}-[0-9]{2}$'),
  suspect_drug        text,
  reaction_type       text,
  causality           text,
  gene_symbol         text,
  diplotype           text,
  phenotype           text,
  advisory_issued     boolean,
  relatives_informed_count integer,
  relatives_tested_count   integer,
  relatives_positive_count integer,
  india_evidence_tier text,
  rule_pack_version   text,
  exported_at         timestamptz default now(),
  export_run_id       uuid
);

-- An export is itself an event worth auditing: who ran it, under which
-- suppression threshold, how many rows were withheld and why.
create table registry.export_runs (
  id                    uuid primary key default gen_random_uuid(),
  run_at                timestamptz not null default now(),
  run_by                text not null,
  suppression_threshold integer not null,
  rows_considered       integer not null,
  rows_exported         integer not null,
  rows_withheld_no_consent integer not null,
  cells_suppressed      integer not null,
  notes                 text
);

comment on table registry.cascade_records is
  'De-identified. Publication of any aggregate derived from this table must apply small-cell suppression; a count below the threshold can re-identify an individual in a low-frequency population.';
