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
  /** Enum members, CHECK values and rule pack contents, for the forms. */
  reference: null,
  /**
   * Demo shortcuts advance the pathway in one click with fixed values. Off
   * by default: the forms are the real interface, and the shortcuts exist so
   * that walking an audience through five refusals does not mean typing
   * dates into a form while they watch.
   */
  demoShortcuts: false,
};

const SHORTCUTS_KEY = 'pct.demoShortcuts';

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
  state.reference = await api('/api/reference');

  try {
    state.demoShortcuts = localStorage.getItem(SHORTCUTS_KEY) === 'on';
  } catch { /* private browsing; the default is fine */ }
  const toggle = $('#demo-toggle');
  toggle.checked = state.demoShortcuts;
  toggle.addEventListener('change', () => {
    state.demoShortcuts = toggle.checked;
    try { localStorage.setItem(SHORTCUTS_KEY, toggle.checked ? 'on' : 'off'); } catch {}
    document.body.classList.toggle('shortcuts-on', state.demoShortcuts);
    renderCaseDetail();
    toast(state.demoShortcuts
      ? 'Demo shortcuts on. One click per step, with fixed values.'
      : 'Demo shortcuts off. Forms only.');
  });
  document.body.classList.toggle('shortcuts-on', state.demoShortcuts);

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

  $('#btn-demo').closest('.empty-state')?.classList.add('has-demo');

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

// ---------------------------------------------------------------------
// Form helpers
//
// Every option a form offers comes from GET /api/reference, which reads
// enum members and CHECK constraint values out of the database and the
// rest out of the active rule pack. A form therefore cannot offer a value
// the schema would reject, and cannot drift when the schema changes.
//
// Choices that will BLOCK the pathway are still offered, and labelled as
// blocking. Hiding them would teach the operator nothing; showing them is
// how someone learns where the gates are before they hit one.
// ---------------------------------------------------------------------

/** Build one labelled field. Returns a node plus a read() accessor. */
function field(spec) {
  const id = `f-${spec.name}-${Math.random().toString(36).slice(2, 8)}`;
  let input;
  let read;

  if (spec.type === 'select') {
    input = el('select', { id, name: spec.name });
    if (spec.placeholder) {
      input.append(el('option', { value: '' }, spec.placeholder));
    }
    for (const opt of spec.options ?? []) {
      const label = opt.note ? `${opt.label ?? opt.value} — ${opt.note}` : (opt.label ?? opt.value);
      input.append(el('option', { value: opt.value }, label));
    }
    if (spec.value !== undefined && spec.value !== null) input.value = spec.value;
    read = () => input.value || null;

  } else if (spec.type === 'checkboxes') {
    input = el('div', { class: 'checkgroup' });
    const boxes = [];
    for (const opt of spec.options ?? []) {
      const box = el('input', {
        type: 'checkbox', value: opt.value,
        ...(opt.mandatory || (spec.value ?? []).includes(opt.value) ? { checked: 'checked' } : {}),
        ...(opt.mandatory ? { 'data-mandatory': 'true' } : {}),
      });
      if (opt.mandatory) {
        // The schema refuses a counselling record without this topic. Nobody
        // should meet that as a constraint violation after typing a form.
        box.addEventListener('click', (e) => { e.preventDefault(); });
      }
      boxes.push(box);
      input.append(el('label', { class: `checkline${opt.mandatory ? ' required' : ''}` },
        box, el('span', {}, opt.label ?? opt.value),
        opt.mandatory ? el('em', {}, ' always recorded') : null));
    }
    read = () => boxes.filter((b) => b.checked).map((b) => b.value);

  } else if (spec.type === 'textarea') {
    input = el('textarea', { id, name: spec.name, rows: spec.rows ?? 3 });
    if (spec.value) input.value = spec.value;
    read = () => input.value.trim() || null;

  } else {
    const listId = spec.suggestions?.length ? `${id}-list` : null;
    input = el('input', {
      id, name: spec.name, type: spec.type ?? 'text',
      ...(spec.placeholder ? { placeholder: spec.placeholder } : {}),
      ...(spec.min !== undefined ? { min: spec.min } : {}),
      ...(spec.max !== undefined ? { max: spec.max } : {}),
      ...(spec.step !== undefined ? { step: spec.step } : {}),
      ...(listId ? { list: listId } : {}),
    });
    if (spec.value !== undefined && spec.value !== null) input.value = spec.value;
    read = () => {
      const v = input.value.trim();
      if (!v) return null;
      return spec.type === 'number' ? Number(v) : v;
    };
    if (listId) {
      const dl = el('datalist', { id: listId });
      for (const s of spec.suggestions) dl.append(el('option', { value: s }));
      input.after?.(dl);
      spec._datalist = dl;
    }
  }

  const node = el('label', { class: `field${spec.wide ? ' wide' : ''}`, for: id },
    el('span', {}, spec.label, spec.required ? el('em', { class: 'req' }, ' required') : null),
    input,
    spec._datalist ?? null,
    spec.hint ? el('small', {}, spec.hint) : null);

  return { node, read, input, spec };
}

