# Corrections to the blueprint

Read this before the README if you wrote the specification.

The build follows *Pharmacogenomic Cascade Testing — Master Build Planogram v1.0*
closely. Where it departs, it departs on purpose, and this file says why. The
specification's own instruction — state the limits out loud before a judge does —
applies to the specification itself.

Corrections fall into three groups: **safety defects** in the specified design,
**clinical content errors**, and **things the specification assumed would work
that do not**.

---

## A. Safety defects in the specified design

### A1. The sign-off trigger was bypassable

The specification declares:

```sql
create trigger trg_enforce_signoff
  before update on clinical.advisories
```

An `UPDATE` trigger never fires on an `INSERT`. A caller could create a row with
`status = 'issued'` directly and the entire sign-off apparatus underneath it
would never run. In a fail-closed system the enforcement point must cover every
path that can produce the guarded state.

**Fixed** in `db/migrations/003_clinical.sql`: the trigger is
`before insert or update`. Both paths are tested, including one that uses the
service role to make sure row-level security is not doing the work:

```
✔ UPDATE to issued without a sign-off is refused by the trigger
✔ INSERT directly as issued is refused too — the hole the blueprint left open
✔ a service-role caller cannot bypass the trigger either
```

### A2. Row-level security was enabled on thirteen tables with policies for six

`alter table ... enable row level security` with no policy denies **everything**.
As specified, the application could not read its own genotype orders, eligibility
evaluations, counselling records, recipient summaries, self-referrals or user
directory. The system would have failed closed, which is the right direction, but
it would have failed closed onto nothing working at all.

**Fixed** in `db/migrations/005_rls.sql`: every table with RLS enabled has an
explicit policy. Two further restrictions were added beyond the specification:

- `eligibility_evaluations` has no `UPDATE` or `DELETE` policy. The audit spine
  is append-only to application users.
- `advisories` has no `DELETE` policy. An advisory is revoked or superseded,
  never erased.

### A3. The audit log was append-only by convention

`revoke update, delete ... from public` does not bind the table owner, and on a
managed platform the application often connects as a role that is not `public`.

**Fixed**: a statement-level trigger raises on `UPDATE`, `DELETE` and `TRUNCATE`,
in addition to the revoke. Tested against the service role.

### A4. Nothing stopped an issued advisory from being edited afterwards

The specification correctly requires an immutable content snapshot, but nothing
enforced it. A signed document whose text can be changed afterwards is not a
signed document.

**Added**: `trg_freeze_issued_content` refuses any change to `content_clinical`,
`content_patient`, `content_hash` or `rule_pack_version` once an advisory is
signed, issued, revoked or superseded. A correction is a new advisory that
supersedes the old one.

### A5. Two-person genotype verification existed only in prose

Section 9.3 requires that "genotype results are entered by one user and verified
by another", but the schema had a nullable `verified_by` with nothing stopping it
being the same person, and the safety engine did not check it.

**Added**: a `verifier_is_second_person` check constraint, a service-layer error
with a comprehensible message, and gate G5 blocking with `GENOTYPE_UNVERIFIED`.

### A6. A causality grade could be recorded with no assessor

**Added**: `causality_needs_assessor` constraint. A WHO-UMC grade without a named
assessor and a timestamp is an unsigned clinical judgement.

---

## B. Clinical content errors

These matter more than the schema fixes. Each was found by checking the
specification's claims against the primary sources.

### B1. CPIC's position on a negative result is NOT the same for both drugs

Section 6.2 mandates, on any negative result:

> A negative result does not eliminate the risk of a severe cutaneous reaction.
> Clinical monitoring remains necessary.

That is correct **for phenytoin**. The 2020 guideline states directly that a
negative HLA-B\*15:02 test does not eliminate the risk of phenytoin-induced
SJS/TEN.

