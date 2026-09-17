# Governance

Nothing in this build is deployed, validated, or approved by any regulator. This
file records the position the build takes and what must be settled before a
single real patient row exists.

---

## 1. Licensing — settle this before writing more code

Three different licences apply to the upstream content, and they are not
interchangeable. These were read through a rendering proxy rather than directly
(see `docs/VERIFICATION.md`), so **confirm them in a real browser and get the
answer in writing before shipping anything commercially.**

| Resource | Licence as found |
|---|---|
| CPIC curated content | CC0 1.0 Universal Public Domain Dedication |
| ClinPGx / PharmGKB data | CC BY-SA 4.0 |
| PharmVar database content | CC BY-SA 4.0 |
| PharmCAT software | Mozilla Public License 2.0 |

**The ShareAlike term is viral.** Redistributing an adapted version of
ClinPGx/PharmGKB or PharmVar data obliges you to license the adaptation under the
same terms. CPIC guideline content under CC0 carries no such obligation. If a
product mixes them, the CC BY-SA obligations govern the mixed portion — which, in
a commercial clinical product, is a business-model question and not a footnote.

**What this build does about it:** recommendation text in the rule pack is
*paraphrased*, never copied. That reduces exposure; it does not eliminate the
question. Write to `feedback@clinpgx.org`, get the position in writing, and keep
it in the regulatory file.

---

## 2. Regulatory position

**Assume you are a regulated device and be pleasantly surprised if not.**

CDSCO's guidance on Medical Device Software applies the existing Class A–D
framework under the Medical Devices Rules 2017. There is no separate software
regime. Standalone software is classified by the significance of the information
to the healthcare decision and the seriousness of the healthcare situation, and
where multiple rules apply the higher class governs.

SJS/TEN is serious and drug-avoidance guidance is significant. **Plan for Class B
or C.**

What that brings: an intended use statement, a classification request through the
CDSCO online portal where the software is not on a published list, a quality
management system, ISO 14971 risk management, IEC 62304 software lifecycle,
IEC 62366 usability, clinical performance evidence, post-market surveillance,
and an Algorithm Change Protocol if a learning component is ever added.

### The intended use statement is pivotal

A deliberate lower-risk scoping option exists: write the intended use as a
**documentation and counselling aid that reproduces published guidance under
mandatory named-clinician sign-off**. That is a legitimate position and this
build is architected to support it — the engine's best possible output is a
draft, and nothing leaves the system unsigned.

**Choose it on purpose and write it down. Do not drift into being a device by
accident.** The moment the software starts selecting between alternatives, or
presenting a probability it computed, that position is gone.

### What in this build supports the lower-risk reading

- The safety engine is deterministic. No model, no inference, no probability the
  system invented.
- Every number in an advisory is a laboratory result or a published figure
  carried through from a cited source.
- No output is produced without a named, registered clinician's signature,
  enforced by a database trigger.
- The system never selects a drug. It reproduces what the guidance says about the
  alternatives, including their cautions, and prints that drug selection remains
  the prescriber's decision.

---

## 3. Data protection

- **DPDPA 2023 governs processing, not only transmission.** Running locally
  reduces breach surface; it grants no exemption.
- The DPDP Rules 2025 were notified with obligations phased over the following
  period. Check the current phase before relying on any transition.
- **The hospital is Data Fiduciary. This system is Data Processor**, engaged
  under contract. The Act puts the compliance burden on the Fiduciary to bind its
  processors. **Get the Data Processing Agreement signed before a single patient
  row exists.** `clinical.organizations.dpa_signed_at` exists so that this is
  visible in the data rather than in a filing cabinet.
- Consent is the primary lawful ground, with a narrow set of Section 7 legitimate
  uses. There is **no GDPR-style "legitimate interests" fallback**.
- A platform's SOC 2, ISO 27001 or HIPAA certifications are **platform controls,
  not Indian compliance**. Under the shared responsibility model the schema, the
  RLS policies, access management and integrations are yours.
- Pin the deployment region at project creation. A project stays in the region
  chosen then, and read replicas are your responsibility to keep in-region.

### What the build does

| Control | Where |
|---|---|
| Consent recorded separately per purpose, with withdrawal honoured at every read | `clinical.consents`, `has_active_consent()` |
| Medical record number never stored in plain text | `src/db/identifiers.ts` — keyed HMAC digest plus AES-256-GCM ciphertext |
| Year of birth, not full date of birth | `clinical.index_cases.year_of_birth` |
| Per-organisation isolation | `db/migrations/005_rls.sql`, tested in `test/rls.test.ts` |
| Append-only audit log holding codes and identifiers only, never clinical prose | `clinical.audit_log`, `src/db/audit.ts` |
| Registry de-identified, consented, small-cell suppressed | `src/registry/export.ts` |

