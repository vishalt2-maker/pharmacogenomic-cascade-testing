# Pharmacogenomic Cascade Testing (PCT)

**Concept build. Nothing here is deployed, validated, or approved by any
regulator.** The rule pack ships as demonstration content and the safety engine
refuses to issue from it unless a deployment explicitly opts in.

---

## What it is, in one sentence

A fail-closed clinical decision support system that turns a causality-confirmed,
genotype-confirmed severe cutaneous adverse drug reaction into a signed familial
pharmacogenomic advisory for the index patient, and aggregates the de-identified
result into a pharmacogenomic registry that does not currently exist in India.

## Why it exists

Carbamazepine and phenytoin are cheap, off-patent, on essential medicines lists,
and prescribed at enormous volume in exactly the settings least able to absorb a
catastrophic outcome. The link between HLA-B\*15:02 and carbamazepine-induced
Stevens-Johnson Syndrome and Toxic Epidermal Necrolysis is one of the strongest
drug-gene associations in medicine, and the guidance is unambiguous: in a carrier,
use something else.

Universal screening does not work in India. Real-world data from Hong Kong found
442 screening tests to prevent one case, 1,474 to 8,840 to prevent one death, at
roughly US$332 per person screened — in a population whose allele frequency is
considerably higher than India's. A Malaysian analysis in a diverse population
found universal screening dominated by current practice: more costly **and** less
effective.

So the intervention that works is the one India is structurally least able to
deploy, and people keep dying at a low, steady, invisible rate.

**Cascade testing changes the arithmetic.** Stop screening populations; start from
someone already proven to carry the variant. Carriers are essentially always
heterozygous, so each first-degree relative has roughly a 50% prior against a
population carrier rate of a few per cent. That is about a tenfold enrichment,
which cuts tests-needed-to-prevent-one-case by roughly an order of magnitude. It
is the same logic already standard of care in familial hypercholesterolaemia and
Lynch syndrome.

Every figure above is recorded with its source and its caveats in
`db/seed/context-figures.ts`. Several differ from what circulates in secondary
summaries; see `docs/CORRECTIONS.md` §B.

## What it is not

| It is NOT | Because |
|---|---|
| A population screening tool | The economics don't work in India; that's the problem it routes around |
| A genetic testing service | It performs no assay; an accredited laboratory does |
| A diagnostic device | It diagnoses nothing; it surfaces published guidance to a clinician who decides |
| A tool that contacts relatives | It processes one data subject: the index patient. There is no relatives table |
| An AI that predicts risk | The engine is deterministic rules. No model, no inference, no invented probabilities |
| A referral business | No commission, no tracked links, no per-test revenue — enforced by the wording linter |

---

## Running it

**Node 22.18 or later is the only prerequisite.** No database to install, no
build step, no Docker. Node runs the TypeScript directly, and the database runs
inside the Node process.

```bash
git clone https://github.com/vishalt2-maker/pharmacogenomic-cascade-testing
cd pharmacogenomic-cascade-testing
npm install
npm run setup     # create the database, load the rule pack, seed two hospitals
npm run demo      # the demonstration: refusals first, then the happy path
npm run serve     # the AMC module at http://localhost:8787
npm test          # 240 tests
```

`npm start` does the setup and then serves, which is the shortest path to a
running screen on a machine that has never seen this before.

`npm run demo` writes rendered advisories to `demo-output/`.

Works on macOS, Linux and Windows. There is one dependency,
`@electric-sql/pglite`, which is WebAssembly and therefore
architecture-independent: the same install works on Apple silicon, Intel and
ARM Linux without a compiler.

### Why 22.18 specifically

The project ships TypeScript with no build step, so Node has to strip the types
itself. That became default behaviour in Node 22.18 and in Node 23.6. On Node
22.6 through 22.17 the capability exists behind `--experimental-strip-types`;
set `NODE_OPTIONS=--experimental-strip-types` if you are stuck on one of those.
Below 22.6 it will not run at all.

