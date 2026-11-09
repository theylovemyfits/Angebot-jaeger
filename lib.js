// Gemeinsame Logik für Erweiterung und Handy-Seite (ohne Chrome-Abhängigkeiten)
const DAY_MS = 86400000;

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function matchesKeyword(title, keyword) {
  const t = normalizeText(title);
  return normalizeText(keyword).split(/\s+/).filter(Boolean).every(w => t.includes(w));
}
function formatPrice(p) {
  return Number(p).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}
function todayNumber() {
  const d = new Date();
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / DAY_MS);
}
function dayToDate(n) {
  const d = new Date(n * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function fmtDay(n, opts) {
  return dayToDate(n).toLocaleDateString('de-DE', opts || { day: 'numeric', month: 'numeric' });
}
function splitList(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- Merkliste ----------
// Eintrag: { id, product, brands: [], exclude: [], createdAt, updatedAt, deleted? }
function matchWatch(w, title, brand) {
  if (!w || !w.product || !matchesKeyword(title, w.product)) return false;
  const t = normalizeText(title + ' ' + (brand || ''));
  if ((w.exclude || []).some(x => x && t.includes(normalizeText(x)))) return false;
  if (w.brands && w.brands.length) return w.brands.some(b => t.includes(normalizeText(b)));
  return true;
}
function mergeWatchlists(a, b) {
  const m = new Map();
  for (const w of [...(a || []), ...(b || [])]) {
    const x = m.get(w.id);
    if (!x || (w.updatedAt || 0) > (x.updatedAt || 0)) m.set(w.id, w);
  }
  return [...m.values()].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
}
function activeWatch(list) { return (list || []).filter(w => !w.deleted); }
function watchFromFavorites(favs) {
  const now = Date.now();
  return (favs || []).map((f, i) => ({ id: uid() + i, product: f, brands: [], exclude: [], createdAt: now + i, updatedAt: now }));
}

function guessBrand(title, brand) {
  if (brand && String(brand).trim()) return String(brand).trim();
  const words = String(title).trim().split(/\s+/);
  if (words.length < 2) return null;
  const w = words[0].replace(/[,:;.]$/, '');
  if (w.length < 2 || !/^[A-ZÄÖÜ0-9]/.test(w)) return null;
  return w;
}
function brandCandidates(product, exclude, entries) {
  const counts = new Map();
  for (const e of entries) {
    if (!matchWatch({ product, exclude, brands: [] }, e.t, e.b)) continue;
    const b = guessBrand(e.t, e.b);
    if (!b) continue;
    const k = normalizeText(b);
    const c = counts.get(k) || { name: b, n: 0 };
    c.n++;
    counts.set(k, c);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

// ---------- Preisverlauf ----------
// Verlaufseintrag: { t, s, b, r: [[startTag, endTag, preis, alterPreis]] }
function historyKey(storeId, title) { return storeId + '|' + normalizeText(title).replace(/\s+/g, ' ').trim(); }

function addToHistory(history, storeId, items, day) {
  for (const it of items) {
    const key = historyKey(storeId, it.title);
    const e = history[key] || (history[key] = { t: it.title, s: storeId, b: it.brand || '', r: [] });
    const last = e.r[e.r.length - 1];
    const old = it.oldPrice || 0;
    if (last && last[1] === day) { last[2] = Math.min(last[2], it.price); last[3] = old || last[3]; }
    else if (last && Math.abs(last[2] - it.price) < 0.005 && day - last[1] <= 3) { last[1] = day; if (old) last[3] = old; }
    else e.r.push([day, day, it.price, old]);
  }
}
function pruneHistory(history, day) {
  for (const k in history) {
    const e = history[k];
    e.r = e.r.filter(r => r[1] >= day - 400);
    if (!e.r.length) delete history[k];
  }
}

function watchStats(w, entries, currentItems, now) {
  const runs = [];
  for (const e of entries) {
    if (!matchWatch(w, e.t, e.b)) continue;
    for (const r of e.r) runs.push({ s: e.s, t: e.t, d0: r[0], d1: r[1], p: r[2], o: r[3] || 0 });
  }
  runs.sort((a, b) => a.d0 - b.d0 || a.p - b.p);
  const current = currentItems.filter(i => matchWatch(w, i.t, i.b)).sort((a, b) => a.p - b.p);
  const best = current[0] || null;
  if (!runs.length) return { runs, current, best, verdict: null };

  const firstDay = runs[0].d0;
  const minRun = runs.reduce((m, r) => (r.p < m.p ? r : m), runs[0]);
  const avg = runs.reduce((s, r) => s + r.p, 0) / runs.length;
  const covered = new Set();
  for (const r of runs) for (let d = r.d0; d <= r.d1 && covered.size < 2000; d++) covered.add(d);
  const lastOffer = runs.reduce((m, r) => Math.max(m, r.d1), 0);
  const starts = [];
  for (const d of [...new Set(runs.map(r => r.d0))].sort((a, b) => a - b))
    if (!starts.length || d - starts[starts.length - 1] > 3) starts.push(d);
  const interval = starts.length >= 2 ? Math.round((starts[starts.length - 1] - starts[0]) / (starts.length - 1)) : null;
  const trackedDays = now - firstDay + 1;

  let verdict = null;
  if (best) {
    if (trackedDays < 14) verdict = { level: 'info', text: 'Noch zu wenig Verlauf für einen Vergleich.' };
    else if (best.p <= minRun.p + 0.001) verdict = { level: 'top', text: `Tiefstpreis seit ${fmtDay(firstDay)}` };
    else if (best.p <= avg + 0.001) verdict = { level: 'good', text: `Guter Preis, im Schnitt ${formatPrice(avg)}` };
    else verdict = { level: 'meh', text: `Eher teuer, Tiefstpreis war ${formatPrice(minRun.p)}` };
  }
  return { runs, current, best, verdict, firstDay, minRun, avg, coveredDays: covered.size, trackedDays, lastOffer, interval };
}
