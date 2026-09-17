-- =====================================================================
-- PCT 003_clinical.sql -- patients. One data subject: the index patient.
--
-- Read the bottom of this file first if you are auditing the ethics
-- position. There is no relatives table. That is not an omission.
-- =====================================================================

create table clinical.organizations (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  amc_code        text,                   -- PvPI AMC identifier
  state           text,
  dpa_signed_at   timestamptz,            -- Data Processing Agreement, DPDPA 2023
  is_active       boolean default true,
  created_at      timestamptz default now()
);

comment on column clinical.organizations.dpa_signed_at is
  'Under DPDPA 2023 the hospital is Data Fiduciary and this system is Data Processor. Get the DPA signed before a single patient row exists.';

create type clinical.user_role as enum
  ('clinical_pharmacist','physician','amc_coordinator','counsellor','admin','auditor');

create table clinical.app_users (
  id                uuid primary key references auth.users(id) on delete cascade,
  org_id            uuid not null references clinical.organizations(id),
  full_name         text not null,
  role              clinical.user_role not null,
  registration_no   text,                 -- required to sign
  registration_body text,                 -- NMC / State Council / PCI
  is_active         boolean default true,
  created_at        timestamptz default now()
);

-- Only registered, active clinicians may sign. Everything about this
-- function is deliberately restrictive: an inactive user cannot sign, a
-- counsellor cannot sign, and a physician without a registration number
-- cannot sign.
create or replace function clinical.can_sign(uid uuid)
returns boolean language sql stable
security definer set search_path = clinical, pg_temp as $$
  select exists (
    select 1 from clinical.app_users u
    where u.id = uid and u.is_active
      and u.role in ('physician','clinical_pharmacist')
      and coalesce(u.registration_no,'') <> ''
  );
$$;

-- ---------------------------------------------------------------------
-- INDEX CASES. Identifiers minimised. MRN is hashed for matching and
-- encrypted for display -- never stored in plain text.
-- Year of birth, not full date of birth.
-- ---------------------------------------------------------------------
create table clinical.index_cases (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references clinical.organizations(id),
  mrn_hash          text not null,          -- digest(mrn || org_salt, 'sha256')
  mrn_encrypted     bytea,                  -- pgcrypto; key held OUTSIDE the DB
  year_of_birth     integer,                -- NOT full DOB
  sex               text,
  state             text,
  preferred_language text,
  -- Opaque, high-entropy, and handed to the PATIENT. The system never uses
  -- it to find relatives; a relative presents it voluntarily, or does not.
  family_link_token text unique
                    default encode(gen_random_bytes(16),'hex'),
  created_by        uuid references clinical.app_users(id),
  created_at        timestamptz default now(),
  unique (org_id, mrn_hash),
  constraint yob_plausible check (year_of_birth is null
    or (year_of_birth between 1900 and extract(year from now())::int))
);

-- ---------------------------------------------------------------------
-- CONSENT. One row per purpose. Never a single blanket flag.
-- ---------------------------------------------------------------------
create type clinical.consent_purpose as enum
  ('genotyping','advisory_issue','counselling','registry_deidentified','recontact');

create table clinical.consents (
  id              uuid primary key default gen_random_uuid(),
  index_case_id   uuid not null references clinical.index_cases(id) on delete cascade,
  purpose         clinical.consent_purpose not null,
  granted         boolean not null,
  granted_at      timestamptz not null default now(),
  withdrawn_at    timestamptz,
  language        text not null,
  document_ref    text,                   -- signed form reference
  witnessed_by    uuid references clinical.app_users(id),
  unique (index_case_id, purpose, granted_at)
);

create or replace function clinical.has_active_consent(
  p_case uuid, p_purpose clinical.consent_purpose)
returns boolean language sql stable
security definer set search_path = clinical, pg_temp as $$
  select exists (
    select 1 from clinical.consents c
    where c.index_case_id = p_case and c.purpose = p_purpose
      and c.granted and c.withdrawn_at is null
  );
$$;

-- ---------------------------------------------------------------------
-- ADR EVENTS WITH CAUSALITY (WHO-UMC, consistent with PvPI practice)
-- ---------------------------------------------------------------------
create type clinical.who_umc as enum
  ('certain','probable','possible','unlikely','conditional','unassessable','not_assessed');

create type clinical.reaction_type as enum
  ('SJS','TEN','SJS_TEN_overlap','DRESS','MPE','AGEP','other_cutaneous','non_cutaneous');

create table clinical.adr_events (
  id                uuid primary key default gen_random_uuid(),
  index_case_id     uuid not null references clinical.index_cases(id) on delete cascade,
  org_id            uuid not null references clinical.organizations(id),
  suspect_drug      text not null,
  suspect_drug_id   uuid,                  -- resolved against knowledge.drugs
  reaction_type     clinical.reaction_type not null,
  onset_date        date,
  latency_days      integer,
  causality_who_umc clinical.who_umc not null default 'not_assessed',
  causality_assessed_by uuid references clinical.app_users(id),
  causality_assessed_at timestamptz,
  vigiflow_ref      text,                  -- PvPI ICSR reference
  outcome           text,
  created_at        timestamptz default now(),
  -- A causality grade without an assessor is an unsigned clinical judgement.
  constraint causality_needs_assessor check (
    causality_who_umc = 'not_assessed'
    or (causality_assessed_by is not null and causality_assessed_at is not null))
);