Every entry point runs a preflight that checks this and prints what to do, so
nobody meets the problem as an unexplained `SyntaxError`:

```bash
node scripts/check-node.cjs
```

### The database

**PGlite**: real PostgreSQL 18, compiled to WebAssembly, running in-process.
Nothing to install and nothing to configure.

That matters more than convenience. The row-level security policies, the
sign-off trigger and the append-only audit log exercised by the test suite are
the ones in `db/migrations/`, not a hand-written imitation. When
`test/rls.test.ts` shows one hospital failing to read another's data, PostgreSQL
is enforcing that, not a mock.

The data directory is `.data/pgdata`, which is git-ignored. It is scratch: delete
it and `npm run setup` rebuilds everything from the migrations and the seed.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port for `npm run serve` |
| `PCT_DATA_DIR` | `.data/pgdata` | Database location. `:memory:` for an ephemeral one |
| `PCT_TARGET` | `local` | Set to `supabase` to skip the local auth shim migration |
| `PCT_MRN_KEY` | a labelled demo key | Key for hashing and encrypting record numbers |

`PCT_MRN_KEY` has a clearly-labelled default so the demonstration runs out of the
box. **Set it to something real before any data you care about goes in, and read
`docs/GOVERNANCE.md` §3 on why an environment variable is not where this belongs
in a deployment.**

---

## The five gates

```
  ADR logged at the AMC
        ↓
  ┌─────────────────────────────────────────────┐
  │ GATE 1  Drug in scope + cutaneous reaction  │  else → no output
  │ GATE 2  WHO-UMC causality ≥ probable        │  else → no output
  │ GATE 3  Index patient consented + genotyped │  else → no output
  │ GATE 4  Active, unexpired rule pack         │  else → no output
  │ GATE 5  Named clinician review + sign-off   │  else → draft only
  └─────────────────────────────────────────────┘
        ↓
  Signed advisory issued TO THE INDEX PATIENT
        ↓
  The patient decides whether to share it
        ↓
  A relative may self-present, self-consent,
  and become their own subject
        ↓
  De-identified record → registry
```

Internally the engine runs nine numbered gates (G0–G8) so that each refusal has
its own reason code. **Genotype confirmation is the differentiator.** Demonstrate
the system refusing there. Every other product demo shows the thing doing
something; in a safety product, restraint is what a clinical audience remembers.

## Design principles

1. **Fail closed.** Every ambiguity resolves to no output. Missing genotype, stale
   rule pack, unclear causality, unsupported diplotype: nothing is produced, and
   the system says exactly why. A CDSS that produces nothing is safe. A CDSS that
   guesses is a hazard.
2. **The clinician is the actor.** The software proposes; a named, registered
   clinician disposes and signs. The engine's best possible output is a *draft*.
3. **One data subject.** The index patient. Relatives are never named, recorded,
   contacted or inferred about. This is enforced in the schema, not in policy.
4. **Deterministic, versioned, auditable.** Every advisory records exactly which
   rule pack produced it, and the hash is recomputed rather than trusted.
5. **Evidence is graded and the grade is visible** — especially when it is weak.

---

## Architecture

```
L1  INTEGRATION EDGE   CDS Hooks service (patient-view, order-sign)
                       Standalone web module
L2  SAFETY ENGINE      deterministic, stateless, pure. No LLM. No model.
L3  KNOWLEDGE LAYER    non-PHI, read-only, versioned rule packs
L4  CLINICAL LAYER     PHI, row-level-secured per organisation, audited
L5  DOCUMENT LAYER     renderer → linter → signed PDF / HTML + content hash
L6  REGISTRY LAYER     de-identified, aggregate, small-cell suppressed
```

### Why CDS Hooks and not a browser extension

