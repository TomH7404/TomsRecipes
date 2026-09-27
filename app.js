/* Rezepte – MVP
 * Speicher: IndexedDB (Rezepte + Fotos als Blobs), Backup als JSON-Datei.
 * Kein Build-Schritt, keine Abhängigkeiten.
 */
'use strict';

const SCHEMA = 1;

/* =========================================================
   IndexedDB
   ========================================================= */
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('rezepte', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  function wrap(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }
  async function store(name, mode = 'readonly') {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }
  return {
    all: async (s) => wrap((await store(s)).getAll()),
    get: async (s, k) => wrap((await store(s)).get(k)),
    put: async (s, v) => wrap((await store(s, 'readwrite')).put(v)),
    del: async (s, k) => wrap((await store(s, 'readwrite')).delete(k)),
    async getMeta(key, fallback = null) { const r = await this.get('meta', key); return r ? r.value : fallback; },
    setMeta(key, value) { return this.put('meta', { key, value }); },
  };
})();

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* =========================================================
   Zutaten: Parsen, Skalieren, Formatieren
   ========================================================= */
// Einheit -> [kanonische Schreibweise, Kategorie]
// Kategorien: mass/vol (metrisch), spoon (Löffel & Co.), pinch (nur ganze Zahlen), count (Stück-artig)
const UNITS = {};
function addUnits(canon, cat, ...aliases) { for (const a of [canon, ...aliases]) UNITS[a.toLowerCase()] = [canon, cat]; }
addUnits('mg', 'mass'); addUnits('g', 'mass', 'gr', 'gramm'); addUnits('kg', 'mass');
addUnits('ml', 'vol'); addUnits('cl', 'vol'); addUnits('dl', 'vol'); addUnits('l', 'vol', 'liter', 'ltr');
addUnits('EL', 'spoon', 'esslöffel', 'el.', 'tbsp'); addUnits('TL', 'spoon', 'teelöffel', 'tl.', 'tsp');
addUnits('Msp.', 'spoon', 'msp', 'messerspitze'); addUnits('Tasse', 'spoon', 'tassen', 'cup', 'cups');
addUnits('Becher', 'spoon');
addUnits('Prise', 'pinch', 'prisen', 'pr.'); addUnits('Tropfen', 'pinch'); addUnits('Schuss', 'pinch');
addUnits('Spritzer', 'pinch');
addUnits('Stk.', 'count', 'stk', 'stück'); addUnits('Zehe', 'count', 'zehen'); addUnits('Dose', 'count', 'dosen');
addUnits('Bund', 'count'); addUnits('Scheibe', 'count', 'scheiben'); addUnits('Pkg.', 'count', 'pkg', 'pck.', 'pck', 'packung', 'packungen', 'päckchen');
addUnits('Glas', 'count', 'gläser'); addUnits('Blatt', 'count', 'blätter'); addUnits('Zweig', 'count', 'zweige');
addUnits('Handvoll', 'count'); addUnits('Knolle', 'count', 'knollen'); addUnits('Kopf', 'count', 'köpfe');
addUnits('Stange', 'count', 'stangen'); addUnits('Würfel', 'count'); addUnits('cm', 'count');

