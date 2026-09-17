-- =====================================================================
-- PCT 002_knowledge.sql -- the science. No patient ever appears here.
-- Mirrors CPIC/ClinPGx structure so the shape is familiar to anyone who
-- has worked with CPIC data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- RULE PACKS: a frozen, dated, hashed bundle of everything below.
-- Every advisory records which pack produced it, forever.
-- ---------------------------------------------------------------------

-- ADDITION beyond the blueprint. A pack that was assembled for
-- demonstration must never be mistaken for one whose citations a human has
-- checked against primary sources. The renderer keys a banner off this, and
-- the engine refuses to issue from a 'demonstration' pack unless the
-- deployment explicitly opts in.
create type knowledge.provenance_status as enum (
  'demonstration',       -- illustrative content; NOT clinically curated
  'curated_unverified',  -- curated by a human, citations not yet source-checked
  'curated_verified'     -- every citation opened and checked against primary source
);

create table knowledge.rule_packs (
  id                uuid primary key default gen_random_uuid(),
  version           text not null unique,        -- e.g. '2026.03.1'
  cpic_release      text,                        -- upstream CPIC/ClinPGx release id
  source_url        text,
  published_at      timestamptz not null,
  effective_from    timestamptz not null,
  expires_at        timestamptz not null,        -- HARD expiry. Engine blocks past this.
  content_hash      text not null,
  signature         text,
  -- The frozen bundle itself. The relational tables below are the
  -- queryable, CPIC-shaped form of the same content; this column is the
  -- artifact the content_hash actually attests to. Reconstructing a pack
  -- from twelve joined tables and hoping the hash still matches is how
  -- integrity checks quietly stop meaning anything.
  content_json      jsonb not null,
  is_active         boolean not null default false,
  provenance_status knowledge.provenance_status not null default 'demonstration',
  curated_by        text,
  notes             text,
  created_at        timestamptz not null default now(),
  constraint expiry_after_effective check (expires_at > effective_from)
);

-- Only one pack active at a time. Two active packs means two answers to the
-- same question, which is the same as having none.
create unique index one_active_pack
  on knowledge.rule_packs (is_active) where is_active;

comment on column knowledge.rule_packs.expires_at is
  'HARD expiry, enforced by the safety engine (gate G0), not advisory. Star-allele definitions change and CPIC guidelines are revised; a cached ruleset that never expires is a patient-safety defect waiting to happen.';

-- ---------------------------------------------------------------------
-- GENES AND ALLELES
-- ---------------------------------------------------------------------
create table knowledge.genes (
  id            uuid primary key default gen_random_uuid(),
  rule_pack_id  uuid not null references knowledge.rule_packs(id) on delete cascade,
  symbol        text not null,                   -- 'HLA-B', 'CYP2C9'
  name          text,
  -- CPIC renamed gene.pharmgkbid -> gene.clinpgxid in the March 2026 release.
  -- Logically identical, name changed. Using the new name now avoids a migration.
  clinpgx_id    text,
  hgnc_id       text,
  unique (rule_pack_id, symbol)
);

create type knowledge.allele_function as enum (
  'no function','decreased function','normal function',
  'increased function','uncertain function','unknown function',
  'risk allele','non-risk allele'
);

create type knowledge.evidence_strength as enum ('high','moderate','weak');

create table knowledge.alleles (
  id                  uuid primary key default gen_random_uuid(),
  rule_pack_id        uuid not null references knowledge.rule_packs(id) on delete cascade,
  gene_id             uuid not null references knowledge.genes(id) on delete cascade,
  allele_name         text not null,             -- '*15:02', '*3'
  clinical_function   knowledge.allele_function not null,
  -- DIMENSION 4: CPIC grades allele function assignment separately from
  -- pair evidence. Kept separate here because it IS separate.
  function_evidence   knowledge.evidence_strength,
  pharmvar_id         text,
  activity_value      numeric,                   -- for activity-score genes
  unique (rule_pack_id, gene_id, allele_name)
);

-- ---------------------------------------------------------------------
-- EVIDENCE SOURCES -- declared before population_frequencies so the
-- source_id foreign key can be real rather than a bare uuid column.
-- ---------------------------------------------------------------------
create type knowledge.verification_status as enum (
  'verified_primary_source',  -- a human opened the paper
  'unverified',               -- transcribed, not yet checked
  'disputed'
);