Stated plainly because it comes up in every hospital IT review: a DOM-scraping
extension reading clinical text is indiscriminate surveillance of everything the
user types, sits on the most exploited surface in the hospital, and carries
supply-chain risk through its update channel. CDS Hooks with SMART on FHIR is the
recognised standard for injecting decision support into clinical workflow. It is
permissioned, auditable, and scoped to the moment it is asked to act.

### Where things live

| Path | What |
|---|---|
| `src/engine/engine.ts` | The safety engine. A pure function. Read this first. |
| `src/engine/reason-codes.ts` | Every reason the engine can give. There is no "other". |
| `db/migrations/` | The schema, in order. Runs on PostgreSQL 15+ and on Supabase minus the shim. |
| `db/seed/rule-pack-2026.03.1.ts` | One gene, two drugs, hand-curated. |
| `db/seed/wording-rules.ts` | Section 6 safety wording, as data. |
| `db/seed/context-figures.ts` | Every number the system states, with its source. |
| `src/render/linter.ts` | Refuses to render a document containing a banned construction. |
| `src/render/advisory.ts` | Two documents: clinical, and a patient sheet in plain language. |
| `src/registry/export.ts` | De-identification, consent filtering, small-cell suppression. |
| `src/api/cds-hooks.ts` | The decision-support cards. |
| `src/ui/` | The AMC screen. Vanilla ES modules, no framework. |

### The operator screen has two modes

By default it is a **data-entry interface**: a form for each step of the
pathway, covering the reaction and its causality, the genotype order and its
result, the advisory's recipient counts, and the counselling record.

Every option those forms offer is served by `GET /api/reference`, which reads
enum members and CHECK constraint values out of the database and the rest out
of the active rule pack. A form therefore cannot offer a value the schema would
reject, and cannot drift when the schema changes. Choices that will *block* the
pathway are still offered and labelled as blocking, because hiding them teaches
the operator nothing about where the gates are. `test/reference.test.ts`
asserts those labels are truthful by submitting every offered value and
checking the engine agrees.

Turning on **Demo shortcuts** adds a one-click button per step with fixed
values, for walking an audience through five refusals without typing dates
while they watch. The forms stay visible underneath. The setting persists per
browser and is off by default.

---

## Evidence grading

Most implementations get this wrong. CPIC's A/B/C/D is an **actionability level** —
whether prescribing should change — and not a level of evidence. CPIC runs four
separately graded dimensions, and this build stores all four separately, never
collapsed into a score:

| Dimension | Values |
|---|---|
| Gene-drug pair actionability | A, B, C, D (and mixed) |
| Prescribing recommendation strength | strong, moderate, optional, none |
| Evidence strength for the findings | high, moderate, weak |
| Allele function assignment strength | high, moderate, weak |

### The fifth dimension

CPIC's grading is global. India's evidence base for these alleles is thin,
geographically skewed, and built on small case series — the principal direct
Indian association study genotyped **eight** patients. Applying a global grade to
an Indian patient without saying so is a quiet overclaim.

| India Evidence Tier | Definition |
|---|---|
| IN-1 | Adequately powered Indian study or meta-analysis with Indian cohorts |
| IN-2 | Small Indian case series or case-control data (fewer than 50 cases) |
| IN-3 | South Asian or diaspora data only |
| IN-4 | Extrapolated from non-Indian populations; no direct Indian evidence |
| IN-0 | Indian data actively conflicting, or absent |

HLA-B\*15:02 with carbamazepine in India sits at **IN-2**. Every advisory prints
the tier with its one-line definition. A clinician reading IN-2 knows what they
are holding; a clinician reading an unqualified "Level A" does not.

**The registry exists to move pairs from IN-2 toward IN-1.** That is also the
funding argument: the system does not merely apply evidence, it generates it.

---

## The ethics fix is a schema, not a policy

There is **no relatives table**. No names, no phone numbers, no contact attempts,
no inferred genotypes. What exists is `advisory_recipient_summary`: a relationship
type and a count. "Two siblings, one parent."