const FRAC_CHARS = { '½': .5, '¼': .25, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': .125 };
const QTY_RE = String.raw`(\d+\s+\d+\/\d+|\d+\/\d+|\d*[½¼¾⅓⅔⅛]|\d+(?:[.,]\d+)?)`;
const LINE_RE = new RegExp(String.raw`^${QTY_RE}(?:\s*[-–]\s*${QTY_RE})?\s*(.*)$`);

function parseQty(s) {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return m[1] / m[2];
  m = s.match(/^(\d*)([½¼¾⅓⅔⅛])$/);
  if (m) return (m[1] ? +m[1] : 0) + FRAC_CHARS[m[2]];
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseIngredientLine(raw) {
  const line = raw.trim().replace(/^[-•*·]\s*/, '');
  if (!line) return null;
  if (/:$/.test(line) && !/^\d/.test(line)) return { type: 'section', raw: line.replace(/:$/, '') };
  const m = line.match(LINE_RE);
  if (!m) return { type: 'item', raw: line, qty: null, qtyMax: null, unit: '', cat: 'count', name: line };
  const qty = parseQty(m[1]);
  const qtyMax = m[2] ? parseQty(m[2]) : null;
  let rest = m[3].trim();
  let unit = '', cat = 'count';
  const um = rest.match(/^([A-Za-zÄÖÜäöüß]+\.?)(?=\s|$)/);
  if (um) {
    const hit = UNITS[um[1].toLowerCase()] || UNITS[um[1].toLowerCase().replace(/\.$/, '')];
    if (hit) { [unit, cat] = hit; rest = rest.slice(um[1].length).trim(); }
  }
  return { type: 'item', raw: line, qty, qtyMax, unit, cat, name: rest };
}

function parseIngredients(text) {
  return text.split('\n').map(parseIngredientLine).filter(Boolean);
}

const PLURAL = { Prise: 'Prisen', Zehe: 'Zehen', Dose: 'Dosen', Scheibe: 'Scheiben', Tasse: 'Tassen',
  Stange: 'Stangen', Knolle: 'Knollen', Zweig: 'Zweige' };
const unitLabel = (unit, qty) => (qty > 1 && PLURAL[unit]) || unit;

function roundTo(v, step) { return Math.round(v / step) * step; }

function roundMetric(v) { // v in g bzw. ml
  if (v < 5) return Math.max(roundTo(v, 0.5), 0.5);
  if (v < 50) return Math.round(v);
  if (v < 500) return roundTo(v, 5);
  if (v < 1000) return roundTo(v, 10);
  return roundTo(v, 50);
}

const TO_BASE = { mg: 0.001, g: 1, kg: 1000, ml: 1, cl: 10, dl: 100, l: 1000 };

// Skaliert eine Menge und liefert {qty, unit} mit sinnvoller Rundung/Einheit.
function scaleAmount(qty, unit, cat, factor) {
  if (qty == null) return { qty, unit };
  if (factor === 1) return { qty, unit };
  let v = qty * factor;
  switch (cat) {
    case 'mass':
    case 'vol': {
      if (unit === 'mg') return { qty: Math.max(Math.round(v), 1), unit };
      let base = roundMetric(v * TO_BASE[unit]);
      if (cat === 'mass') return base >= 1000 ? { qty: roundTo(base / 1000, 0.05), unit: 'kg' } : { qty: base, unit: 'g' };
      if (base >= 1000) return { qty: roundTo(base / 1000, 0.05), unit: 'l' };
      if (unit === 'l' && base >= 250) return { qty: roundTo(base / 1000, 0.05), unit: 'l' };
      return { qty: base, unit: 'ml' };
    }
    case 'spoon':
      return { qty: Math.max(v < 2 ? roundTo(v, 0.25) : roundTo(v, 0.5), 0.25), unit };
    case 'pinch':
      return { qty: Math.max(Math.round(v), 1), unit };
    default: // count
      return { qty: v < 3 ? Math.max(roundTo(v, 0.5), 0.5) : Math.round(v), unit };
  }
}

function fmtNum(n, cat) {
  if (n == null) return '';
  const whole = Math.floor(n + 1e-9), frac = n - whole;
  const nice = cat === 'spoon' || cat === 'count' || cat === 'pinch';
  if (nice) {
    const map = [[0, ''], [0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾']];
    for (const [f, ch] of map) {
      if (Math.abs(frac - f) < 0.02) return (whole ? String(whole) : (ch ? '' : '0')) + ch;
    }
  }
  return (Math.round(n * 100) / 100).toLocaleString('de-AT', { maximumFractionDigits: 2 });
}

function renderIngredient(ing, factor) {
  if (ing.type === 'section') return { section: true, text: ing.raw };
  if (ing.qty == null) return { q: '', text: ing.name || ing.raw, changed: false };
  const a = scaleAmount(ing.qty, ing.unit, ing.cat, factor);
  let q = fmtNum(a.qty, ing.cat);
  if (ing.qtyMax != null) {
    const b = scaleAmount(ing.qtyMax, ing.unit, ing.cat, factor);
    q += '–' + fmtNum(b.qty, ing.cat);
  }
  if (a.unit) q += ' ' + unitLabel(a.unit, ing.qtyMax != null ? 2 : a.qty);
  return { q, text: ing.name, changed: factor !== 1 };
}

function ingredientsToText(list) {
  return (list || []).map((i) => (i.type === 'section' ? i.raw + ':' : i.raw)).join('\n');
}

function parseSteps(text) {
  const t = text.replace(/\r/g, '').trim();
  if (!t) return [];
  const parts = /\n\s*\n/.test(t) ? t.split(/\n\s*\n/) : t.split('\n');
  return parts.map((s) => s.trim().replace(/^\d+[.)]\s*/, '').replace(/\s*\n\s*/g, ' ')).filter(Boolean);
}

/* =========================================================
   Fotos
   ========================================================= */
async function compressImage(file, maxEdge = 1600, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Das Bild konnte nicht gelesen werden.'));
      i.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const photoUrls = new Map(); // photoId -> objectURL (Cache für die Sitzung)
async function photoUrl(id) {
  if (!id) return null;
  if (photoUrls.has(id)) return photoUrls.get(id);
  const p = await DB.get('photos', id);
  if (!p) return null;
  const u = URL.createObjectURL(p.blob);
  photoUrls.set(id, u);
  return u;
}

/* =========================================================
   Hilfsfunktionen UI
   ========================================================= */
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const fmtDate = (ts) => new Date(ts).toLocaleDateString('de-AT', { day: 'numeric', month: 'long', year: 'numeric' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function confirmDialog(title, text, okLabel, danger = false) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="stack"><button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(okLabel)}</button>
      <button class="btn" value="cancel">Abbrechen</button></div>`;
    document.body.appendChild(d);
    d.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) d.close(b.value);
    });
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    d.showModal();
  });
}

async function markDirty() { await DB.setMeta('changedSinceBackup', true); }

async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) { /* egal */ }
}

/* =========================================================
   Router
   ========================================================= */
function go(hash) { location.hash = hash; }
window.addEventListener('hashchange', route);

async function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, id] = h.split('/');
  window.scrollTo(0, 0);
  try {
    if (view === 'r' && id) return await viewDetail(id);
    if (view === 'edit') return await viewEdit(id || null);
    if (view === 'backup') return await viewBackup();
    return await viewList();
  } catch (err) {
    console.error(err);
    $app.innerHTML = `<div class="empty-state"><h2>Das hat nicht geklappt</h2><p>${esc(err.message)}</p>
      <button class="btn" onclick="location.hash=''">Zur Übersicht</button></div>`;
  }
}

/* =========================================================
   Übersicht
   ========================================================= */
let listQuery = '';

async function viewList() {
  const recipes = (await DB.all('recipes')).sort((a, b) => b.updatedAt - a.updatedAt);
  const lastBackup = await DB.getMeta('lastBackupAt');
  const dirty = await DB.getMeta('changedSinceBackup', false);
  const stale = recipes.length > 0 && dirty && (!lastBackup || Date.now() - lastBackup > 7 * 864e5);

  $app.innerHTML = `
    <div class="bar"><span></span><button class="link" id="to-backup">Backup</button></div>
    <h1 class="shelf">Rezepte${recipes.length ? `<span class="count">${recipes.length}</span>` : ''}</h1>
    ${recipes.length ? `<input class="search" id="q" type="search" placeholder="Rezept oder Zutat suchen" value="${esc(listQuery)}" autocomplete="off">` : ''}
    ${stale ? `<div class="notice"><span>${lastBackup ? `Letztes Backup am ${fmtDate(lastBackup)}. Seitdem gibt es Änderungen.` : 'Noch kein Backup vorhanden.'}</span>
      <button class="link strong" id="notice-backup">Sichern</button></div>` : ''}
    <ul class="list" id="list"></ul>
    ${recipes.length ? '' : `<div class="empty-state"><h2>Noch keine Rezepte</h2>
      <p>Titel genügt fürs Erste – Zutaten, Schritte und Foto kannst du jederzeit ergänzen.</p></div>`}
    <button class="fab" id="add">Neues Rezept</button>`;

  document.getElementById('add').onclick = () => go('#/edit');
  document.getElementById('to-backup').onclick = () => go('#/backup');
  const nb = document.getElementById('notice-backup');
  if (nb) nb.onclick = () => go('#/backup');

  const $list = document.getElementById('list');
  const index = recipes.map((r) => ({ r, hay: norm([r.title, ...(r.ingredients || []).map((i) => i.name || i.raw)].join(' ')) }));

  async function draw() {
    const words = norm(listQuery).split(/\s+/).filter(Boolean);
    const hits = index.filter((x) => words.every((w) => x.hay.includes(w))).map((x) => x.r);
    if (recipes.length && !hits.length) {
      $list.innerHTML = `<li class="empty-state">Nichts gefunden für „${esc(listQuery)}“.</li>`;
      return;
    }
    $list.innerHTML = hits.map((r) => {
      const n = (r.ingredients || []).filter((i) => i.type === 'item').length;
      const meta = [r.servings ? plural(r.servings, 'Portion', 'Portionen') : null, n ? plural(n, 'Zutat', 'Zutaten') : 'noch unvollständig'].filter(Boolean).join(', ');
      return `<li><button class="row" data-id="${esc(r.id)}">
        <span class="thumb empty" data-photo="${esc((r.photoIds || [])[0] || '')}">${esc((r.title || '?').trim().charAt(0).toUpperCase())}</span>
        <span><span class="row-title">${esc(r.title)}</span><span class="row-meta">${esc(meta)}</span></span>
      </button></li>`;
    }).join('');
    for (const el of $list.querySelectorAll('[data-photo]')) {
      const u = await photoUrl(el.dataset.photo);
      if (u) {
        const img = document.createElement('img');
        img.className = 'thumb'; img.src = u; img.alt = '';
        el.replaceWith(img);
      }
    }
  }
  $list.onclick = (e) => { const b = e.target.closest('.row'); if (b) go('#/r/' + b.dataset.id); };
  const q = document.getElementById('q');
  if (q) q.oninput = () => { listQuery = q.value; draw(); };
  await draw();
}

/* =========================================================
   Detail
   ========================================================= */
async function viewDetail(id) {
  const r = await DB.get('recipes', id);
  if (!r) { toast('Dieses Rezept gibt es nicht mehr.'); return go('#/'); }
  const base = r.servings || null;
  let current = r.lastServings || base;
  const hero = await photoUrl((r.photoIds || [])[0]);
  const hasItems = (r.ingredients || []).some((i) => i.type === 'item');

  $app.innerHTML = `
    <div class="bar"><button class="link" id="back">‹ Rezepte</button><button class="link" id="edit">Bearbeiten</button></div>
    ${hero ? `<div class="hero"><img src="${hero}" alt=""></div>` : ''}
    <h1 class="dish">${esc(r.title)}</h1>
    ${base && hasItems ? `
      <div class="servings">
        <span class="servings-label" id="sv-label">Portionen</span>
        <div class="stepper" role="group" aria-labelledby="sv-label">
          <button id="minus" aria-label="Eine Portion weniger">−</button>
          <output id="sv" aria-live="polite">${current}</output>
          <button id="plus" aria-label="Eine Portion mehr">+</button>
        </div>
      </div>
      <button class="link reset" id="reset" hidden>Zurück auf ${base} (Originalrezept)</button>` : ''}
    ${hasItems || (r.ingredients || []).length ? `<h2 class="part">Zutaten</h2><ul class="ingredients" id="ings"></ul>` : ''}
    ${(r.steps || []).length ? `<h2 class="part">Zubereitung</h2><ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    ${!hasItems && !(r.steps || []).length ? `<div class="empty-state"><p>Noch keine Zutaten oder Schritte erfasst.</p>
      <button class="btn primary" id="complete">Jetzt ergänzen</button></div>` : ''}
    <div class="actions"><button class="btn primary" id="share">Teilen</button></div>
    <p class="meta-foot">Erstellt am ${fmtDate(r.createdAt)}${r.updatedAt - r.createdAt > 6e4 ? `, zuletzt geändert am ${fmtDate(r.updatedAt)}` : ''}</p>`;

  document.getElementById('back').onclick = () => go('#/');
  document.getElementById('edit').onclick = () => go('#/edit/' + id);
  const cpl = document.getElementById('complete');
  if (cpl) cpl.onclick = () => go('#/edit/' + id);

  const $ings = document.getElementById('ings');
  function drawIngs() {
    if (!$ings) return;
    const factor = base ? current / base : 1;
    $ings.innerHTML = (r.ingredients || []).map((ing) => {
      const x = renderIngredient(ing, factor);
      if (x.section) return `<li class="section">${esc(x.text)}</li>`;
      if (!x.q) return `<li class="nq"><span>${esc(x.text)}</span></li>`;
      return `<li class="${x.changed ? 'changed' : ''}"><span class="q">${esc(x.q)}</span><span>${esc(x.text)}</span></li>`;
    }).join('');
  }
  drawIngs();

  if (base && hasItems) {
    const $sv = document.getElementById('sv'), $m = document.getElementById('minus'), $reset = document.getElementById('reset');
    const sync = () => {
      $sv.textContent = current; $m.disabled = current <= 1;
      $reset.hidden = current === base;
      $sv.classList.remove('bump'); void $sv.offsetWidth; $sv.classList.add('bump');
      drawIngs();
    };
    let saveT;
    const set = (n) => {
      current = Math.max(1, Math.min(99, n)); sync();
      clearTimeout(saveT);
      saveT = setTimeout(() => { r.lastServings = current; DB.put('recipes', r); }, 400);
    };
    $m.disabled = current <= 1; $reset.hidden = current === base;
    $m.onclick = () => set(current - 1);
    document.getElementById('plus').onclick = () => set(current + 1);
    $reset.onclick = () => set(base);
  }

  document.getElementById('share').onclick = () => shareRecipe(r, current);
}

/* =========================================================
   Teilen
   ========================================================= */
function recipeText(r, servings) {
  const base = r.servings || null;
  const factor = base && servings ? servings / base : 1;
  const out = [r.title];
  if (servings) out.push(`Für ${plural(servings, 'Portion', 'Portionen')}`);
  const ings = r.ingredients || [];
  if (ings.length) {
    out.push('', 'Zutaten');
    for (const ing of ings) {
      const x = renderIngredient(ing, factor);
      out.push(x.section ? `\n${x.text}:` : `• ${x.q ? x.q + ' ' : ''}${x.text}`);
    }
  }
  if ((r.steps || []).length) {
    out.push('', 'Zubereitung');
    r.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  }
  return out.join('\n');
}

async function shareRecipe(r, servings) {
  const text = recipeText(r, servings);
  const photoId = (r.photoIds || [])[0];
  let file = null;
  if (photoId) {
    const p = await DB.get('photos', photoId);
    if (p) file = new File([p.blob], `${r.title.replace(/[^\wäöüÄÖÜß -]/g, '').trim() || 'rezept'}.jpg`, { type: 'image/jpeg' });
  }
  const canFile = file && navigator.canShare && navigator.canShare({ files: [file] });

  if (!navigator.share) {
    try { await navigator.clipboard.writeText(text); toast('Rezepttext kopiert.'); } catch (_) { toast('Teilen wird von diesem Browser nicht unterstützt.'); }
    return;
  }
  let mode = 'text';
  if (canFile) {
    mode = await new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.innerHTML = `<h3>Rezept teilen</h3>
        <p>Mit Foto klappt es in Nachrichten und Mail. WhatsApp verschickt dann manchmal nur das Bild – dort lieber „Nur Text“.</p>
        <div class="stack"><button class="btn primary" value="photo">Mit Foto teilen</button>
        <button class="btn" value="text">Nur Text teilen</button>
        <button class="btn" value="">Abbrechen</button></div>`;
      document.body.appendChild(d);
      d.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) d.close(b.value); });
      d.addEventListener('close', () => { resolve(d.returnValue); d.remove(); });
      d.showModal();
    });
    if (!mode) return;
  }
  try {
    if (mode === 'photo') await navigator.share({ title: r.title, text, files: [file] });
    else await navigator.share({ title: r.title, text });
  } catch (err) {
    if (err.name !== 'AbortError') toast('Teilen hat nicht geklappt: ' + err.message);
  }
}