create table knowledge.evidence_sources (
  id              uuid primary key default gen_random_uuid(),
  rule_pack_id    uuid not null references knowledge.rule_packs(id) on delete cascade,
  citation        text not null,
  pmid            text,
  doi             text,
  study_design    text,          -- 'case-control','meta-analysis','cohort'
  population      text,
  country         text,
  case_n          integer,
  control_n       integer,
  effect_measure  text,          -- 'OR'
  effect_value    numeric,
  ci_low          numeric,
  ci_high         numeric,
  is_indian_cohort boolean default false,
  -- ADDITION: "Do not cite anything you have not personally opened."
  -- That instruction is worth nothing unless the database can express it.
  verification_status knowledge.verification_status not null default 'unverified',
  verified_by     text,
  verified_at     timestamptz,
  verified_url    text,
  quality_notes   text
);

-- ---------------------------------------------------------------------
-- POPULATION FREQUENCIES -- where the Indian contribution accumulates.
-- ---------------------------------------------------------------------
create table knowledge.population_frequencies (
  id             uuid primary key default gen_random_uuid(),
  rule_pack_id   uuid not null references knowledge.rule_packs(id) on delete cascade,
  allele_id      uuid not null references knowledge.alleles(id) on delete cascade,
  population     text not null,                  -- 'Indian - South', 'Han Chinese'
  region         text,                           -- state / zone, where known
  allele_freq    numeric,
  carrier_freq   numeric,
  sample_n       integer,
  source_id      uuid references knowledge.evidence_sources(id),
  -- Plain column maintained by trigger rather than GENERATED ALWAYS: the
  -- case-insensitive match operator is not immutable, so Postgres rejects it
  -- in a generated-column expression.
  is_indian      boolean not null default false
);

create or replace function knowledge.set_is_indian()
returns trigger language plpgsql as $$
begin
  new.is_indian := coalesce(new.population, '') ilike '%indian%'
                or coalesce(new.population, '') ilike '%india%';
  return new;
end $$;

create trigger trg_set_is_indian
  before insert or update of population on knowledge.population_frequencies
  for each row execute function knowledge.set_is_indian();

-- ---------------------------------------------------------------------
-- DRUGS AND GENE-DRUG PAIRS
-- All four CPIC dimensions kept separate, plus the India tier.
-- ---------------------------------------------------------------------
create type knowledge.cpic_actionability as enum ('A','B','C','D','A/B','B/C','C/D');
create type knowledge.rec_strength        as enum ('strong','moderate','optional','no recommendation');
create type knowledge.india_tier          as enum ('IN-1','IN-2','IN-3','IN-4','IN-0');

comment on type knowledge.cpic_actionability is
  'DIMENSION 1: CPIC actionability level. This is NOT a level of evidence. It describes whether prescribing should change, not how strong the science is.';

create table knowledge.drugs (
  id            uuid primary key default gen_random_uuid(),
  rule_pack_id  uuid not null references knowledge.rule_packs(id) on delete cascade,
  name          text not null,
  rxnorm_id     text,
  atc_code      text,
  clinpgx_id    text,
  is_aromatic_anticonvulsant boolean default false,
  unique (rule_pack_id, name)
);

-- Lets the engine resolve 'Tegretol' or a misspelling to the pair without
-- silently guessing. An unmatched name is out of scope, never assumed in.
create table knowledge.drug_synonyms (
  id            uuid primary key default gen_random_uuid(),
  rule_pack_id  uuid not null references knowledge.rule_packs(id) on delete cascade,
  drug_id       uuid not null references knowledge.drugs(id) on delete cascade,
  synonym       text not null,
  synonym_type  text,                            -- 'brand','inn','spelling'
  unique (rule_pack_id, synonym)
);

create table knowledge.gene_drug_pairs (
  id                    uuid primary key default gen_random_uuid(),
  rule_pack_id          uuid not null references knowledge.rule_packs(id) on delete cascade,
  gene_id               uuid not null references knowledge.genes(id),
  drug_id               uuid not null references knowledge.drugs(id),
  -- DIMENSION 1: actionability (NOT evidence level)
  cpic_actionability    knowledge.cpic_actionability not null,
  -- DIMENSION 3: strength of evidence for the findings
  evidence_strength     knowledge.evidence_strength,
  -- DIMENSION 5: India-specific tier (our addition)
  india_evidence_tier   knowledge.india_tier not null default 'IN-4',
  india_tier_rationale  text,
  guideline_citation    text not null,
  guideline_version     text not null,
  guideline_pmid        text,
  guideline_doi         text,
  guideline_url         text,
  -- What a NEGATIVE result means FOR THIS PAIR, in this pair's own words.
  -- CPIC's position is not uniform across aromatic anticonvulsants, so a
  -- single global "a negative does not eliminate risk" string would state
  -- something CPIC does not say for at least one drug here. Drug-specific,
  -- or not said at all.
  negative_result_caution text not null,
  in_cascade_scope      boolean not null default false,
  unique (rule_pack_id, gene_id, drug_id)
);

