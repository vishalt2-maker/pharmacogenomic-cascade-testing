-- =====================================================================
-- PCT 004_rls.sql -- nothing is readable until a policy allows it.
--
-- CORRECTION TO THE BLUEPRINT: the specification enables RLS on thirteen
-- clinical tables but writes policies for six of them. RLS with no policy
-- denies everything, so as written the application cannot read its own
-- genotype orders, evaluations, counselling records or recipient summaries.
-- Every table that has RLS enabled is given an explicit policy here.
--
-- Two further deliberate restrictions, beyond the blueprint:
--   * eligibility_evaluations has no UPDATE or DELETE policy. The audit
--     spine is append-only to application users.
--   * advisories has no DELETE policy. An advisory is revoked or
--     superseded, never erased.
-- =====================================================================

-- Which organisation does the current user belong to?
-- SECURITY DEFINER with a pinned search_path: the function must be able to
-- read app_users to answer, but must not become an injection surface.
create or replace function clinical.current_org()
returns uuid language sql stable
security definer set search_path = clinical, pg_temp as $$
  select org_id from clinical.app_users
   where id = auth.uid() and is_active;
$$;

-- Fail-closed by construction: an unauthenticated session has auth.uid() of
-- NULL, current_org() returns NULL, and `org_id = NULL` is never true. No
-- policy needs to special-case the anonymous user.

alter table clinical.organizations              enable row level security;
alter table clinical.app_users                  enable row level security;
alter table clinical.index_cases                enable row level security;
alter table clinical.consents                   enable row level security;
alter table clinical.adr_events                 enable row level security;
alter table clinical.genotype_orders            enable row level security;
alter table clinical.genotype_results           enable row level security;
alter table clinical.eligibility_evaluations    enable row level security;
alter table clinical.advisories                 enable row level security;
alter table clinical.advisory_signoffs          enable row level security;
alter table clinical.counselling_records        enable row level security;
alter table clinical.advisory_recipient_summary enable row level security;
alter table clinical.self_referred_individuals  enable row level security;
alter table clinical.audit_log                  enable row level security;

-- RLS filters rows; it does not grant table access. Both are required.
grant select, insert, update on clinical.index_cases, clinical.consents,
  clinical.adr_events, clinical.genotype_orders, clinical.genotype_results,
  clinical.advisories, clinical.counselling_records,
  clinical.advisory_recipient_summary, clinical.self_referred_individuals
  to authenticated;
grant select, insert on clinical.eligibility_evaluations,
  clinical.advisory_signoffs, clinical.audit_log to authenticated;
grant select on clinical.organizations, clinical.app_users to authenticated;
grant usage, select on sequence clinical.audit_log_id_seq to authenticated;

-- ---------------------------------------------------------------------
-- Directory tables: you can see your own organisation and its members.
-- ---------------------------------------------------------------------
create policy org_self_read on clinical.organizations
  for select to authenticated
  using (id = clinical.current_org());

create policy org_users_read on clinical.app_users
  for select to authenticated
  using (org_id = clinical.current_org());

-- ---------------------------------------------------------------------
-- Org isolation on tables that carry org_id directly.
-- ---------------------------------------------------------------------
create policy org_isolation_cases on clinical.index_cases
  for all to authenticated
  using (org_id = clinical.current_org())
  with check (org_id = clinical.current_org());

create policy org_isolation_adr on clinical.adr_events
  for all to authenticated
  using (org_id = clinical.current_org())
  with check (org_id = clinical.current_org());

create policy org_isolation_advisories on clinical.advisories
  for select to authenticated
  using (org_id = clinical.current_org());
create policy org_isolation_advisories_ins on clinical.advisories
  for insert to authenticated
  with check (org_id = clinical.current_org());
create policy org_isolation_advisories_upd on clinical.advisories
  for update to authenticated
  using (org_id = clinical.current_org())
  with check (org_id = clinical.current_org());
-- (no DELETE policy: an advisory is revoked or superseded, never erased)

create policy org_isolation_selfref on clinical.self_referred_individuals
  for all to authenticated
  using (org_id = clinical.current_org())
  with check (org_id = clinical.current_org());

