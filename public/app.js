const $ = (id) => document.getElementById(id);

const els = {
  mic: $('mic'), micLabel: $('micLabel'), hint: $('hint'),
  transcript: $('transcript'), submit: $('submit'), clear: $('clear'), status: $('status'),
  draft: $('draft'), entries: $('entries'), search: $('search'),
  exportTxt: $('exportTxt'), exportCsv: $('exportCsv'),
  name: $('mechName'), certType: $('certType'), certNumber: $('certNumber'),
  signLogbook: $('signLogbook'),
};

// --- mechanic profile (kept locally; it never changes between entries) ------

const PROFILE_KEY = 'hangar.mechanic';
const profileFields = { mechanic_name: els.name, cert_type: els.certType, cert_number: els.certNumber };

const profile = () => ({
  mechanic_name: els.name.value.trim(),
  cert_type: els.certType.value.trim() || 'A&P',
  cert_number: els.certNumber.value.trim(),
});

try {
  const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
  for (const [key, el] of Object.entries(profileFields)) if (saved[key]) el.value = saved[key];
} catch { /* corrupt or unavailable storage — start blank */ }

for (const el of Object.values(profileFields)) {
  el.addEventListener('change', () => {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile())); } catch { /* private mode */ }
  });
}

// --- helpers ---------------------------------------------------------------

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// --- speech ----------------------------------------------------------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
let committed = '';
let stopListening = () => {};

if (!SpeechRecognition) {
  els.mic.disabled = true;
  els.micLabel.textContent = 'No mic support';
  els.hint.textContent = 'This browser has no speech recognition — type the entry below instead. (Chrome and Safari work.)';
} else {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) committed += result[0].transcript;
      else interim += result[0].transcript;
    }
    els.transcript.value = (committed + interim).replace(/\s+/g, ' ').trim();
  };

  recognition.onerror = (event) => {
    stopListening();
    setStatus(
      event.error === 'not-allowed'
        ? 'Microphone blocked — allow mic access, or type the entry.'
        : `Mic error: ${event.error}`,
      true,
    );
  };

  recognition.onend = () => { if (listening) recognition.start(); }; // browsers time out; keep going

  const startListening = () => {
    if (listening) return;
    listening = true;
    committed = els.transcript.value ? els.transcript.value + ' ' : '';
    setStatus('');
    els.mic.classList.add('mic-pulse', 'active-glow');
    els.micLabel.textContent = 'Listening…';
    try { recognition.start(); } catch { /* already started */ }
  };

  stopListening = () => {
    if (!listening) return;
    listening = false;
    els.mic.classList.remove('mic-pulse', 'active-glow');
    els.micLabel.textContent = 'HOLD TO TALK';
    recognition.stop();
  };

  // Press and hold: pointer events cover mouse, touch and pen.
  els.mic.addEventListener('pointerdown', (e) => { e.preventDefault(); startListening(); });
  for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) {
    els.mic.addEventListener(evt, stopListening);
  }
  // Keyboard users get a toggle instead.
  els.mic.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); listening ? stopListening() : startListening(); }
  });
}

// --- draft card ------------------------------------------------------------

const FIELDS = [
  ['tail_number', 'Tail number'], ['aircraft', 'Aircraft'], ['date_completed', 'Date'],
  ['tach_time', 'Tach'], ['hobbs_time', 'Hobbs'],
];

// Tracks whatever entry is currently shown in the draft card, so the
// sidebar "Sign Logbook" button knows what to sign.
let currentDraft = null; // { entry, collect: () => body }

function partsText(json) {
  return JSON.parse(json || '[]')
    .map((p) => [p.name, p.part_number && `P/N ${p.part_number}`, p.quantity && `Qty ${p.quantity}`]
      .filter(Boolean).join(', '))
    .join('\n');
}