It is **not what CPIC says for carbamazepine**. The 2017 guideline assigns
HLA-B\*15:02-negative patients normal risk of carbamazepine-induced SJS/TEN, and
reports a negative predictive value at or near 100% for that drug. A decision
support system emitting one generic string for all aromatic anticonvulsants would
contradict the guideline it claims to reproduce.

What the carbamazepine guideline *does* warn is that a negative HLA-B\*15:02 does
not protect against SJS/TEN from **other** aromatic anticonvulsants, and that
switching on the strength of a negative result will not prevent
anticonvulsant-associated SJS/TEN.

**Fixed**: `negative_result_caution` is a column on `gene_drug_pairs`, not a
global string. Each pair carries what the guidance actually says about a negative
result for that drug. Tested:

```
✔ the phenytoin advisory states ITS OWN negative caution, not carbamazepine's
```

This is the single most consequential correction in this file.

### B2. Lamotrigine and eslicarbazepine do not carry their own HLA-B\*15:02 signal

Section 6.2 mandates the clause:

> CPIC notes that some alternatives — including oxcarbazepine, eslicarbazepine
> acetate and lamotrigine — carry their own signal in HLA-B\*15:02 carriers.

Checked against the source, this conflates three different situations:

| Drug | What CPIC actually does |
|---|---|
| **Oxcarbazepine** | Paired with HLA-B at Level A in its own right. The 2017 update extends the avoidance recommendation to it. Positive predictive value 0.73%, against 7.7% for carbamazepine. |
| **Eslicarbazepine acetate** | **No HLA-B pair at any CPIC level.** Described as having "very limited evidence, if any". Caution advised when choosing an alternative. No recommendation is made. |
| **Lamotrigine** | **No HLA-B pair at any CPIC level.** Same "very limited evidence, if any" language. Appears in the guideline via HLA-A\*31:01, for which CPIC gives no recommendation. |

Overstating a signal is the same class of error as understating one: it pushes a
prescriber away from an alternative that the evidence does not actually condemn,
in a patient who has just had a life-threatening reaction and has few options
left.

**Fixed**: the caution text for each alternative now says what the guidance says.
Oxcarbazepine carries the avoidance recommendation and the PPV figures.
Eslicarbazepine and lamotrigine carry the "very limited evidence, if any"
language and the general caution.

### B3. The Indian allele frequency figure differs from the primary source

The specification states an average HLA-B\*15:02 allele frequency across Indian
communities of "around 2.5%, range 0–6%".

The primary source located for this build (Biswas et al., *Health Sci Rep* 2026,
analysing the Allele Frequency Net Database) gives a weighted mean for India of
**2.1% (SD 1.5)**, with a range across sub-populations of **0% to 14.2%** — a
substantially wider upper bound than 6%, from **n = 714 individuals for the whole
of India**.

No primary source was found for the 0–6% range. Where the two disagree, the
recorded value is the one in the source, and the disagreement is printed rather
than reconciled. See `db/seed/context-figures.ts`.

**The sample size is the real finding.** 714 individuals is far too thin a basis
to carry a risk calculation for a country of that size and genetic diversity. No
number in this system is derived from it.

### B4. "Number needed to screen to prevent one death" is a range, not a number

The specification gets this right in the prose (1,474 to 8,840) and it is worth
stating why it must never be collapsed: the spread depends entirely on the
case-fatality rate assumed. Any single figure is wrong whichever one is chosen.
`context-figures.ts` records it as a range with that caveat attached.

### B5. Citation corrections

| Specification says | Actually |
|---|---|
| Chen, Liew & Kwan, PLoS ONE 2014 — a cost-effectiveness analysis | Titled *Real-world **efficiency** of pharmacogenetic screening for carbamazepine-induced severe cutaneous adverse reactions*. PMID 24806465. Not framed as a cost-effectiveness analysis. |
| "A Malaysian analysis" (unattributed) | Chong HY et al., *Br J Dermatol* 2017;177(4):1102-1112. PMID 28346659. Base case: universal screening was **dominated** — more costly and less effective. |
| CPIC guideline "for HLA-B genotype and use of carbamazepine and oxcarbazepine: 2017 update" | Title is "for **HLA Genotype** and Use of…". The gene scope is deliberately broader than HLA-B and includes HLA-A\*31:01. PMID 29392710. |
| CPIC guideline "for CYP2C9 and HLA-B genotype and phenytoin dosing" | "HLA-B **Genotypes**", plural, and the official title carries "(CPIC)". PMID 32779747. |