/* =========================================================
   Anlegen / Bearbeiten
   ========================================================= */
async function viewEdit(id) {
  const existing = id ? await DB.get('recipes', id) : null;
  if (id && !existing) return go('#/');
  const r = existing || {
    id: uid(), schema: SCHEMA, title: '', servings: 4, lastServings: null,
    ingredients: [], steps: [], photoIds: [],
    // Felder für Phase 2 – schon im Datenmodell, damit spätere Versionen nichts migrieren müssen
    sourceUrl: '', place: '', rating: null, tags: [], cuisine: '', mealType: '', notes: '',
    createdAt: Date.now(), updatedAt: Date.now(), lastCookedAt: null,
  };
  let photoBlob = null;        // neu gewähltes Foto
  let photoRemoved = false;
  const oldPhotoId = (r.photoIds || [])[0] || null;
  const oldPhoto = await photoUrl(oldPhotoId);

  $app.innerHTML = `
    <div class="bar">
      <button class="link" id="cancel">Abbrechen</button>
      <span class="bar-title">${existing ? 'Rezept bearbeiten' : 'Neues Rezept'}</span>
      <button class="link strong" id="save">Sichern</button>
    </div>
    <label class="field"><span>Titel</span>
      <input type="text" class="title-input" id="title" value="${esc(r.title)}" placeholder="z. B. Kaspressknödel" enterkeyhint="done">
      <div class="error" id="title-err" hidden>Ein Titel reicht zum Sichern – aber ohne geht es nicht.</div>
    </label>
    <div class="field"><span>Foto</span>
      <label class="photo-pick" id="pick">
        <span id="pick-hint">Foto aufnehmen oder auswählen</span>
        ${oldPhoto ? `<img src="${oldPhoto}" alt="">` : ''}
        <input type="file" accept="image/*" id="photo" aria-label="Foto wählen">
      </label>
      <div class="photo-tools"><small id="photo-info"></small><button class="link danger" id="rm-photo" ${oldPhoto ? '' : 'hidden'}>Foto entfernen</button></div>
    </div>
    <label class="field"><span>Portionen im Originalrezept</span>
      <div class="inline"><input type="number" id="servings" inputmode="numeric" min="1" max="99" value="${r.servings ?? ''}"></div>
      <small>Grundlage für das Umrechnen auf mehr oder weniger Personen.</small>
    </label>
    <label class="field"><span>Zutaten</span>
      <textarea id="ings" placeholder="200 g Mehl&#10;2 Eier&#10;1 Prise Salz&#10;&#10;Für die Sauce:&#10;1 Dose Tomaten">${esc(ingredientsToText(r.ingredients))}</textarea>
      <small>Eine Zutat pro Zeile, Menge zuerst. Eine Zeile mit Doppelpunkt am Ende wird zur Zwischenüberschrift.</small>
    </label>
    <label class="field"><span>Zubereitung</span>
      <textarea id="steps" placeholder="Einen Schritt pro Zeile – oder Absätze durch eine Leerzeile trennen.">${esc((r.steps || []).join('\n\n'))}</textarea>
    </label>
    ${existing ? `<div class="actions"><button class="btn danger" id="delete">Rezept löschen</button></div>` : ''}`;

  const $title = document.getElementById('title');
  if (!existing) setTimeout(() => $title.focus(), 50);
  const $pick = document.getElementById('pick'), $info = document.getElementById('photo-info'), $rm = document.getElementById('rm-photo');
  const $hint = document.getElementById('pick-hint');
  if (oldPhoto) $hint.hidden = true;

  document.getElementById('photo').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $info.textContent = 'Foto wird verkleinert …';
    try {
      photoBlob = await compressImage(f);
      photoRemoved = false;
      const u = URL.createObjectURL(photoBlob);
      $pick.querySelector('img')?.remove();
      const img = document.createElement('img'); img.src = u; img.alt = '';
      $pick.insertBefore(img, $pick.querySelector('input'));
      $hint.hidden = true; $rm.hidden = false;
      $info.textContent = `${Math.round(photoBlob.size / 1024)} KB`;
    } catch (err) {
      $info.textContent = err.message;
    }
  };
  $rm.onclick = (e) => {
    e.preventDefault();
    photoBlob = null; photoRemoved = true;
    $pick.querySelector('img')?.remove();
    $hint.hidden = false; $rm.hidden = true; $info.textContent = '';
    document.getElementById('photo').value = '';
  };

  document.getElementById('cancel').onclick = () => go(existing ? '#/r/' + r.id : '#/');

  document.getElementById('save').onclick = async () => {
    const title = $title.value.trim();
    if (!title) { document.getElementById('title-err').hidden = false; $title.focus(); return; }
    const sv = parseInt(document.getElementById('servings').value, 10);
    const newServings = sv > 0 ? Math.min(sv, 99) : null;
    if (newServings !== r.servings) r.lastServings = null; // Basis geändert -> Skalierung zurücksetzen
    r.title = title;
    r.servings = newServings;
    r.ingredients = parseIngredients(document.getElementById('ings').value);
    r.steps = parseSteps(document.getElementById('steps').value);
    r.updatedAt = Date.now();

    if (photoBlob) {
      const pid = uid();
      await DB.put('photos', { id: pid, blob: photoBlob, type: 'image/jpeg' });
      r.photoIds = [pid];
      if (oldPhotoId) await DB.del('photos', oldPhotoId);
    } else if (photoRemoved && oldPhotoId) {
      r.photoIds = [];
      await DB.del('photos', oldPhotoId);
    }
    await DB.put('recipes', r);
    await markDirty();
    requestPersistence();
    toast('Gesichert.');
    history.replaceState(null, '', '#/r/' + r.id);
    route();
  };

  const del = document.getElementById('delete');
  if (del) del.onclick = async () => {
    if (!(await confirmDialog('Rezept löschen?', `„${r.title}“ wird mit Foto gelöscht. Das lässt sich nur über ein Backup wiederherstellen.`, 'Löschen', true))) return;
    for (const pid of r.photoIds || []) await DB.del('photos', pid);
    await DB.del('recipes', r.id);
    await markDirty();
    toast('Gelöscht.');
    go('#/');
  };
}