function parsePartsText(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const bits = line.split(',').map((s) => s.trim());
    const part = { name: bits.shift() || '', part_number: '', quantity: '' };
    for (const bit of bits) {
      const pn = bit.match(/^(?:p\/n|pn|part\s*(?:no|number))\.?\s*(.+)$/i);
      const qty = bit.match(/^(?:qty|quantity)\.?\s*(.+)$/i);
      if (pn) part.part_number = pn[1];
      else if (qty) part.quantity = qty[1];
      else if (!part.part_number) part.part_number = bit;
    }
    return part;
  });
}

// Shared by both the in-card "Sign & file" button and the sidebar
// "Sign Logbook" button. Returns true on success.
async function signEntry(entry, collect, { onDisable, onEnable } = {}) {
  const p = profile();
  if (!p.mechanic_name || !p.cert_number) {
    setStatus('Add your name and certificate number up top before signing.', true);
    return false;
  }
  onDisable?.();
  try {
    const body = { ...collect(), signed: true, signed_at: new Date().toISOString().slice(0, 16).replace('T', ' ') };
    await api(`/api/entries/${entry.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    setStatus('Signed and filed.');
    els.draft.replaceChildren();
    els.draft.hidden = true;
    els.transcript.value = '';
    currentDraft = null;
    updateSignLogbookButton();
    refresh();
    return true;
  } catch (err) {
    setStatus(err.message, true);
    onEnable?.();
    return false;
  }
}

function updateSignLogbookButton() {
  if (!els.signLogbook) return;
  els.signLogbook.disabled = !currentDraft || currentDraft.entry.signed;
}

function showDraft(entry) {
  const inputs = {};
  const field = (key, label, wide = false) => {
    inputs[key] = h('input', { value: entry[key] ?? '' });
    return h('div', { class: `field${wide ? ' wide' : ''}` }, h('label', {}, label), inputs[key]);
  };
  const area = (key, label, value, rows) => {
    inputs[key] = h('textarea', { rows });
    inputs[key].value = value;
    return h('div', { class: 'field wide' }, h('label', {}, label), inputs[key]);
  };

  const rts = h('input', { type: 'checkbox' });
  rts.checked = Boolean(entry.return_to_service);

  const preview = h('pre', { class: 'preview' }, entry.entry_text);
  const card = h('div');

  const collect = () => ({
    ...profile(),
    ...Object.fromEntries(FIELDS.map(([k]) => [k, inputs[k].value.trim()])),
    discrepancy: inputs.discrepancy.value.trim(),
    description: inputs.description.value.trim(),
    parts_json: JSON.stringify(parsePartsText(inputs.parts.value)),
    return_to_service: rts.checked,
  });

  const save = async (extra = {}) => {
    const body = { ...collect(), ...extra };
    const updated = await api(`/api/entries/${entry.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    preview.textContent = updated.entry_text;
    return updated;
  };

  currentDraft = { entry, collect };
  updateSignLogbookButton();

  const signButton = h('button', {
    class: 'primary',
    onclick: async (e) => {
      await signEntry(entry, collect, {
        onDisable: () => { e.target.disabled = true; },
        onEnable: () => { e.target.disabled = false; },
      });
    },
  }, 'Sign & file');

  card.append(
    h('div', { class: 'fields' },
      ...FIELDS.map(([k, label]) => field(k, label)),
    ),
    area('discrepancy', 'Discrepancy (optional)', entry.discrepancy, 2),
    area('description', 'Work performed', entry.description, 5),
    area('parts', 'Parts — one per line: name, P/N 1234, Qty 2', partsText(entry.parts_json), 3),
    entry.needs_review?.length
      ? h('p', { class: 'flag' }, `Not stated out loud: ${entry.needs_review.join(', ')}. Fill in before signing.`)
      : null,
    h('div', { class: 'row' },
      h('label', {}, rts, 'Approved for return to service'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'ghost',
        onclick: async (e) => {
          e.target.disabled = true;
          try { await save(); setStatus('Saved.'); } catch (err) { setStatus(err.message, true); }
          e.target.disabled = false;
          refresh();
        },
      }, 'Update preview'),
      signButton,
    ),
    preview,
  );

  els.draft.replaceChildren(card);
  els.draft.hidden = false;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Sidebar "Sign Logbook" button — signs whichever entry is currently
// showing in the draft card.
if (els.signLogbook) {
  els.signLogbook.addEventListener('click', async () => {
    if (!currentDraft) {
      setStatus('Format an entry first, then sign it.', true);
      return;
    }
    await signEntry(currentDraft.entry, currentDraft.collect, {
      onDisable: () => { els.signLogbook.disabled = true; },
      onEnable: () => { updateSignLogbookButton(); },
    });
  });
}

// --- submit ----------------------------------------------------------------

async function submit() {
  stopListening();
  const transcript = els.transcript.value.trim();
  if (!transcript) { setStatus('Nothing to format yet.', true); return; }

  els.submit.disabled = true;
  setStatus('Formatting…');
  try {
    const entry = await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({ transcript, ...profile() }),
    });
    setStatus('Draft ready — review, then sign.');
    showDraft(entry);
    refresh();
  } catch (err) {
    setStatus(err.message, true);
  }
  els.submit.disabled = false;
}