/**
 * A single step in the pathway, as a form.
 *
 * Errors are shown INSIDE the form rather than only as a toast, because a
 * gate refusal is information about this specific submission and the
 * operator needs it next to the field that caused it.
 */
function stepForm({ title, hint, fields, submitLabel, onSubmit, note, tone }) {
  const built = fields.map(field);
  const error = el('div', { class: 'form-error', hidden: 'hidden' });
  const button = el('button', { class: 'primary', type: 'submit' }, submitLabel);

  const form = el('form', {
    class: `step-form${tone ? ` ${tone}` : ''}`,
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      const values = {};
      for (const f of built) values[f.spec.name] = f.read();

      const missing = built.filter((f) => f.spec.required &&
        (values[f.spec.name] === null || values[f.spec.name] === ''));
      if (missing.length) {
        error.hidden = false;
        error.textContent = `Required: ${missing.map((f) => f.spec.label).join(', ')}`;
        missing[0].input.focus();
        return;
      }

      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Working…';
      try {
        await onSubmit(values);
      } catch (err) {
        error.hidden = false;
        error.replaceChildren(
          el('strong', {}, err.data?.error ?? 'Refused'),
          el('div', {}, err.message));
      } finally {
        button.disabled = false;
        button.textContent = previous;
      }
    },
  },
    el('h3', {}, title),
    hint ? el('p', { class: 'hint' }, hint) : null,
    el('div', { class: 'field-grid' }, ...built.map((f) => f.node)),
    error,
    el('div', { class: 'form-actions' }, button,
      note ? el('span', { class: 'hint' }, note) : null));

  return form;
}

/** A compact row of one-click demo shortcuts, shown only when the toggle is on. */
function shortcuts(...buttons) {
  const live = buttons.filter(Boolean);
  if (!state.demoShortcuts || live.length === 0) return null;
  return el('div', { class: 'shortcut-bar' },
    el('span', { class: 'shortcut-label' }, 'Demo shortcuts'),
    ...live);
}