/* =========================================================
   Backup: Export / Import
   ========================================================= */
function blobToDataURL(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
}
async function dataURLToBlob(url) { return (await fetch(url)).blob(); }

async function buildBackup() {
  const recipes = await DB.all('recipes');
  const photos = await DB.all('photos');
  const used = new Set(recipes.flatMap((r) => r.photoIds || []));
  const outPhotos = [];
  for (const p of photos) if (used.has(p.id)) outPhotos.push({ id: p.id, type: p.type, data: await blobToDataURL(p.blob) });
  return { app: 'rezepte', schema: SCHEMA, exportedAt: new Date().toISOString(), recipes, photos: outPhotos };
}

async function exportBackup() {
  const data = await buildBackup();
  const name = `rezepte-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  let done = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      done = true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      // sonst: Fallback Download
    }
  }
  if (!done) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  await DB.setMeta('lastBackupAt', Date.now());
  await DB.setMeta('changedSinceBackup', false);
  return true;
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { throw new Error('Die Datei ist kein gültiges Rezepte-Backup.'); }
  if (data.app !== 'rezepte' || !Array.isArray(data.recipes)) throw new Error('Die Datei ist kein Rezepte-Backup.');
  if (data.schema > SCHEMA) throw new Error('Das Backup stammt von einer neueren App-Version. Bitte zuerst die App aktualisieren.');

  const photos = new Map((data.photos || []).map((p) => [p.id, p]));
  let added = 0, updated = 0, kept = 0;
  for (const r of data.recipes) {
    if (!r || !r.id || !r.title) continue;
    const local = await DB.get('recipes', r.id);
    if (local && local.updatedAt >= r.updatedAt) { kept++; continue; }
    for (const pid of r.photoIds || []) {
      const p = photos.get(pid);
      if (p) await DB.put('photos', { id: pid, type: p.type || 'image/jpeg', blob: await dataURLToBlob(p.data) });
    }
    if (local) for (const pid of local.photoIds || []) if (!(r.photoIds || []).includes(pid)) await DB.del('photos', pid);
    await DB.put('recipes', r);
    local ? updated++ : added++;
  }
  requestPersistence();
  return { added, updated, kept };
}

async function viewBackup() {
  const recipes = await DB.all('recipes');
  const photos = await DB.all('photos');
  const lastBackup = await DB.getMeta('lastBackupAt');
  const dirty = await DB.getMeta('changedSinceBackup', false);
  const bytes = photos.reduce((s, p) => s + (p.blob?.size || 0), 0);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  $app.innerHTML = `
    <div class="bar"><button class="link" id="back">‹ Rezepte</button><span class="bar-title">Backup</span><span style="width:60px"></span></div>
    <div class="card">
      <h2>Backup erstellen</h2>
      <p>Alle ${plural(recipes.length, 'Rezept', 'Rezepte')} mit Fotos (ca. ${Math.max(1, Math.round(bytes * 1.37 / 1024 / 1024 * 10) / 10).toLocaleString('de-AT')} MB) als eine Datei. Im Teilen-Menü „In Dateien sichern“ wählen und iCloud Drive als Ort nehmen.</p>
      <p class="status">${lastBackup ? `Letztes Backup: ${fmtDate(lastBackup)}${dirty ? ', seitdem gab es Änderungen.' : ', seitdem unverändert.'}` : 'Noch kein Backup erstellt.'}</p>
      <button class="btn primary" id="export" ${recipes.length ? '' : 'disabled'}>Backup erstellen</button>
    </div>
    <div class="card">
      <h2>Backup einspielen</h2>
      <p>Für ein neues Handy oder zum Wiederherstellen. Vorhandene Rezepte bleiben erhalten; bei gleichen Rezepten gewinnt die neuere Fassung.</p>
      <label class="btn" style="display:grid;place-items:center">Backup-Datei auswählen
        <input type="file" id="import" accept=".json,application/json" hidden></label>
    </div>
    ${standalone ? '' : `<div class="card"><h2>Zum Home-Bildschirm hinzufügen</h2>
      <p>In Safari auf Teilen tippen, dann „Zum Home-Bildschirm“. So startet die App wie eine normale App, funktioniert offline und iOS löscht die Daten nicht nach längerer Nichtbenutzung.</p></div>`}`;

  document.getElementById('back').onclick = () => go('#/');
  document.getElementById('export').onclick = async (e) => {
    e.target.disabled = true;
    try {
      if (await exportBackup()) { toast('Backup erstellt.'); viewBackup(); }
    } catch (err) {
      toast('Backup fehlgeschlagen: ' + err.message);
    } finally { e.target.disabled = false; }
  };
  document.getElementById('import').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const res = await importBackup(f);
      toast(`${res.added} neu, ${res.updated} aktualisiert, ${res.kept} unverändert.`);
      viewBackup();
    } catch (err) {
      toast(err.message);
    }
  };
}

/* =========================================================
   Start
   ========================================================= */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();

// Für Tests
window.__rezepte = { parseIngredientLine, scaleAmount, renderIngredient, parseSteps, recipeText };