### Key management is not solved

The MRN key is read from an environment variable with a clearly-labelled demo
default. **That is adequate for a concept build and not for deployment.** It
belongs in a managed key service, rotated, with a key version carried in the
ciphertext so old records stay readable across a rotation. The ciphertext format
reserves a version byte for exactly this.

Encryption is done in the application rather than through `pgcrypto` deliberately:
`pgp_sym_encrypt` takes the key as a literal in the statement, which puts it into
query logs, `pg_stat_activity` and any slow-query trace. The database never sees
the key.

---

## 4. Clinical governance

- **Named clinician sign-off on every advisory**, with name and registration
  number printed, enforced by database trigger and RLS policy rather than by
  convention. A counsellor cannot sign. A physician with no registration number
  cannot sign. A clinician cannot sign on another's behalf.
- **WHO-UMC causality assessment is the gate**, consistent with PvPI practice.
  Possible or unlikely is not a confirmed index case and does not proceed.
- **Genetic counselling is a workflow step**, and the record cannot be saved
  without recording that the right not to know was covered — a check constraint,
  not a checkbox.
- **Two-person genotype verification.** A transcription error in a genotype can
  route a carrier back onto the drug that nearly killed them.
- **Rule pack expiry is enforced.** Past expiry the engine blocks with
  `RULE_PACK_STALE`. Suggested window: 180 days, warning from 150.
- **Misattributed parentage protocol — NOT WRITTEN.** This must be agreed with
  your ethics committee **before the first case**. A sharp reviewer will ask, and
  "we'll deal with it when it comes up" is the wrong answer. The architecture
  helps: the system never infers a relationship and holds no record of any
  relative, so it cannot disclose one. That is a mitigation, not a protocol.

---

## 5. Study governance

- Institutional Ethics Committee approval before any prospective work.
- CTRI registration for the pilot.
- **Pre-register the analysis.** Do not let this become a system that can only
  produce confirming results.

Primary endpoints, implemented in `src/registry/export.ts` and served at
`GET /api/registry/endpoints`:

| Endpoint | Meaning |
|---|---|
| Index genotyping rate | Of eligible index cases, how many were actually genotyped |
| Advisory retention | Whether the patient still holds the document at follow-up |
| Relative testing uptake | Of relatives informed, how many presented for testing |
| **Carrier yield in tested relatives** | **The falsifiable prediction: approximately 50%** |

**If carrier yield returns at population baseline rather than near 50%, the
thesis is wrong.** The point of measuring it is to find that out early and
cheaply. The predicted value is stated in the API response alongside the observed
one so that the comparison cannot be quietly dropped.

Rates are suppressed while the denominator is below the threshold, for the same
reason the registry suppresses small cells.

---

## 6. Commercial governance

- **No per-test commission. No tracked links. No referral revenue.** The ethical
  code in force prohibits commission-for-referral arrangements. The wording
  linter enforces this at render time: `BAN_REFERRAL_STEERING` and
  `BAN_TRACKED_LINK` refuse to render a document containing "recommended
  laboratory", "book here", or a URL carrying tracking parameters.
- Revenue: hospital licensing, public health and grant funding, payer pilots.
- **Declare all financial interests on the advisory itself.** This is a mandatory
  clause — a document that omits it does not render. If the honest declaration is
  "none", that is a powerful sentence to be able to print, and this build prints
  it.

---

## 7. The honest limits — say these out loud

From the specification, and worth repeating because they are the most
credibility-generating thing available:

- **Volume is low.** Published estimates suggest only 6–10% of adverse drug
  reactions in Indian settings are reported at all. Cutaneous reactions are a
  minority of those, and severe cutaneous reactions a small fraction again. A
  single centre may yield a handful to a few dozen eligible index cases a year.
- **A relative only benefits if they are later prescribed an aromatic
  anticonvulsant.** Epilepsy clusters in families, which raises this above
  baseline, but it is not high, and it must be modelled rather than asserted.
- **A negative result does not eliminate risk** — and, as `docs/CORRECTIONS.md`
  §B1 sets out, what exactly that means differs between carbamazepine and
  phenytoin. Say the right one.
- **The Indian evidence base is thin.** The principal direct Indian association
  study genotyped eight patients. That is why the India Evidence Tier exists, and
  why the registry is the point of the exercise rather than the software.
