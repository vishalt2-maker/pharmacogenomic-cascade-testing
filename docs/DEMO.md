# Demonstration script

Ninety seconds of context, then show the system refusing before you show it
working. Restraint is what a clinical audience remembers.

## Setup

```bash
npm run setup && npm run serve
```

Open `http://localhost:8787`. Acting as **S. Iyer**, clinical pharmacist, Pune.

**Turn on "Demo shortcuts" in the header.** The screen is a data-entry
interface by default, with a form for each step. The shortcuts add a one-click
button per step so you can walk the pathway at talking speed. The forms stay
visible underneath, which is the point: a reviewer who asks "so where does the
actual drug name go?" gets to see the answer without you leaving the flow.

## The ninety seconds

> Stevens-Johnson Syndrome and Toxic Epidermal Necrolysis are among the few
> adverse drug reactions that kill otherwise healthy people. Carbamazepine and
> phenytoin are two of the most widely used antiseizure drugs in India — cheap,
> off-patent, on the essential medicines list.
>
> The protection exists. HLA-B\*15:02 is one of the strongest drug-gene
> associations in medicine, and the guidance is unambiguous: in a carrier, use
> something else.
>
> But the arithmetic of universal screening doesn't work here. Hong Kong data:
> 442 tests to prevent one case, and that's in a population with a much higher
> allele frequency than India's. A Malaysian analysis found universal screening
> more costly *and* less effective than doing nothing different.
>
> So the intervention that works is the one India can least afford to deploy, and
> people keep dying at a rate nobody sees.
>
> Cascade testing changes the arithmetic. Stop screening populations. Start from
> someone already proven to carry it. Each first-degree relative goes from a few
> per cent to roughly fifty. Tenfold enrichment. It's already standard of care in
> familial hypercholesterolaemia and Lynch syndrome — nobody has wired it up for
> pharmacogenomics, and nobody has wired it to a pharmacovigilance system that
> India already runs.

## The demonstration — refusals first

Click **Run the demonstration sequence**.

**1. Blocked at gate 3.** Causality not assessed.

> A report is not a confirmed index case. Cascade testing starts from a confirmed
> carrier, so the pathway will not start from a maybe.

Click **Assess WHO-UMC causality → probable**.

**2. Blocked at gate 4.** Consent missing.

> Consent is recorded separately for each purpose. Genotyping, advisory,
> counselling, registry. Never one blanket flag, because these are four different
> things to agree to.

Click **Record consent**.

**3. Blocked at gate 5.** ← **This is the one.**

> Every gate before it passed. The drug is in scope, the reaction is in scope,
> causality is probable, consent is active. And the system produces nothing,
> because there is no confirmed genotype.
>
> No confirmed genotype, no family link. No family link, nothing to cascade from.
> This is the gate that makes the arithmetic work, and it's the gate that makes
> the system safe.

Let that sit. Then order the genotype, and enter a carrier result.

**4. Blocked again.** Entered but not verified — and the verify button is
disabled for the person who entered it.

> Two people, always. A transcription error in a genotype can route a carrier
> straight back onto the drug that nearly killed them. That's a database
> constraint, not a policy.

Switch the user to **Dr A. Narayanan** and verify.

**5. ADVISORY DRAFT.** All gates green, gate 8 marked as outside the engine.

> That's the best output this engine can ever produce. A draft. Gate 8 is a named
> clinician, and it happens outside the engine on purpose.

## Then show it working

Click **Create draft advisory**, then **Try to issue without signing**.

> Refused by a database trigger, on both the insert and the update path. Not by
> application code that a future refactor can delete.

Sign, then issue. Open the clinical advisory PDF and the patient sheet.

Point at three things:

1. **India Evidence Tier IN-2**, printed with its definition. CPIC's A-to-D is an
   *actionability* level, not an evidence level — most implementations conflate
   them. We carry all four of CPIC's dimensions separately and add a fifth for
   India, because the direct Indian evidence here is eight patients.
2. **The alternatives, each with its own caution.** Oxcarbazepine carries the same
   recommendation. Lamotrigine does not — the evidence is very limited, and saying
   otherwise would push a prescriber away from an option this patient may need.
3. **The financial interests declaration.** No commission, no tracked links. The
   linter refuses to render a document containing "recommended laboratory".

Set the patient's language to Hindi and open the patient sheet.

> Two documents, never one. The prescriber gets star alleles and a citation. The
> patient gets plain language in their own language. Never make the patient read
> the clinical document.

## The three closing beats

**Switch user to Dr K. Pillai, Kochi.** The case disappears.

> Row-level security in PostgreSQL. The query runs; it returns nothing.

**Open the Registry tab.** Point at the withheld cells.

> De-identified, consented, and suppressed below five. In a population with an
> allele frequency of two per cent, a count of one in a named state and month is a
> person.
>
> And this is the durable asset. There is no Indian pharmacogenomic SCAR registry.
> Every case deepens it, and no competitor can start from scratch.

**Point at "blocks by reason".**

> This is the most valuable operational data the system produces. It's where the
> pathway actually breaks, and it's the pilot metric. We also predict, in advance,
> that carrier yield in tested relatives comes back near fifty per cent. If it
> comes back at population baseline, the thesis is wrong. We wrote the prediction
> into the API so it can't be quietly dropped.

## If asked "can it take real data?"

Switch the toggle off and scroll to the forms. Point at the suspect drug field.

> Free text, because a real reaction can be to any drug. It resolves brand
> names against the rule pack, so Eptoin finds phenytoin. A drug we do not
> cover simply falls out of scope at gate 1 and produces nothing, which is a
> different thing from an error.

Then point at the reaction type and accreditation dropdowns.

> Every option there is read out of the database schema at request time, so the
> form cannot offer something the database would reject. And the ones that will
> block the pathway are still listed, labelled as blocking. You should be able
> to see where the gate is before you hit it.

## If asked "is it AI?"

> Deliberately not. The engine is deterministic rules. No model, no inference, no
> probability we invented. Every number on that document is either a laboratory
> result or a published figure from a cited source. In a safety pathway, a tool
> that produces nothing is safe and a tool that guesses is a hazard.

## If asked "what's your evidence level?"

> Which of the four do you mean? Actionability, recommendation strength, evidence
> strength for the findings, or allele function assignment? They're graded
> separately and we store them separately. And we add a fifth for India, because
> the global grade doesn't describe what we actually know about Indian patients.

## Do not oversell

The limits are in `docs/GOVERNANCE.md` §7 and they are worth saying first: volume
is low, a relative only benefits if later prescribed an aromatic anticonvulsant,
and a negative result does not eliminate risk. Nothing here is validated or
approved by any regulator, and the rule pack is demonstration content.