els.submit.addEventListener('click', submit);
els.clear.addEventListener('click', () => {
  stopListening();
  els.transcript.value = '';
  committed = '';
  els.draft.replaceChildren();
  els.draft.hidden = true;
  currentDraft = null;
  updateSignLogbookButton();
  setStatus('');
});

// --- logbook list ----------------------------------------------------------

function entryCard(entry) {
  return h('article', { class: 'entry' },
    h('div', { class: 'entry-head' },
      h('span', { class: 'tail' }, entry.tail_number || 'No tail number'),
      h('span', { class: 'meta' }, [entry.date_completed, entry.aircraft].filter(Boolean).join(' · ')),
      h('div', { class: 'spacer' }),
      h('span', { class: `badge ${entry.signed ? 'signed' : 'unsigned'}` }, entry.signed ? 'Signed' : 'Unsigned'),
    ),
    h('p', { class: 'entry-body' }, entry.description),
    h('div', { class: 'row' },
      h('button', {
        class: 'link',
        onclick: (e) => {
          const shown = e.target.parentNode.parentNode.querySelector('pre');
          if (shown) { shown.remove(); e.target.textContent = 'Show entry'; }
          else {
            e.target.parentNode.parentNode.append(h('pre', { class: 'preview' }, entry.entry_text));
            e.target.textContent = 'Hide entry';
          }
        },
      }, 'Show entry'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'link danger',
        onclick: async () => {
          if (!confirm(`Delete this entry${entry.tail_number ? ` for ${entry.tail_number}` : ''}? This cannot be undone.`)) return;
          await api(`/api/entries/${entry.id}`, { method: 'DELETE' });
          refresh();
        },
      }, 'Delete'),
    ),
  );
}

async function refresh() {
  const q = els.search.value.trim();
  const query = q ? `?q=${encodeURIComponent(q)}` : '';
  els.exportTxt.href = `/api/export?format=txt${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  els.exportCsv.href = `/api/export?format=csv${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  try {
    const entries = await api(`/api/entries${query}`);
    els.entries.replaceChildren(
      ...(entries.length ? entries.map(entryCard) : [h('div', { class: 'empty flex flex-col items-center justify-center py-24 bg-surface-container-low/20 rounded border border-dashed border-outline-variant/50' },
        h('span', { class: 'material-symbols-outlined text-outline-variant/30 text-5xl mb-6' }, 'history_edu'),
        h('p', { class: 'text-on-surface-variant/50 font-data-mono text-xs uppercase tracking-widest' }, q ? 'No matching entries.' : 'No entries yet. Hold the mic and describe what you did.')
      )]),
    );
  } catch (err) {
    els.entries.replaceChildren(h('p', { class: 'empty' }, err.message));
  }
}

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 180);
});

api('/api/health').then((h) => {
  if (h.ai === 'fallback') setStatus('Running without ANTHROPIC_API_KEY — entries are stored raw, not formatted.');
}).catch(() => {});

updateSignLogbookButton();
refresh();