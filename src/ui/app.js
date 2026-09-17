/**
 * Mock AMC entry screen.
 *
 * Vanilla ES modules, no framework and no build step. The screen's job is to
 * make the gate ladder legible: a clinician should be able to see, at a
 * glance, exactly which gate stopped a case and what would unblock it.
 */

let state = {
  user: null,
  users: [],
  cases: [],
  selected: null,
  detail: null,
  evaluation: null,
  reasonCodes: [],
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    // A boolean attribute is present or absent; setAttribute('disabled', false)
    // sets the string "false", which disables the control. Skip false outright.
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, bad ? 7000 : 3500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(state.user ? { 'x-pct-user': state.user.id } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.detail ?? data?.error ?? `HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function boot() {
  state.users = await api('/api/demo/users');
  const sel = $('#user-select');
  sel.replaceChildren(...state.users.map((u) =>
    el('option', { value: u.id },
      `${u.full_name} — ${u.role.replace(/_/g, ' ')}${u.can_sign ? ' ✓ may sign' : ''} · ${u.org_name.replace(/^Demo /, '')}`)));
  state.user = state.users[0];
  sel.value = state.user.id;
  sel.addEventListener('change', async () => {
    state.user = state.users.find((u) => u.id === sel.value);
    await refreshCases();
    if (state.selected) await openCase(state.selected);
    toast(`Acting as ${state.user.full_name}. Row-level security scopes everything to ${state.user.org_name}.`);
  });

  state.reasonCodes = await api('/api/reason-codes');
  await Promise.all([refreshPackStatus(), refreshCases()]);

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view').forEach((v) =>
        v.classList.toggle('active', v.id === `view-${tab.dataset.view}`));
      if (tab.dataset.view === 'registry') loadRegistry();
      if (tab.dataset.view === 'knowledge') loadKnowledge();
      if (tab.dataset.view === 'codes') loadCodes();
    });
  });

  $('#new-case-form').addEventListener('submit', onCreateCase);
  $('#btn-demo').addEventListener('click', runDemoSequence);
  $('#btn-export').addEventListener('click', () => runExport(true));
  $('#btn-export-commit').addEventListener('click', () => runExport(false));

  const requested = new URLSearchParams(location.search).get('case');
  if (requested) await openCase(requested);
}

async function refreshPackStatus() {
  const h = await api('/api/health');
  const node = $('#pack-status');
  if (!h.rulePack) {
    node.className = 'pack-status bad';
    node.textContent = 'No rule pack — the engine will block everything';
    return;
  }
  const days = Math.floor((new Date(h.rulePack.expiresAt) - Date.now()) / 86400000);
  const integrity = h.rulePack.integrity.ok;
  node.className = `pack-status ${!integrity ? 'bad' : days < 30 ? '' : 'ok'}`;
  node.textContent = !integrity
    ? `Rule pack ${h.rulePack.version} FAILS its hash check`
    : `Rule pack ${h.rulePack.version} · ${h.rulePack.provenanceStatus.replace(/_/g, ' ')} · expires in ${days} d`;
  node.title = `Content hash verified: ${integrity}. Expiry is enforced by gate G0, not advisory.`;
}

// ---------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------
async function refreshCases() {
  state.cases = await api('/api/cases');
  const list = $('#case-list');
  if (state.cases.length === 0) {
    list.replaceChildren(el('p', { class: 'hint' },
      'No cases at this organisation yet.'));
    return;
  }
  list.replaceChildren(...state.cases.map((c) => {
    const decision = c.last_decision ?? 'not evaluated';
    const cls = decision === 'BLOCK' ? 'block'
      : decision === 'ADVISORY_DRAFT' ? 'draft'
      : decision === 'not evaluated' ? 'none' : 'warn';
    return el('button', {
      class: `case-row${state.selected === c.id ? ' selected' : ''}`,
      onclick: () => openCase(c.id),
    },
      el('div', { class: 'who' },
        `${c.suspect_drug ?? 'no drug logged'} · ${c.reaction_type ?? '—'}`),
      el('div', { class: 'meta' },
        `b. ${c.year_of_birth ?? '—'} · ${c.state ?? '—'} · `,
        el('span', { class: `badge ${cls}` }, decision.replace(/_/g, ' '))));
  }));
}

async function onCreateCase(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    const created = await api('/api/cases', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    ev.target.reset();
    await refreshCases();
    await openCase(created.id);
    toast('Index case created. The record number is stored as a keyed digest, never in plain text.');
  } catch (e) { toast(e.message, true); }
}

async function openCase(id) {
  state.selected = id;
  try {
    state.detail = await api(`/api/cases/${id}`);
  } catch (e) {
    toast(e.status === 404
      ? 'Not visible from this organisation. That is row-level security doing its job.'
      : e.message, true);
    state.detail = null;
    renderCaseDetail();
    return;
  }
  await evaluateCase(false);
  await refreshCases();
}

async function evaluateCase(announce = true) {
  if (!state.selected) return;
  try {
    const out = await api(`/api/cases/${state.selected}/evaluate`, { method: 'POST', body: '{}' });
    state.evaluation = out.result;
    if (announce) toast(`Engine returned ${out.result.decision}. Every evaluation is recorded, blocks included.`);
  } catch (e) {
    state.evaluation = null;
    toast(e.message, true);
  }
  renderCaseDetail();
}

const GATE_NAMES = {
  G0: 'Rule pack valid, active and unexpired',
  G1: 'Suspect drug in a gene-drug pair in cascade scope',
  G2: 'Reaction is a severe cutaneous reaction in scope',
  G3: 'WHO-UMC causality is probable or certain',
  G4: 'Active consent for genotyping and advisory issue',
  G5: 'Confirmed genotype from an accredited laboratory',
  G6: 'Exactly one recommendation resolves',
  G7: 'Gene-drug pair meets the actionability threshold',
  G8: 'Named clinician review and sign-off',
};

function renderLadder(trace) {
  const seen = new Map(trace.map((t) => [t.gate, t]));
  const ladder = el('div', { class: 'ladder' });
  for (const gid of ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']) {
    const t = seen.get(gid);
    const status = t ? t.status : 'pending';
    const mark = { pass: '✓', fail: '✕', skipped: '–', pending: '·' }[status];
    const detail = t && Object.keys(t.detail ?? {}).length
      ? Object.entries(t.detail)
          .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.length}]` : v}`).join('  ')
      : (status === 'pending' ? 'not reached' : '');
    ladder.append(el('div', { class: `gate ${status}` },
      el('div', { class: 'gid' }, gid),
      el('div', {},
        el('div', { class: 'gname' }, GATE_NAMES[gid]),
        detail ? el('div', { class: 'gdetail' }, detail) : null,
        t && t.reasonCodes.length
          ? el('div', { class: 'gdetail' }, t.reasonCodes.join(', ')) : null),
      el('div', { class: 'gmark' }, mark)));
  }
  return ladder;
}

function reasonDef(code) {
  return state.reasonCodes.find((r) => r.code === code)
    ?? { code, message: code, gate: '—' };
}

function renderCaseDetail() {
  const host = $('#case-detail');
  if (!state.detail) {
    host.className = 'empty-state';
    host.replaceChildren(el('p', {}, 'Nothing to show for this case in this organisation.'));
    return;
  }
  host.className = '';
  const d = state.detail;
  const c = d.case;
  const ev = state.evaluation;
  const latestAdr = d.adrEvents[0];
  const latestResult = d.genotypeResults[0];
  const latestOrder = d.genotypeOrders[0];
  const advisory = d.advisories[0];
  const canSign = state.user?.can_sign;

  const nodes = [];

  nodes.push(el('h2', {}, `Index case · ${c.state ?? '—'} · b. ${c.year_of_birth ?? '—'}`));
  nodes.push(el('dl', { class: 'kv' },
    el('dt', {}, 'Suspect drug'), el('dd', {}, latestAdr?.suspect_drug ?? 'not logged'),
    el('dt', {}, 'Reaction'), el('dd', {}, latestAdr?.reaction_type ?? '—'),
    el('dt', {}, 'WHO-UMC causality'), el('dd', {}, latestAdr?.causality_who_umc ?? 'not assessed'),
    el('dt', {}, 'Genotype'), el('dd', {},
      latestResult ? `${latestResult.gene_symbol} ${latestResult.diplotype} (${latestResult.lab_accreditation}, ${latestResult.verified_by ? 'verified' : 'NOT VERIFIED'})` : 'none received'),
    el('dt', {}, 'Consents'), el('dd', {},
      d.consents.filter((k) => k.granted && !k.withdrawn_at).map((k) => k.purpose).join(', ') || 'none'),
    el('dt', {}, 'Family link token'), el('dd', { class: 'mono' }, c.family_link_token)));

  nodes.push(el('p', { class: 'section-note' },
    'The family link token is given to the patient, not used by the system. A relative may present it, or not. Nothing here records who they are.'));

  // ---- decision + ladder ----
  if (ev) {
    nodes.push(el('div', { class: `decision ${ev.decision}` },
      el('span', { class: 'big' }, ev.decision.replace(/_/g, ' ')),
      el('span', {}, ev.decision === 'ADVISORY_DRAFT'
        ? 'A draft may be created. Nothing prints until a named clinician signs.'
        : ev.decision === 'BLOCK' ? 'Nothing is produced and nothing is sent.'
        : ev.decision === 'NO_ACTION' ? 'Out of scope, or a negative result. No document.'
        : 'Information only. No familial advisory is produced.')));

    if (ev.reasonCodes.length) {
      nodes.push(el('ul', { class: 'reasons' }, ev.reasonCodes.map((code) => {
        const r = reasonDef(code);
        return el('li', {},
          el('span', { class: 'rc' }, `${code} (${r.gate}) `), r.message,
          r.remedy ? el('span', { class: 'remedy' }, r.remedy) : null);
      })));
    }
    if (ev.warnings.length) {
      nodes.push(el('ul', { class: 'reasons warn' }, ev.warnings.map((code) =>
        el('li', {}, el('span', { class: 'rc' }, `${code} `), reasonDef(code).message))));
    }
    nodes.push(renderLadder(ev.gateTrace));
  }

  // ---- actions, in pathway order ----
  const steps = el('div', { class: 'steps' });
  const missingConsent = ['genotyping', 'advisory_issue', 'counselling', 'registry_deidentified']
    .filter((p) => !d.consents.some((k) => k.purpose === p && k.granted && !k.withdrawn_at));

  if (missingConsent.length) {
    steps.append(el('button', {
      onclick: async () => {
        for (const purpose of missingConsent) {
          await api(`/api/cases/${c.id}/consents`, {
            method: 'POST',
            body: JSON.stringify({ purpose, granted: true, language: c.preferred_language ?? 'en',
              documentRef: 'FORM-DEMO-1' }),
          });
        }
        toast(`Consent recorded separately for each purpose: ${missingConsent.join(', ')}. Never a blanket flag.`);
        await openCase(c.id);
      },
    }, `Record consent (${missingConsent.length} outstanding)`));
  }

  if (!latestAdr) {
    steps.append(el('button', {
      onclick: async () => {
        await api(`/api/cases/${c.id}/adr-events`, {
          method: 'POST',
          body: JSON.stringify({ suspectDrug: 'carbamazepine', reactionType: 'SJS',
            onsetDate: '2026-08-15', latencyDays: 21, causalityWhoUmc: 'not_assessed',
            vigiflowRef: 'IN-DEMO-0001' }),
        });
        toast('ADR logged with causality NOT assessed. Watch gate 3 block.');
        await openCase(c.id);
      },
    }, 'Log an ADR (carbamazepine / SJS)'));
  } else if (latestAdr.causality_who_umc === 'not_assessed') {
    steps.append(el('button', {
      onclick: async () => {
        await api(`/api/adr-events/${latestAdr.id}/causality`, {
          method: 'POST', body: JSON.stringify({ causality: 'probable' }),
        });
        toast('WHO-UMC causality assessed as probable. Cascade starts from a confirmed index case.');
        await openCase(c.id);
      },
    }, 'Assess WHO-UMC causality → probable'));
  }

  if (latestAdr && !latestOrder) {
    steps.append(el('button', {
      onclick: async () => {
        await api(`/api/cases/${c.id}/genotype-orders`, {
          method: 'POST',
          body: JSON.stringify({ adrEventId: latestAdr.id, geneSymbol: 'HLA-B',
            labName: 'Demo Genomics Laboratory', labAccreditation: 'NABL' }),
        });
        toast('Genotype ordered. Until a result arrives, gate 5 blocks. That is the differentiator.');
        await openCase(c.id);
      },
    }, 'Order HLA-B genotype'));
  }

  if (latestOrder && !latestResult) {
    for (const [label, diplotype] of [
      ['Enter result: *15:02/*40:06 (carrier)', '*15:02/*40:06'],
      ['Enter result: *40:06/*44:03 (non-carrier)', '*40:06/*44:03'],
      ['Enter result: *15:11/*40:06 (unrecognised)', '*15:11/*40:06'],
    ]) {
      steps.append(el('button', {
        onclick: async () => {
          await api(`/api/genotype-orders/${latestOrder.id}/results`, {
            method: 'POST',
            body: JSON.stringify({
              indexCaseId: c.id, geneSymbol: 'HLA-B', diplotype, method: 'PCR-SSP',
              labName: 'Demo Genomics Laboratory', labAccreditation: 'NABL',
              reportRef: `LAB-DEMO-${Math.floor(Math.random() * 90000 + 10000)}`,
              resultedAt: new Date(Date.now() - 86400000).toISOString(),
            }),
          });
          toast('Result entered. It still needs a SECOND user to verify it.');
          await openCase(c.id);
        },
      }, label));
    }
  }

  if (latestResult && !latestResult.verified_by) {
    const isEnterer = latestResult.entered_by === state.user?.id;
    steps.append(el('button', {
      disabled: isEnterer,
      title: isEnterer
        ? 'You entered this result. A second user must verify it: a transcription error in a genotype is a catastrophic failure mode.'
        : '',
      onclick: async () => {
        try {
          await api(`/api/genotype-results/${latestResult.id}/verify`, { method: 'POST', body: '{}' });
          toast('Verified by a second user.');
          await openCase(c.id);
        } catch (e) { toast(e.message, true); }
      },
    }, isEnterer ? 'Verify (blocked: you entered this)' : 'Verify genotype (second person)'));
  }

  if (ev?.decision === 'ADVISORY_DRAFT' && !advisory) {
    steps.append(el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          await api('/api/advisories', {
            method: 'POST',
            body: JSON.stringify({ indexCaseId: c.id,
              recipientSummary: [{ relationshipType: 'sibling', count: 2 },
                                 { relationshipType: 'parent', count: 1 }] }),
          });
          toast('Draft created. Relatives are recorded as a type and a count. No names, anywhere.');
          await openCase(c.id);
        } catch (e) { toast(e.message, true); }
      },
    }, 'Create draft advisory'));
  }

  if (advisory && advisory.status === 'draft') {
    steps.append(el('button', {
      class: 'primary', disabled: !canSign,
      title: canSign ? '' : `${state.user.full_name} is not a registered clinician who may sign. The database policy refuses it, not the screen.`,
      onclick: async () => {
        try {
          await api(`/api/advisories/${advisory.id}/sign`, { method: 'POST', body: '{}' });
          toast('Signed. The document was re-rendered under the signing clinician’s own name.');
          await openCase(c.id);
        } catch (e) { toast(e.message, true); }
      },
    }, canSign ? 'Review and sign' : 'Sign (not permitted for this role)'));

    steps.append(el('button', {
      onclick: async () => {
        try {
          await api(`/api/advisories/${advisory.id}/issue`, { method: 'POST', body: '{}' });
        } catch (e) {
          toast(`Refused by the database trigger: ${e.data?.error ?? e.message}. An advisory cannot reach "issued" unsigned.`, true);
        }
      },
    }, 'Try to issue without signing'));
  }

  if (advisory && advisory.status === 'signed') {
    steps.append(el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          await api(`/api/advisories/${advisory.id}/issue`, { method: 'POST', body: '{}' });
          toast('Issued to the index patient. They decide whether to share it.');
          await openCase(c.id);
        } catch (e) { toast(e.message, true); }
      },
    }, 'Issue to the index patient'));
  }

  if (steps.children.length) nodes.push(steps);

  // ---- documents ----
  if (advisory && advisory.status !== 'draft') {
    nodes.push(el('h3', {}, `Documents · ${advisory.status}`));
    nodes.push(el('p', { class: 'hint' },
      `Signed by ${advisory.signed_by_name ?? '—'} (${advisory.registration_no ?? '—'}). ` +
      `India Evidence Tier ${advisory.india_evidence_tier}. Rule pack ${advisory.rule_pack_version}. ` +
      `Content hash ${String(advisory.content_hash).slice(0, 16)}…`));
    const docs = el('div', { class: 'docs' });
    for (const [label, file] of [
      ['Clinical advisory (HTML)', 'clinical.html'],
      ['Clinical advisory (PDF)', 'clinical.pdf'],
      ['Patient sheet (HTML)', 'patient.html'],
      ['Patient sheet (PDF)', 'patient.pdf'],
    ]) {
      docs.append(el('button', {
        onclick: async () => {
          const url = `/api/advisories/${advisory.id}/${file}`;
          const res = await fetch(url, { headers: { 'x-pct-user': state.user.id } });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            toast(`${j.error ?? res.status}: ${j.detail ?? ''}`, true);
            return;
          }
          const blob = await res.blob();
          window.open(URL.createObjectURL(blob), '_blank');
        },
      }, label));
    }
    nodes.push(docs);
    nodes.push(el('p', { class: 'section-note' },
      'The patient sheet in a non-Latin script has no PDF: the built-in fonts cannot represent it, so the writer refuses rather than emitting a corrupted document. The HTML rendering is correct.'));
  }

  host.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------
// The demonstration sequence: refusal first
// ---------------------------------------------------------------------
async function runDemoSequence() {
  try {
    toast('Creating a case with no consent, no causality and no genotype…');
    const created = await api('/api/cases', {
      method: 'POST',
      body: JSON.stringify({ mrn: `MRN-DEMO-${Date.now().toString().slice(-6)}`,
        yearOfBirth: 1991, sex: 'F', state: 'Maharashtra', preferredLanguage: 'en' }),
    });
    await api(`/api/cases/${created.id}/adr-events`, {
      method: 'POST',
      body: JSON.stringify({ suspectDrug: 'carbamazepine', reactionType: 'SJS',
        onsetDate: '2026-08-15', latencyDays: 21, causalityWhoUmc: 'not_assessed',
        vigiflowRef: 'IN-DEMO-0001' }),
    });
    await refreshCases();
    await openCase(created.id);
    toast('Blocked at gate 3: causality not assessed. Work down the actions on the right and watch each gate open in turn. Gate 5 is the one that matters.');
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------
async function runExport(dryRun) {
  try {
    const out = await api('/api/registry/export', {
      method: 'POST',
      body: JSON.stringify({ dryRun, suppressionThreshold: Number($('#threshold').value) }),
    });
    toast(`${dryRun ? 'Dry run' : 'Exported'}: ${out.rowsExported} of ${out.rowsConsidered} rows. ${out.rowsWithheldNoConsent} withheld for want of consent.`);
    await loadRegistry();
  } catch (e) { toast(e.message, true); }
}

async function loadRegistry() {
  const threshold = Number($('#threshold').value) || 5;
  try {
    const [agg, endpoints] = await Promise.all([
      api(`/api/registry/aggregate?groupBy=state,suspect_drug,phenotype&threshold=${threshold}`),
      api(`/api/registry/endpoints?threshold=${threshold}`),
    ]);

    const table = el('table', {},
      el('thead', {}, el('tr', {},
        ...agg.groupedBy.map((g) => el('th', {}, g.replace(/_/g, ' '))),
        el('th', { class: 'num' }, 'count'))),
      el('tbody', {}, agg.cells.map((cell) =>
        el('tr', { class: cell.suppressed ? 'suppressed' : '' },
          ...agg.groupedBy.map((g) => el('td', {}, cell.dimensions[g] ?? '—')),
          el('td', { class: 'num' }, cell.suppressed ? 'withheld' : cell.count)))));

    $('#registry-out').replaceChildren(
      el('p', { class: 'hint' },
        `${agg.cells.length} cells, of which ${agg.cellsSuppressed} withheld at a threshold of ${agg.threshold}.`),
      table);

    const e = endpoints;
    const pct = (v) => v === null ? 'withheld (denominator too small)' : `${(v * 100).toFixed(1)}%`;
    $('#endpoints-out').replaceChildren(
      el('table', {}, el('tbody', {},
        el('tr', {}, el('th', {}, 'Index cases evaluated'), el('td', { class: 'num' }, e.indexCasesEvaluated)),
        el('tr', {}, el('th', {}, 'Index genotyping rate'), el('td', { class: 'num' }, pct(e.indexGenotypingRate))),
        el('tr', {}, el('th', {}, 'Advisories issued'), el('td', { class: 'num' }, e.advisoriesIssued)),
        el('tr', {}, el('th', {}, 'Relatives informed (aggregate)'), el('td', { class: 'num' }, e.relativesInformed)),
        el('tr', {}, el('th', {}, 'Relative testing uptake'), el('td', { class: 'num' }, pct(e.relativeUptakeRate))),
        el('tr', {}, el('th', {}, 'Carrier yield in tested relatives'), el('td', { class: 'num' }, pct(e.carrierYieldInTestedRelatives))),
        el('tr', {}, el('th', {}, 'Predicted carrier yield'), el('td', { class: 'num' }, pct(e.predictedCarrierYield))))),
      el('h3', {}, 'Blocks by reason'),
      el('p', { class: 'hint' },
        'Where the pathway actually breaks. This is the most valuable operational data the system produces.'),
      el('table', {}, el('tbody', {}, e.blocksByReason.map((b) =>
        el('tr', {}, el('th', {}, b.reason), el('td', { class: 'num' }, b.n))))));
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------
// Knowledge and codes
// ---------------------------------------------------------------------
async function loadKnowledge() {
  const [packs, figures] = await Promise.all([api('/api/rule-packs'), api('/api/figures')]);
  const p = packs.packs[0];
  $('#pack-out').replaceChildren(
    el('dl', { class: 'kv' },
      el('dt', {}, 'Version'), el('dd', {}, p.version),
      el('dt', {}, 'Provenance'), el('dd', {}, p.provenance_status.replace(/_/g, ' ')),
      el('dt', {}, 'Effective'), el('dd', {}, String(p.effective_from).slice(0, 10)),
      el('dt', {}, 'Expires'), el('dd', {},
        `${String(p.expires_at).slice(0, 10)} — enforced by gate G0, not advisory`),
      el('dt', {}, 'Content hash'), el('dd', { class: 'mono' }, p.content_hash),
      el('dt', {}, 'Integrity'), el('dd', {},
        packs.integrity.ok ? 'recomputed and matching' : 'MISMATCH — the engine will block'),
      el('dt', {}, 'Citations'), el('dd', {},
        `${packs.citations.verified} of ${packs.citations.total} checked against a primary bibliographic record`,
        el('div', { class: 'hint' },
          'A machine check against the source record. Not the same as a human curator having read the paper, which is why this pack is still marked demonstration.'))),
    el('p', { class: 'section-note' }, p.notes ?? ''));

  $('#figures-out').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Figure'), el('th', {}, 'Value'), el('th', {}, 'Source'))),
    el('tbody', {}, figures.figures.map((f) =>
      el('tr', {},
        el('td', {}, f.label),
        el('td', {}, f.value),
        el('td', {},
          f.sourceUrl ? el('a', { href: f.sourceUrl, target: '_blank', rel: 'noopener' }, f.source) : f.source,
          f.caveat ? el('div', { class: 'hint' }, f.caveat) : null))))));
}

async function loadCodes() {
  const codes = state.reasonCodes;
  const bySeverity = { block: [], no_action: [], inform: [], warning: [] };
  for (const c of codes) (bySeverity[c.severity] ??= []).push(c);
  const sections = Object.entries(bySeverity).map(([sev, list]) =>
    el('div', {},
      el('h3', {}, `${sev.replace(/_/g, ' ')} — ${list.length}`),
      el('table', {}, el('tbody', {}, list.map((c) =>
        el('tr', {},
          el('th', {}, el('span', { class: 'mono' }, c.code), ` (${c.gate})`),
          el('td', {}, c.message,
            c.remedy ? el('div', { class: 'hint' }, c.remedy) : null)))))));
  $('#codes-out').replaceChildren(...sections);
}

boot().catch((e) => toast(`Startup failed: ${e.message}`, true));