-- ---------------------------------------------------------------------
-- GENOTYPE ORDERS AND RESULTS -- gate G5, the differentiator.
-- ---------------------------------------------------------------------
create table clinical.genotype_orders (
  id              uuid primary key default gen_random_uuid(),
  index_case_id   uuid not null references clinical.index_cases(id) on delete cascade,
  adr_event_id    uuid references clinical.adr_events(id),
  gene_symbol     text not null,
  ordered_by      uuid not null references clinical.app_users(id),
  ordered_at      timestamptz default now(),
  lab_name        text,
  lab_accreditation text,                  -- NABL / CAP
  status          text default 'ordered'
    check (status in ('ordered','sample_collected','in_progress','resulted','cancelled'))
);

create table clinical.genotype_results (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references clinical.genotype_orders(id) on delete cascade,
  index_case_id   uuid not null references clinical.index_cases(id) on delete cascade,
  gene_symbol     text not null,
  diplotype       text not null,           -- exactly as reported by the lab
  method          text not null,           -- 'PCR-SSP', 'TaqMan', 'NGS'
  lab_name        text not null,
  lab_accreditation text not null,
  report_ref      text not null,
  resulted_at     timestamptz not null,
  entered_by      uuid not null references clinical.app_users(id),
  -- Two-person rule. A transcription error in a genotype is a catastrophic
  -- failure mode, so entry and verification are different humans.
  verified_by     uuid references clinical.app_users(id),
  verified_at     timestamptz,
  constraint verifier_is_second_person check (
    verified_by is null or verified_by <> entered_by),
  constraint verification_is_timestamped check (
    (verified_by is null) = (verified_at is null))
);

-- ---------------------------------------------------------------------
-- ELIGIBILITY EVALUATIONS -- the audit spine.
-- Blocks are recorded, never discarded. They are the most valuable audit
-- data in the system and the best pilot metric available.
-- ---------------------------------------------------------------------
create type clinical.engine_decision as enum
  ('ADVISORY_DRAFT','INFORM_ONLY','NO_ACTION','BLOCK');

create table clinical.eligibility_evaluations (
  id                uuid primary key default gen_random_uuid(),
  index_case_id     uuid not null references clinical.index_cases(id) on delete cascade,
  org_id            uuid not null references clinical.organizations(id),
  adr_event_id      uuid references clinical.adr_events(id),
  genotype_result_id uuid references clinical.genotype_results(id),
  rule_pack_version text not null,
  decision          clinical.engine_decision not null,
  reason_codes      text[] not null default '{}',
  gate_trace        jsonb not null,        -- every gate, pass/fail, inputs
  engine_version    text not null,
  evaluated_at      timestamptz default now(),
  evaluated_by      uuid references clinical.app_users(id)
);

create index idx_eval_case on clinical.eligibility_evaluations (index_case_id, evaluated_at desc);
create index idx_eval_decision on clinical.eligibility_evaluations (decision, evaluated_at desc);

-- ---------------------------------------------------------------------
-- ADVISORIES -- immutable content snapshot, not a template reference.
-- If the template changes next year, the issued document must still be
-- reproducible exactly as issued.
-- ---------------------------------------------------------------------
create type clinical.advisory_status as enum ('draft','signed','issued','revoked','superseded');

create table clinical.advisories (
  id                  uuid primary key default gen_random_uuid(),
  index_case_id       uuid not null references clinical.index_cases(id) on delete cascade,
  evaluation_id       uuid not null references clinical.eligibility_evaluations(id),
  org_id              uuid not null references clinical.organizations(id),
  status              clinical.advisory_status not null default 'draft',
  rule_pack_version   text not null,
  guideline_citation  text not null,
  guideline_version   text not null,
  india_evidence_tier text not null,
  content_clinical    jsonb not null,   -- full rendered text, frozen
  content_patient     jsonb not null,
  content_hash        text not null,
  pdf_storage_path    text,
  created_at          timestamptz default now(),
  issued_at           timestamptz,
  revoked_at          timestamptz,
  revocation_reason   text,
  superseded_by       uuid references clinical.advisories(id),
  constraint revocation_needs_reason check (
    revoked_at is null or coalesce(revocation_reason,'') <> '')
);

create table clinical.advisory_signoffs (
  id              uuid primary key default gen_random_uuid(),
  advisory_id     uuid not null references clinical.advisories(id) on delete cascade,
  signed_by       uuid not null references clinical.app_users(id),
  registration_no text not null,
  registration_body text not null,
  signed_at       timestamptz not null default now(),
  signature_hash  text not null,
  unique (advisory_id)
);