### B6. The "actionability, not evidence" claim needs care

Section 4.1 is the specification's strongest intellectual move, and it is
correct: CPIC does run four separately graded dimensions, and they are documented.

But the crisp statement that A/B/C/D "is an actionability level, not a level of
evidence" could only be located in a **CPIC-authored slide deck from March 2021**,
not in any current normative page on the CPIC or ClinPGx site. The four graded
dimensions are well supported and are what this build implements. The
"not evidence" framing should be presented as an interpretation, not quoted as a
normative statement, unless CPIC confirms it in writing.

### B7. Mortality figures disagree between sources

The specification gives roughly 5% for SJS and around 30% for TEN. Those are
CPIC's own figures and are used here for internal consistency. They are not
agreed: MedlinePlus Genetics gives about 10% for SJS and up to 50% for TEN.
The disagreement is recorded with the figure rather than hidden.

---

## C. Things the specification assumed would work

### C1. `is_indian` cannot be a generated column

```sql
is_indian boolean generated always as (population ilike '%indian%') stored
```

PostgreSQL requires a generated-column expression to be immutable. The
case-insensitive match operator is not. **Fixed**: a plain column maintained by a
`before insert or update` trigger.

### C2. `population_frequencies.source_id` was a bare uuid

The specification declares it with a `-- → evidence_sources` comment because
`evidence_sources` is created later in the file. A comment is not a foreign key.
**Fixed**: `evidence_sources` is declared first, and the column is a real
reference.

### C3. `pgaudit` is not available everywhere

`create extension if not exists "pgaudit"` fails outright where the extension is
not installed, taking the whole migration with it. **Fixed**: it lives in an
optional migration applied only where it exists. Database-level audit logging is
in addition to `clinical.audit_log`, never a substitute.

### C4. `auth.users` is Supabase-specific

The clinical schema references `auth.users(id)` and every policy calls
`auth.uid()`. **Fixed**: `001_local_auth_shim.sql` reproduces exactly that
contract for a plain PostgreSQL, and is skipped when `PCT_TARGET=supabase`. The
clinical DDL and the policies are byte-identical across both targets.

### C5. A hash over twelve joined tables stops meaning anything

Gate G0 must recompute the rule pack hash and compare. Reconstructing a pack from
the relational tables and hoping the serialisation matches is how integrity
checks quietly stop working. **Fixed**: `rule_packs.content_json` holds the
frozen bundle the hash actually attests to; the relational tables are the
queryable, CPIC-shaped form of the same content.

### C6. A germline genotype does not expire

Gate G5 as specified requires `result_date within validity`. HLA-B\*15:02 is
germline and does not change; expiring a valid result would block a real carrier
for an administrative reason.

**Implemented**: `genotypeMaxAgeDays` defaults to `null`, meaning no expiry, and
is configurable per deployment for sites whose governance requires it. What *is*
enforced unconditionally is that a result date cannot be in the future, which
catches the data-entry error the validity check was probably aiming at.

### C7. Gate G6 needed two reason codes, not one

The specification maps both "zero recommendations" and "more than one" to
`RECOMMENDATION_AMBIGUOUS`. These are different faults with different remedies: a
missing recommendation means the pack is incomplete; two means it is
contradictory. Split into `RECOMMENDATION_MISSING` and `RECOMMENDATION_AMBIGUOUS`.

### C8. Gate G7 and mixed actionability levels