A relative who decides to act walks into a clinic, becomes their own index case
with their own consent, and is linked back only by an opaque token the index
patient chose to hand them. **The system never holds the link. The family does.**

When someone asks how non-consenting relatives are protected, the answer is not a
policy document:

```
✔ the schema holds no relatives table, by construction
✔ the recipient summary holds counts, and has nowhere to put a name
```

---

## Safety wording

Section 6 is built as **validation, not guidance** — guidance is advice a tired
person at 2am can skip. The linter refuses to render a document containing a
banned construction, and refuses to render one missing a mandatory clause.

Banned: "cleared", "clearance", "safe", "no risk", "will develop", "danger card",
"genetic defect", "mutation" in patient-facing text, "confirmed carrier" about an
untested relative, "recommended laboratory", tracked links, "the system
recommends".

Mandatory in every advisory: the addressee, genotype provenance, rule provenance,
the India Evidence Tier with its definition, the signatory, the non-determinism
clause, the alternatives caution, the familial probability stated correctly, the
right not to know, and a declaration of financial interests.

Banned constructions carry negation exemptions, because the mandatory clauses
necessarily contain them: *"does not mean this person will experience a severe
reaction"* must be allowed while *"will experience a severe reaction"* is refused.
`BAN_CLEARED` has no exemption — there is no safe way to print that word. It bit
during this build: the demonstration banner read "not regulatory-cleared" and the
linter refused the whole document. The rule was right.

---

## Tests

240 tests, weighted deliberately toward the refusals.

```
test/engine.test.ts          75  the gates, the fail-closed invariants, the negative pathway
test/linter.test.ts          43  banned constructions, negation exemptions, both registers
test/signoff.test.ts         23  an advisory cannot reach "issued" unsigned, by any path
test/api.test.ts             20  HTTP refusals, CDS Hooks cards and silences
test/rls.test.ts             19  cross-organisation isolation against real PostgreSQL
test/registry.test.ts        17  consent, de-identification, small-cell suppression
test/pdf.test.ts             13  structural validity, or refusal
test/wording-hygiene.test.ts  7  the system's own strings obey its own wording rules
test/portability.test.ts      7  a clean clone can build its own database and run
test/reference.test.ts       16  the forms cannot offer a value the schema would reject
```

---

## Read next

- **`docs/CORRECTIONS.md`** — where this build departs from the specification and
  why. Includes two safety defects in the specified design and three clinical
  content errors. Read it first if you wrote the blueprint.
- **`docs/VERIFICATION.md`** — which citations were checked, how, and what
  remains unverified. The unverified section is the important one.
- **`docs/GOVERNANCE.md`** — regulatory position, data protection, clinical and
  study governance, licensing, and the honest limits.

---

## The innovation statement

**We do not screen populations. We start from a confirmed carrier.** Universal
HLA-B\*15:02 screening needs hundreds of tests to prevent one case and is not
cost-effective at India's allele frequency. Starting from a genotype-confirmed
index case raises each first-degree relative's prior from roughly 5% to roughly
50% — about a tenfold enrichment — and applies to pharmacogenomics the cascade
logic already standard of care in familial hypercholesterolaemia and Lynch
syndrome.

**We grade evidence for India, not for the world.** CPIC's A-to-D scale is an
actionability level, not an evidence level, a distinction most implementations
miss. We carry all four graded dimensions separately and add a fifth that states
plainly when a recommendation rests on small, geographically skewed Indian data.
Every advisory prints it. The registry exists to improve it.

**We built a system whose primary skill is refusing to act.** No confirmed
genotype, no cascade. No causality assessment, no cascade. Stale rule pack, no
output. No clinician signature, nothing prints. In a field rushing to make
software decide more, we made software that decides less and documents why.

The moat is not the code. It is the accumulating Indian pharmacogenomic registry,
which does not currently exist, which every case deepens, and which no competitor
can start from scratch.