-- HARD RULE: an advisory cannot become 'issued' without a sign-off.
--
-- CORRECTION TO THE BLUEPRINT: the specification declares this trigger
-- `before update` only. That leaves the rule trivially bypassable by
-- INSERTing a row with status 'issued' directly, which never fires an UPDATE
-- trigger. In a fail-closed system the enforcement point must cover every
-- path that can produce the guarded state. It now fires on INSERT as well.
create or replace function clinical.enforce_signoff()
returns trigger language plpgsql
security definer set search_path = clinical, pg_temp as $$
begin
  if new.status = 'issued' then
    if not exists (select 1 from clinical.advisory_signoffs s
                   where s.advisory_id = new.id) then
      raise exception 'ADVISORY_UNSIGNED: cannot issue without clinician sign-off'
        using errcode = 'check_violation';
    end if;
    if not clinical.has_active_consent(new.index_case_id, 'advisory_issue') then
      raise exception 'CONSENT_MISSING: no active advisory consent'
        using errcode = 'check_violation';
    end if;
    if new.issued_at is null then
      new.issued_at := now();
    end if;
  end if;
  return new;
end $$;

create trigger trg_enforce_signoff
  before insert or update on clinical.advisories
  for each row execute function clinical.enforce_signoff();

-- The frozen content snapshot must stay frozen. Once an advisory is signed
-- or issued, its text and its hash are immutable; a correction is a new
-- advisory that supersedes the old one, not an edit to the record of what
-- was actually handed to a patient.
create or replace function clinical.freeze_issued_content()
returns trigger language plpgsql as $$
begin
  if old.status in ('signed','issued','revoked','superseded') then
    if new.content_clinical is distinct from old.content_clinical
       or new.content_patient is distinct from old.content_patient
       or new.content_hash is distinct from old.content_hash
       or new.rule_pack_version is distinct from old.rule_pack_version then
      raise exception 'ADVISORY_IMMUTABLE: content of a % advisory cannot be altered; supersede it instead', old.status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger trg_freeze_issued_content
  before update on clinical.advisories
  for each row execute function clinical.freeze_issued_content();

-- ---------------------------------------------------------------------
-- COUNSELLING
-- ---------------------------------------------------------------------
create table clinical.counselling_records (
  id              uuid primary key default gen_random_uuid(),
  index_case_id   uuid not null references clinical.index_cases(id) on delete cascade,
  advisory_id     uuid references clinical.advisories(id),
  counselled_by   uuid not null references clinical.app_users(id),
  counselled_at   timestamptz default now(),
  language        text not null,
  topics_covered  text[] not null,     -- must include 'right_not_to_know'
  duration_min    integer,
  notes           text,
  constraint right_not_to_know_covered
    check ('right_not_to_know' = any(topics_covered))
);

-- ---------------------------------------------------------------------
-- THE ETHICS FIX, EXPRESSED AS A SCHEMA.
--
-- There is no relatives table. No names, no phone numbers, no contact
-- attempts, no inferred genotypes. What exists is a relationship type and a
-- count: "two siblings, one parent". That is aggregate, not identifying.
--
-- When someone asks how non-consenting relatives are protected, the answer
-- is not a policy document. It is: there is no table to put them in.
-- ---------------------------------------------------------------------
create table clinical.advisory_recipient_summary (
  id                uuid primary key default gen_random_uuid(),
  advisory_id       uuid not null references clinical.advisories(id) on delete cascade,
  relationship_type text not null
    check (relationship_type in ('sibling','parent','child','other_first_degree')),
  count             integer not null check (count > 0 and count <= 30),
  recorded_at       timestamptz default now(),
  unique (advisory_id, relationship_type)
);

-- A relative becomes their OWN index case, with their own consent. The only
-- link is a token the patient hands over voluntarily. The system never holds
-- the connection; the family does.
create table clinical.self_referred_individuals (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references clinical.organizations(id),
  own_index_case_id   uuid not null references clinical.index_cases(id),
  presented_family_link_token text,     -- supplied BY THEM, may be null
  presented_at        timestamptz default now(),
  own_consent_at      timestamptz not null,
  declined_information boolean default false   -- right not to know, exercised
);

-- ---------------------------------------------------------------------
-- APPEND-ONLY AUDIT LOG
-- ---------------------------------------------------------------------
create table clinical.audit_log (
  id            bigserial primary key,
  occurred_at   timestamptz not null default now(),
  actor_id      uuid,
  org_id        uuid,
  action        text not null,
  object_type   text not null,
  object_id     uuid,
  reason_codes  text[],
  detail        jsonb,          -- NEVER clinical free text. Codes and IDs only.
  ip_hash       text
);

create index idx_audit_org_time on clinical.audit_log (org_id, occurred_at desc);

-- Append-only is enforced, not merely granted. Revoking UPDATE and DELETE
-- privileges protects against ordinary access; a trigger protects against a
-- privileged path too, including the table owner.
create or replace function clinical.audit_log_is_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'AUDIT_LOG_APPEND_ONLY: % on clinical.audit_log is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end $$;

create trigger trg_audit_append_only
  before update or delete or truncate on clinical.audit_log
  for each statement execute function clinical.audit_log_is_append_only();

revoke update, delete on clinical.audit_log from public;