The enum allows `A/B`, `B/C`, `C/D`. The gate is specified as
`cpic_actionability ∈ {A, B}`. Mixed levels are therefore **below** the threshold
and produce `INFORM_ONLY`. That is the fail-closed reading and it is what is
implemented, but it is a decision, not something the specification settled.

### C9. The wording linter needs negation exemptions

Section 6.1 bans "will develop" and Section 6.2 *mandates* the clause
"…does not mean this person will experience a severe reaction". Applied naively,
the linter refuses every compliant document.

**Implemented**: banned rules carry an optional `exempt_if_preceded_by` pattern,
so the linter can tell an assertion from its denial. `BAN_CLEARED` deliberately
has **no** exemption: there is no safe way to print that word.

This bit during the build. The demonstration banner read "not
regulatory-cleared" and the linter refused the entire document. The rule was
right and the banner was reworded.

### C10. Indic scripts cannot go in a PDF built on the standard fonts

Section 6.3 requires the patient sheet "in the patient's preferred language". The
built-in PDF fonts are Latin-only. A Hindi sheet therefore **refuses** to render
as PDF rather than dropping characters, and the HTML rendering is served instead,
which browsers and printers handle correctly.

**This is a real gap, not a solved problem.** Shipping Indic-language PDFs needs
a subsetted OpenType font embedded in the document. Until then, Hindi is served
as HTML and Tamil has no sheet at all — the fallback is English, and the system
says so rather than silently substituting.

---

## D. Not built

Named so that nobody has to discover them by looking.

| Specified | Status |
|---|---|
| SMART on FHIR launch | Not implemented. The CDS Hooks discovery and card shapes follow the specification; resolving `context.patientId` against a real FHIR server does not exist. |
| JWT validation on CDS Hooks requests | Not implemented. A real EHR sends a signed JWT in the Authorization header. This build trusts a header. |
| HL7 v2 ADT/ORU fallback | Not built. |
| Authentication | **There is none.** The caller asserts an identity in `x-pct-user`. Adequate for a concept build on localhost; not authentication. The subject claim drives `auth.uid()` exactly as a real identity provider's would, so the RLS layer is unaffected by the substitution. |
| Cryptographic signature on rule packs | The column exists and the hash is real. Nothing signs it yet. |
| Key management | The MRN key comes from an environment variable, with a clearly-labelled demo default. It belongs in a managed key service with rotation and a key version in the ciphertext. |
| Supabase deployment | The migrations are written to run there unchanged, minus the shim. It has not been run against a Supabase project. |
| Misattributed parentage protocol | A governance document, not code. It must be written and agreed with an ethics committee before the first real case. |

---

## E. Additions beyond the specification

| Addition | Why |
|---|---|
| `rule_packs.provenance_status` | A pack assembled for demonstration must never be mistaken for one a human has curated. The engine refuses to issue from a `demonstration` pack unless a deployment explicitly opts in, and the renderer stamps a banner on every page. |
| `evidence_sources.verification_status` | "Do not cite anything you have not personally opened" is worth nothing unless the database can record whether someone did. |
| `db/seed/context-figures.ts` | Every number the system shows outside a laboratory result, with its source and its caveats. Nothing may be stated that is not on that list. |
| `knowledge.wording_rules` | The Section 6 rules ship *inside* the rule pack, so an advisory issued in 2026 can be re-linted in 2031 against the rules that actually applied. |
| `knowledge.drug_synonyms` | Lets "Tegretol" resolve to carbamazepine without the engine guessing. An unmatched name is out of scope, never assumed in. |
| `phenotypes.is_risk_phenotype` | The negative pathway is decided structurally, not by string-matching the word "negative" at render time. |
| `registry.export_runs` | An export is an event worth auditing: who ran it, at what threshold, how much was withheld. |
| `audit.assertCodesOnly` | The specification says the audit `detail` column takes codes and identifiers only. This enforces it, rejecting anything that looks like prose. |