function shortcut(label, handler) {
  return el('button', {
    class: 'shortcut', type: 'button',
    onclick: async () => {
      try { await handler(); } catch (e) { toast(e.message, true); }
    },
  }, label);
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
  nodes.push(...renderActions(d, ev));


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
// The pathway, as forms
//
// One form per step, and only the step that is actually next. Showing all
// of them at once would invite an operator to fill in a genotype result
// before consent exists, which the engine would refuse anyway, less
// helpfully and later.
// ---------------------------------------------------------------------

function renderActions(d, ev) {
  const c = d.case;
  const ref = state.reference ?? {};
  const latestAdr = d.adrEvents[0];
  const latestOrder = d.genotypeOrders[0];
  const latestResult = d.genotypeResults[0];
  const advisory = d.advisories[0];
  const canSign = state.user?.can_sign;
  const lang = c.preferred_language ?? 'en';
  const out = [];

  const reload = async () => { await openCase(c.id); };
  const today = new Date().toISOString().slice(0, 10);

  // ---- 1. consent, one row per purpose -----------------------------
  const activeConsents = d.consents
    .filter((k) => k.granted && !k.withdrawn_at).map((k) => k.purpose);
  const missingConsent = (ref.consentPurposes ?? []).filter(
    (p) => !activeConsents.includes(p) && p !== 'recontact');

  if (missingConsent.length) {
    out.push(stepForm({
      title: 'Record consent',
      hint: 'Separate and explicit for each purpose, in the patient’s own language. Never a single blanket flag: these are different things to agree to, and each can be withdrawn on its own.',
      fields: [
        {
          name: 'purposes', label: 'Purposes consented to', type: 'checkboxes',
          options: (ref.consentPurposes ?? []).map((p) => ({
            value: p,
            label: p.replace(/_/g, ' '),
          })),
          value: missingConsent.filter((p) => p !== 'recontact'),
          wide: true,
        },
        {
          name: 'language', label: 'Language of the consent discussion', type: 'select',
          value: lang, required: true,
          options: [
            { value: 'en', label: 'English' }, { value: 'hi', label: 'Hindi' },
            { value: 'mr', label: 'Marathi' }, { value: 'ta', label: 'Tamil' },
            { value: 'bn', label: 'Bengali' }, { value: 'te', label: 'Telugu' },
            { value: 'other', label: 'Other' },
          ],
        },
        {
          name: 'documentRef', label: 'Signed form reference',
          placeholder: 'e.g. ICF-2026-0184',
          hint: 'The paper the patient actually signed.',
        },
      ],
      submitLabel: 'Record consent',
      onSubmit: async (v) => {
        if (!v.purposes.length) throw new Error('Select at least one purpose.');
        for (const purpose of v.purposes) {
          await api(`/api/cases/${c.id}/consents`, {
            method: 'POST',
            body: JSON.stringify({
              purpose, granted: true, language: v.language, documentRef: v.documentRef,
            }),
          });
        }
        toast(`Consent recorded for: ${v.purposes.join(', ')}.`);
        await reload();
      },
    }));

    out.push(shortcuts(shortcut('Consent to all purposes', async () => {
      for (const purpose of missingConsent) {
        await api(`/api/cases/${c.id}/consents`, {
          method: 'POST',
          body: JSON.stringify({ purpose, granted: true, language: lang, documentRef: 'FORM-DEMO-1' }),
        });
      }
      toast('Consent recorded separately for each purpose. Never a blanket flag.');
      await reload();
    })));
  }

  // ---- 2. the adverse drug reaction --------------------------------
  if (!latestAdr) {
    const drugNames = (ref.drugs ?? []).flatMap((x) => [x.name, ...(x.synonyms ?? [])]);
    out.push(stepForm({
      title: 'Log the adverse drug reaction',
      hint: 'As reported to the AMC. Causality is assessed separately, as its own signed judgement, so it is deliberately not on this form.',
      fields: [
        {
          name: 'suspectDrug', label: 'Suspect drug', required: true,
          placeholder: 'International Nonproprietary Name, or a brand name',
          suggestions: drugNames,
          hint: 'Any drug may be entered. One outside the rule pack is simply out of scope and produces no output.',
          wide: true,
        },
        {
          name: 'reactionType', label: 'Reaction type', type: 'select', required: true,
          placeholder: 'Select…',
          options: (ref.reactionTypes ?? []).map((r) => ({
            value: r.value,
            label: r.value.replace(/_/g, ' '),
            note: r.inScope ? null : 'not in cascade scope',
          })),
        },
        { name: 'onsetDate', label: 'Date of onset', type: 'date', max: today },
        {
          name: 'latencyDays', label: 'Latency, days', type: 'number', min: 0, max: 400,
          hint: 'Days from first dose to onset.',
        },
        {
          name: 'vigiflowRef', label: 'PvPI / VigiFlow ICSR reference',
          placeholder: 'e.g. IN-IPC-2026-000184',
        },
        {
          name: 'outcome', label: 'Outcome', type: 'select', placeholder: 'Not recorded',
          options: (ref.outcomes ?? []).map((o) => ({ value: o, label: o })),
        },
      ],
      submitLabel: 'Log the reaction',
      note: 'Causality is assessed in the next step.',
      onSubmit: async (v) => {
        await api(`/api/cases/${c.id}/adr-events`, {
          method: 'POST',
          body: JSON.stringify({ ...v, causalityWhoUmc: 'not_assessed' }),
        });
        toast('Reaction logged with causality not yet assessed. Gate 3 will block until it is.');
        await reload();
      },
    }));

    out.push(shortcuts(
      shortcut('Carbamazepine / SJS', async () => {
        await api(`/api/cases/${c.id}/adr-events`, {
          method: 'POST',
          body: JSON.stringify({
            suspectDrug: 'carbamazepine', reactionType: 'SJS', onsetDate: '2026-08-15',
            latencyDays: 21, causalityWhoUmc: 'not_assessed', vigiflowRef: 'IN-DEMO-0001',
          }),
        });
        toast('ADR logged with causality NOT assessed. Watch gate 3 block.');
        await reload();
      }),
      shortcut('Phenytoin / TEN', async () => {
        await api(`/api/cases/${c.id}/adr-events`, {
          method: 'POST',
          body: JSON.stringify({
            suspectDrug: 'phenytoin', reactionType: 'TEN', onsetDate: '2026-08-02',
            latencyDays: 14, causalityWhoUmc: 'not_assessed', vigiflowRef: 'IN-DEMO-0002',
          }),
        });
        await reload();
      }),
      shortcut('Amoxicillin / MPE (out of scope)', async () => {
        await api(`/api/cases/${c.id}/adr-events`, {
          method: 'POST',
          body: JSON.stringify({
            suspectDrug: 'amoxicillin', reactionType: 'MPE',
            causalityWhoUmc: 'probable', vigiflowRef: 'IN-DEMO-0003',
          }),
        });
        toast('A drug outside the rule pack. Gate 1 returns NO ACTION, not an error.');
        await reload();
      }),
    ));
  }

  // ---- 3. WHO-UMC causality ----------------------------------------
  //
  // Available whenever an ADR exists, not only the first time. A causality
  // assessment is a judgement that gets revised, on a rechallenge or when
  // more information arrives, and a system that recorded the first answer
  // as final would quietly encourage guessing early.
  if (latestAdr) {
    const assessed = latestAdr.causality_who_umc !== 'not_assessed';
    out.push(stepForm({
      title: assessed ? 'Reassess WHO-UMC causality' : 'Assess WHO-UMC causality',
      tone: assessed ? 'secondary' : null,
      hint: `For ${latestAdr.suspect_drug}, ${String(latestAdr.reaction_type).replace(/_/g, ' ')}.`
        + (assessed
          ? ` Currently recorded as ${latestAdr.causality_who_umc}. Reassessing replaces it and records you as the assessor.`
          : ' This is a clinical judgement and is recorded against your name. Cascade testing starts from a confirmed index case, so anything below probable stops the pathway.'),
      fields: [
        {
          name: 'causality', label: 'WHO-UMC assessment', type: 'select', required: true,
          placeholder: 'Select…', wide: true,
          options: (ref.causalityGrades ?? [])
            .filter((g) => g.value !== 'not_assessed')
            .map((g) => ({
              value: g.value, label: g.value.replace(/_/g, ' '),
              note: g.sufficient ? 'proceeds' : 'blocks at gate 3',
            })),
        },
      ],
      submitLabel: assessed ? 'Replace assessment' : 'Record assessment',
      note: `Recorded as assessed by ${state.user?.full_name ?? 'you'}.`,
      onSubmit: async (v) => {
        await api(`/api/adr-events/${latestAdr.id}/causality`, {
          method: 'POST', body: JSON.stringify({ causality: v.causality }),
        });
        toast(`Causality recorded as ${v.causality}.`);
        await reload();
      },
    }));

    if (!assessed) {
      out.push(shortcuts(shortcut('Assess as probable', async () => {
        await api(`/api/adr-events/${latestAdr.id}/causality`, {
          method: 'POST', body: JSON.stringify({ causality: 'probable' }),
        });
        toast('WHO-UMC causality assessed as probable.');
        await reload();
      })));
    }
  }

  // ---- 4. order the genotype ---------------------------------------
  if (latestAdr && !latestOrder) {
    out.push(stepForm({
      title: 'Order the genotype',
      hint: 'Gate 5 is the one that matters. Until a confirmed result comes back there is no family link and nothing can cascade.',
      fields: [
        {
          name: 'geneSymbol', label: 'Gene', type: 'select', required: true,
          value: (ref.genes ?? [])[0],
          options: (ref.genes ?? []).map((g) => ({ value: g, label: g })),
        },
        {
          name: 'labName', label: 'Laboratory', required: true,
          placeholder: 'Name of the testing laboratory',
        },
        {
          name: 'labAccreditation', label: 'Accreditation', type: 'select', required: true,
          placeholder: 'Select…',
          options: (ref.accreditations ?? []).map((a) => ({
            value: a.value, label: a.value,
            note: a.accepted ? 'accepted' : 'blocks at gate 5',
          })),
        },
      ],
      submitLabel: 'Order the test',
      onSubmit: async (v) => {
        await api(`/api/cases/${c.id}/genotype-orders`, {
          method: 'POST', body: JSON.stringify({ ...v, adrEventId: latestAdr.id }),
        });
        toast('Genotype ordered. Gate 5 blocks until a verified result arrives.');
        await reload();
      },
    }));

    out.push(shortcuts(shortcut('Order from a NABL laboratory', async () => {
      await api(`/api/cases/${c.id}/genotype-orders`, {
        method: 'POST',
        body: JSON.stringify({
          adrEventId: latestAdr.id, geneSymbol: 'HLA-B',
          labName: 'Demo Genomics Laboratory', labAccreditation: 'NABL',
        }),
      });
      await reload();
    })));
  }

  // ---- 5. enter the laboratory result ------------------------------
  if (latestOrder && !latestResult) {
    const known = (ref.diplotypes ?? []).filter(
      (x) => x.gene === latestOrder.gene_symbol).map((x) => x.diplotype);
    out.push(stepForm({
      title: 'Enter the laboratory result',
      hint: 'Transcribe exactly what the report says. A second registered user must then verify it independently, because a transcription error in a genotype can route a carrier back onto the drug that nearly killed them.',
      fields: [
        {
          name: 'diplotype', label: 'Diplotype as reported', required: true, wide: true,
          suggestions: known,
          placeholder: 'e.g. *15:02/*40:06, or Positive',
          hint: 'Free text. Anything this rule pack cannot resolve blocks at gate 5 rather than being read as absence of risk.',
        },
        {
          name: 'method', label: 'Method', required: true,
          suggestions: ref.methods ?? [], placeholder: 'e.g. PCR-SSP',
        },
        {
          name: 'reportRef', label: 'Laboratory report reference', required: true,
          placeholder: 'e.g. LAB-2026-77421',
        },
        {
          name: 'labName', label: 'Laboratory', required: true,
          value: latestOrder.lab_name ?? '',
        },
        {
          name: 'labAccreditation', label: 'Accreditation', type: 'select', required: true,
          value: latestOrder.lab_accreditation ?? '',
          options: (ref.accreditations ?? []).map((a) => ({
            value: a.value, label: a.value,
            note: a.accepted ? 'accepted' : 'blocks at gate 5',
          })),
        },
        {
          name: 'resultedAt', label: 'Date resulted', type: 'date', required: true,
          value: today, max: today,
          hint: 'A future date is a data-entry error and is refused.',
        },
      ],
      submitLabel: 'Enter result',
      onSubmit: async (v) => {
        await api(`/api/genotype-orders/${latestOrder.id}/results`, {
          method: 'POST',
          body: JSON.stringify({
            ...v, indexCaseId: c.id, geneSymbol: latestOrder.gene_symbol,
            resultedAt: new Date(`${v.resultedAt}T09:00:00`).toISOString(),
          }),
        });
        toast('Result entered. It still needs a second user to verify it.');
        await reload();
      },
    }));

    const quick = (label, diplotype) => shortcut(label, async () => {
      await api(`/api/genotype-orders/${latestOrder.id}/results`, {
        method: 'POST',
        body: JSON.stringify({
          indexCaseId: c.id, geneSymbol: latestOrder.gene_symbol, diplotype,
          method: 'PCR-SSP', labName: latestOrder.lab_name ?? 'Demo Genomics Laboratory',
          labAccreditation: latestOrder.lab_accreditation ?? 'NABL',
          reportRef: `LAB-DEMO-${Math.floor(Math.random() * 90000 + 10000)}`,
          resultedAt: new Date(Date.now() - 86400000).toISOString(),
        }),
      });
      await reload();
    });
    out.push(shortcuts(
      quick('Carrier *15:02/*40:06', '*15:02/*40:06'),
      quick('Non-carrier *40:06/*44:03', '*40:06/*44:03'),
      quick('Unrecognised *15:11/*40:06', '*15:11/*40:06'),
    ));
  }

  // ---- 6. independent verification ---------------------------------
  if (latestResult && !latestResult.verified_by) {
    const isEnterer = latestResult.entered_by === state.user?.id;
    const enteredByName = (state.users.find((u) => u.id === latestResult.entered_by) ?? {}).full_name;
    out.push(el('div', { class: 'step-form' },
      el('h3', {}, 'Verify the result independently'),
      el('p', { class: 'hint' },
        `Entered by ${enteredByName ?? 'another user'} as `,
        el('strong', {}, `${latestResult.gene_symbol} ${latestResult.diplotype}`),
        ` from report ${latestResult.report_ref}. A different registered user must check it against the laboratory report.`),
      el('div', { class: 'form-actions' },
        el('button', {
          class: 'primary', disabled: isEnterer,
          title: isEnterer
            ? 'You entered this result. Switch to another user to verify it.'
            : '',
          onclick: async () => {
            try {
              await api(`/api/genotype-results/${latestResult.id}/verify`,
                { method: 'POST', body: '{}' });
              toast('Verified by a second user.');
              await reload();
            } catch (e) { toast(e.message, true); }
          },
        }, isEnterer ? 'You entered this, so you cannot verify it' : 'Confirm it matches the report'),
        isEnterer
          ? el('span', { class: 'hint' }, 'Switch user in the header to continue.')
          : null)));
  }

  // ---- 7. draft the advisory ---------------------------------------
  if (ev?.decision === 'ADVISORY_DRAFT' && !advisory) {
    out.push(stepForm({
      title: 'Draft the familial advisory',
      hint: 'Relatives are recorded as a relationship type and a count, and nothing else. There is no table in this system that can hold a name, a number or an address for any of them.',
      fields: (ref.relationshipTypes ?? []).map((t) => ({
        name: t, label: t.replace(/_/g, ' '), type: 'number', min: 0, max: 30, value: 0,
      })),
      submitLabel: 'Create draft',
      note: 'Nothing prints until a named clinician signs it.',
      onSubmit: async (v) => {
        const recipientSummary = Object.entries(v)
          .filter(([, n]) => Number(n) > 0)
          .map(([relationshipType, count]) => ({ relationshipType, count: Number(count) }));
        await api('/api/advisories', {
          method: 'POST',
          body: JSON.stringify({ indexCaseId: c.id, recipientSummary }),
        });
        toast('Draft created. It is not a document until it is signed.');
        await reload();
      },
    }));

    out.push(shortcuts(shortcut('Draft with two siblings and one parent', async () => {
      await api('/api/advisories', {
        method: 'POST',
        body: JSON.stringify({
          indexCaseId: c.id,
          recipientSummary: [
            { relationshipType: 'sibling', count: 2 },
            { relationshipType: 'parent', count: 1 },
          ],
        }),
      });
      await reload();
    })));
  }

  // ---- 8. sign and issue -------------------------------------------
  if (advisory && advisory.status === 'draft') {
    out.push(el('div', { class: 'step-form' },
      el('h3', {}, 'Review and sign'),
      el('p', { class: 'hint' },
        canSign
          ? 'Signing re-renders the document under your own name and registration number, and re-runs the engine first so that a rule pack which expired since drafting stops the signature.'
          : `${state.user?.full_name ?? 'This user'} is not a registered clinician who may sign. The database policy refuses it, not this screen.`),
      el('div', { class: 'form-actions' },
        el('button', {
          class: 'primary', disabled: !canSign,
          onclick: async () => {
            try {
              await api(`/api/advisories/${advisory.id}/sign`, { method: 'POST', body: '{}' });
              toast('Signed under the signing clinician’s own name.');
              await reload();
            } catch (e) { toast(e.message, true); }
          },
        }, canSign ? 'Sign this advisory' : 'Not permitted for this role'),
        el('button', {
          onclick: async () => {
            try {
              await api(`/api/advisories/${advisory.id}/issue`, { method: 'POST', body: '{}' });
              await reload();
            } catch (e) {
              toast(`Refused by the database trigger: ${e.data?.error ?? e.message}. An advisory cannot reach "issued" unsigned.`, true);
            }
          },
        }, 'Try to issue without signing'))));
  }

  if (advisory && advisory.status === 'signed') {
    out.push(el('div', { class: 'step-form' },
      el('h3', {}, 'Issue to the index patient'),
      el('p', { class: 'hint' },
        'Issued to the patient, not to anyone else. They decide whether to share it, and the system never contacts a relative.'),
      el('div', { class: 'form-actions' },
        el('button', {
          class: 'primary',
          onclick: async () => {
            try {
              await api(`/api/advisories/${advisory.id}/issue`, { method: 'POST', body: '{}' });
              toast('Issued to the index patient.');
              await reload();
            } catch (e) { toast(e.message, true); }
          },
        }, 'Issue'))));
  }

  // ---- 9. counselling ----------------------------------------------
  if (advisory && advisory.status === 'issued' && d.counselling.length === 0) {
    out.push(stepForm({
      title: 'Record counselling',
      hint: 'The right not to know is always recorded, because the schema refuses a counselling record without it.',
      fields: [
        {
          name: 'topicsCovered', label: 'Topics covered', type: 'checkboxes', wide: true,
          options: (ref.counsellingTopics ?? []).map((t) => ({
            value: t.value, label: t.label, mandatory: t.mandatory,
          })),
        },
        {
          name: 'language', label: 'Language of the discussion', type: 'select',
          required: true, value: lang,
          options: [
            { value: 'en', label: 'English' }, { value: 'hi', label: 'Hindi' },
            { value: 'mr', label: 'Marathi' }, { value: 'ta', label: 'Tamil' },
            { value: 'bn', label: 'Bengali' }, { value: 'te', label: 'Telugu' },
            { value: 'other', label: 'Other' },
          ],
        },
        { name: 'durationMin', label: 'Duration, minutes', type: 'number', min: 1, max: 240 },
        { name: 'notes', label: 'Notes', type: 'textarea', wide: true,
          hint: 'Kept in the clinical record. Never copied into the audit log.' },
      ],
      submitLabel: 'Record counselling',
      onSubmit: async (v) => {
        await api(`/api/cases/${c.id}/counselling`, {
          method: 'POST',
          body: JSON.stringify({ ...v, advisoryId: advisory.id }),
        });
        toast('Counselling recorded.');
        await reload();
      },
    }));
  }

  return out.filter(Boolean);
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