-- ---------------------------------------------------------------------
-- PHENOTYPES AND DIPLOTYPES
-- ---------------------------------------------------------------------
create table knowledge.phenotypes (
  id            uuid primary key default gen_random_uuid(),
  rule_pack_id  uuid not null references knowledge.rule_packs(id) on delete cascade,
  gene_id       uuid not null references knowledge.genes(id) on delete cascade,
  term          text not null,        -- 'positive', 'poor metabolizer'
  description   text,
  -- Lets the negative pathway be recognised structurally rather than by
  -- string-matching the word 'negative' at render time.
  is_risk_phenotype boolean not null default false,
  unique (rule_pack_id, gene_id, term)
);

-- Every diplotype the lab can report, mapped to a phenotype.
-- A diplotype that is not in this table is UNRECOGNISED, and unrecognised
-- blocks. It is never quietly treated as absence of risk.
create table knowledge.diplotype_phenotypes (
  id            uuid primary key default gen_random_uuid(),
  rule_pack_id  uuid not null references knowledge.rule_packs(id) on delete cascade,
  gene_id       uuid not null references knowledge.genes(id) on delete cascade,
  diplotype     text not null,        -- '*15:02/*15:02', '*1/*15:02'
  phenotype_id  uuid not null references knowledge.phenotypes(id),
  activity_score numeric,
  unique (rule_pack_id, gene_id, diplotype)
);

create type knowledge.action_code as enum (
  'avoid_drug','reduce_dose','standard_dose','use_with_caution',
  'no_recommendation','monitor_only'
);

create table knowledge.recommendations (
  id                  uuid primary key default gen_random_uuid(),
  rule_pack_id        uuid not null references knowledge.rule_packs(id) on delete cascade,
  gene_drug_pair_id   uuid not null references knowledge.gene_drug_pairs(id) on delete cascade,
  phenotype_id        uuid not null references knowledge.phenotypes(id),
  action_code         knowledge.action_code not null,
  -- DIMENSION 2: how firmly the action is advised
  recommendation_strength knowledge.rec_strength not null,
  clinical_text       text not null,      -- paraphrased; check licence before verbatim
  implications_text   text,
  source_table_ref    text,               -- e.g. 'CPIC 2020 Table 3'
  unique (rule_pack_id, gene_drug_pair_id, phenotype_id)
);

-- Exists specifically because CPIC warns that some alternatives carry their
-- own signal in *15:02 carriers. An alternative without its caution is a
-- hazard, so the constraint makes the caution unskippable.
create table knowledge.alternatives (
  id                  uuid primary key default gen_random_uuid(),
  rule_pack_id        uuid not null references knowledge.rule_packs(id) on delete cascade,
  recommendation_id   uuid not null references knowledge.recommendations(id) on delete cascade,
  alternative_drug_id uuid not null references knowledge.drugs(id),
  caution_flag        boolean not null default false,
  caution_text        text,
  constraint caution_needs_text
    check (caution_flag = false or caution_text is not null)
);

create table knowledge.pair_evidence (
  gene_drug_pair_id uuid references knowledge.gene_drug_pairs(id) on delete cascade,
  evidence_id       uuid references knowledge.evidence_sources(id) on delete cascade,
  primary key (gene_drug_pair_id, evidence_id)
);

-- Mandatory and banned wording, versioned WITH the science that it guards.
-- Shipping the linter rules inside the rule pack means an advisory issued in
-- 2026 can be re-linted in 2031 against the rules that actually applied.
create table knowledge.wording_rules (
  id            uuid primary key default gen_random_uuid(),
  rule_pack_id  uuid not null references knowledge.rule_packs(id) on delete cascade,
  rule_code     text not null,
  kind          text not null check (kind in ('banned','mandatory')),
  applies_to    text not null check (applies_to in ('clinical','patient','both')),
  pattern       text,            -- regex, for banned constructions
  -- A banned construction is usually only banned when ASSERTED. The
  -- mandatory non-determinism clause necessarily contains "will experience",
  -- negated. This holds the regex for the preceding context that exempts a
  -- match, so the linter can tell an assertion from its denial.
  exempt_if_preceded_by text,
  clause_key    text,            -- content key, for mandatory clauses
  rationale     text not null,
  unique (rule_pack_id, rule_code)
);