-- Audit spine: insert and read, never update, never delete.
create policy org_isolation_evals_read on clinical.eligibility_evaluations
  for select to authenticated
  using (org_id = clinical.current_org());
create policy org_isolation_evals_ins on clinical.eligibility_evaluations
  for insert to authenticated
  with check (org_id = clinical.current_org());

-- ---------------------------------------------------------------------
-- Child tables inherit isolation through their parent.
-- ---------------------------------------------------------------------
create policy org_isolation_consents on clinical.consents
  for all to authenticated
  using (exists (select 1 from clinical.index_cases c
                 where c.id = index_case_id and c.org_id = clinical.current_org()))
  with check (exists (select 1 from clinical.index_cases c
                 where c.id = index_case_id and c.org_id = clinical.current_org()));

create policy org_isolation_orders on clinical.genotype_orders
  for all to authenticated
  using (exists (select 1 from clinical.index_cases c
                 where c.id = index_case_id and c.org_id = clinical.current_org()))
  with check (exists (select 1 from clinical.index_cases c
                 where c.id = index_case_id and c.org_id = clinical.current_org()));

create policy org_isolation_results on clinical.genotype_results
  for all to authenticated
  using (exists (select 1 from clinical.index_cases c
                 where c.id = index_case_id and c.org_id = clinical.current_org()))
  with check (exists (select 1 from clinical.index_cases c
                 where c.id = index_case_id and c.org_id = clinical.current_org()));

create policy org_isolation_counselling on clinical.counselling_records
  for all to authenticated
  using (exists (select 1 from clinical.index_cases c
                 where c.id = index_case_id and c.org_id = clinical.current_org()))
  with check (exists (select 1 from clinical.index_cases c
                 where c.id = index_case_id and c.org_id = clinical.current_org()));

create policy org_isolation_recipients on clinical.advisory_recipient_summary
  for all to authenticated
  using (exists (select 1 from clinical.advisories a
                 where a.id = advisory_id and a.org_id = clinical.current_org()))
  with check (exists (select 1 from clinical.advisories a
                 where a.id = advisory_id and a.org_id = clinical.current_org()));

-- ---------------------------------------------------------------------
-- Sign-off: only a registered clinician, only their own signature, only on
-- an advisory belonging to their own organisation.
-- ---------------------------------------------------------------------
create policy signoff_read on clinical.advisory_signoffs
  for select to authenticated
  using (exists (select 1 from clinical.advisories a
                 where a.id = advisory_id and a.org_id = clinical.current_org()));

create policy signoff_by_registered on clinical.advisory_signoffs
  for insert to authenticated
  with check (
    signed_by = auth.uid()
    and clinical.can_sign(auth.uid())
    and exists (select 1 from clinical.advisories a
                where a.id = advisory_id and a.org_id = clinical.current_org()));

-- ---------------------------------------------------------------------
-- Audit log: insert into your own org, read your own org. No update, no
-- delete, ever -- enforced by policy here and by trigger in 003.
-- ---------------------------------------------------------------------
create policy audit_insert on clinical.audit_log
  for insert to authenticated
  with check (org_id = clinical.current_org() and actor_id = auth.uid());
create policy audit_read on clinical.audit_log
  for select to authenticated
  using (org_id = clinical.current_org());

-- ---------------------------------------------------------------------
-- KNOWLEDGE LAYER: readable by every authenticated user, written only by
-- the service role. It is public literature; the risk here is silent
-- mutation of the science, not disclosure.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'rule_packs','genes','alleles','evidence_sources','population_frequencies',
    'drugs','drug_synonyms','gene_drug_pairs','phenotypes','diplotype_phenotypes',
    'recommendations','alternatives','pair_evidence','wording_rules'
  ] loop
    execute format('alter table knowledge.%I enable row level security', t);
    execute format('grant select on knowledge.%I to authenticated', t);
    execute format(
      'create policy knowledge_read on knowledge.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- REGISTRY: service role only. No authenticated policy exists, so RLS
-- denies every application user by default. Export runs out of band.
-- ---------------------------------------------------------------------
alter table registry.cascade_records enable row level security;
