// Angebots-Radar App – läuft als Seite der Erweiterung und als Handy-Seite (GitHub Pages)
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IS_EXT = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id && chrome.storage);
const EMBED = /[?&]ansicht=widget\b/.test(location.search); // im Widget (Scriptable) geöffnet

const S = { stores: [], current: [], entries: [], catalog: [], watch: [], updatedAt: null, running: false, canEdit: IS_EXT, error: null };
const ui = { q: '', stores: new Set(), limit: 100, range: 90, prefill: '', formKey: null, draft: null };

function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64dec(b64) {
  const bin = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function ghMsg(status) {
  if (status === 401) return 'Der Token ist ungültig oder abgelaufen.';
  if (status === 403) return 'Der Token darf nicht in dieses Repository schreiben („Contents: Read and write“ prüfen).';
  if (status === 404) return 'Repository nicht gefunden.';
  return 'GitHub-Fehler ' + status;
}

// ================= Datenquellen =================
const Ext = {
  async load() {
    const settings = await getSettings();
    const d = await chrome.storage.local.get(['offers', 'history', 'watchlist', 'favorites', 'lastRun']);
    const offers = d.offers || {};
    const enabled = settings.stores.filter(s => s.enabled);
    S.stores = enabled.map(s => ({ id: s.id, name: s.name, count: (offers[s.id] && offers[s.id].items.length) || 0, error: (offers[s.id] && offers[s.id].error) || null }));
    S.current = [];
    for (const s of enabled)
      for (const it of (offers[s.id] && offers[s.id].items) || [])
        S.current.push({ t: it.title, p: it.price, o: it.oldPrice, i: it.image, b: it.brand, s: s.id });
    S.entries = Object.values(d.history || {});
    const recent = todayNumber() - 60;
    S.catalog = S.entries.filter(e => e.r.length && e.r[e.r.length - 1][1] >= recent);
    S.watch = d.watchlist || watchFromFavorites(d.favorites);
    S.updatedAt = d.lastRun || null;
    const ss = await chrome.storage.session.get('running');
    S.running = !!(ss.running && Date.now() - ss.running < 12 * 60e3);
  },
  async saveWatch(w) {
    const { watchlist } = await chrome.storage.local.get('watchlist');
    const merged = mergeWatchlists(watchlist || S.watch, [w]);
    await chrome.storage.local.set({ watchlist: merged });
    S.watch = merged;
    chrome.runtime.sendMessage({ type: 'syncWatchlist' });
  }
};

const Web = {
  base: location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, ''),
  repo() {
    const owner = location.hostname.split('.')[0];
    const first = location.pathname.split('/').filter(Boolean)[0];
    return first && !first.includes('.') ? `${owner}/${first}` : `${owner}/${owner}.github.io`;
  },
  token() { try { return localStorage.getItem('radar-gh-token') || ''; } catch { return ''; } },
  setToken(t) { try { t ? localStorage.setItem('radar-gh-token', t) : localStorage.removeItem('radar-gh-token'); } catch {} },
  async json(name) {
    try { const r = await fetch(this.base + name + '?t=' + Date.now(), { cache: 'no-store' }); return r.ok ? await r.json() : null; }
    catch { return null; }
  },
  api(path, opts = {}) {
    const url = `https://api.github.com/repos/${this.repo()}/contents/${path}` + (opts.method ? '' : `?t=${Date.now()}`);
    const headers = { Authorization: `Bearer ${this.token()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(url, { ...opts, headers, cache: 'no-store' });
  },
  async load() {
    const [data, hist, cat] = await Promise.all([this.json('data.json'), this.json('history.json'), this.json('catalog.json')]);
    S.error = data ? null : 'Noch keine Angebote hochgeladen. Drück in der Erweiterung unter Einstellungen auf „Jetzt hochladen“.';
    S.stores = (data && data.stores) || [];
    S.current = (data && data.items) || [];
    S.updatedAt = (data && data.updatedAt) || null;
    S.entries = (hist && hist.entries) || [];
    S.catalog = (cat && cat.entries) || [];
    S.canEdit = !!this.token();
    S.watch = await this.loadWatch();
  },
  async loadWatch() {
    if (this.token()) {
      try {
        const r = await this.api('watchlist.json');
        if (r.status === 404) return [];
        if (r.ok) return JSON.parse(b64dec((await r.json()).content)).items || [];
      } catch {}
    }
    const w = await this.json('watchlist.json');
    return (w && w.items) || [];
  },
  async saveWatch(w) {
    if (!this.token()) throw new Error('Zum Bearbeiten musst du einmal deinen GitHub-Token eingeben.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.api('watchlist.json');
      let sha, remote = [];
      if (r.ok) { const j = await r.json(); sha = j.sha; try { remote = JSON.parse(b64dec(j.content)).items || []; } catch {} }
      else if (r.status !== 404) throw new Error(ghMsg(r.status));
      const merged = mergeWatchlists(remote, [w]);
      const p = await this.api('watchlist.json', { method: 'PUT', body: JSON.stringify({ message: 'Merkliste am Handy geändert', content: b64enc(JSON.stringify({ items: merged })), sha }) });
      if (p.ok) { S.watch = merged; return; }
      if (p.status !== 409 && p.status !== 422) throw new Error(ghMsg(p.status));
    }
    throw new Error('Speichern hat nicht geklappt, bitte nochmal versuchen.');
  }
};
const DB = IS_EXT ? Ext : Web;

// ================= Hilfen =================
function storeName(id) {
  const s = S.stores.find(x => x.id === id) || DEFAULT_STORES.find(x => x.id === id);
  return s ? s.name : id;
}
const color = id => STORE_COLORS[id] || '#888';
function storeIcon(id, big) {
  return STORE_LOGOS.includes(id)
    ? `<img class="logo${big ? ' big' : ''}" src="icons/maerkte/${id}.png" alt="">`
    : `<span class="logo${big ? ' big' : ''} logo-text" style="background:${color(id)}">${esc(storeName(id).slice(0, 1))}</span>`;
}
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const t = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? `heute, ${t} Uhr`
    : d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'numeric' }) + `, ${t} Uhr`;
}
function verdictBadge(v) {
  if (!v || v.level === 'info') return '';
  const label = { top: 'Tiefstpreis', good: 'Guter Preis', meh: 'Eher teuer' }[v.level];
  return `<span class="badge ${v.level}">${label}</span>`;
}
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('p-')) return { v: 'produkt', id: h.slice(2) };
  if (h.startsWith('edit-')) return { v: 'form', id: h.slice(5) };
  if (h === 'neu') return { v: 'form', id: null };
  if (h === 'alle') return { v: 'alle' };
  if (h.startsWith('markt-')) return { v: 'alle', store: h.slice(6) };
  if (h === 'mehr' || h === 'zugang') return { v: 'mehr' };
  return { v: 'liste' };
}

// ================= Darstellung =================
function render() {
  $('#status').textContent = S.running ? 'Angebote werden gerade abgerufen …'
    : S.error ? S.error
    : S.updatedAt ? `Stand: ${fmtTime(S.updatedAt)} · ${S.current.length} Angebote` : 'Noch keine Angebote abgerufen.';

  $('#top-actions').innerHTML = IS_EXT
    ? `<button class="btn" type="button" data-act="refresh" ${S.running ? 'disabled' : ''}>${S.running ? 'Läuft …' : 'Aktualisieren'}</button>
       <a class="btn" href="dashboard.html">Einstellungen</a>`
    : `<button class="icon-btn" type="button" data-act="reload" aria-label="Neu laden"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg></button>`;

  const r = route();
  const navKey = r.v === 'alle' || r.v === 'mehr' ? r.v : 'liste';
  document.querySelectorAll('[data-nav]').forEach(a => a.toggleAttribute('aria-current', a.dataset.nav === navKey));
  if (r.v === 'form') return renderForm(r.id);
  ui.formKey = null;
  const main = $('#main');
  if (r.v === 'liste') main.innerHTML = viewListe();
  if (r.v === 'produkt') main.innerHTML = viewProdukt(r.id);
  if (r.v === 'alle') {
    if (r.store && ui.storeRoute !== r.store) { ui.stores = new Set([r.store]); ui.q = ''; ui.limit = 100; }
    ui.storeRoute = r.store || null;
    main.innerHTML = viewAlleShell();
    renderAlleList();
  }
  if (r.v === 'mehr') main.innerHTML = viewMehr();
  renderInstall();
}

// ---------- Merkliste ----------
function viewListe() {
  const now = todayNumber();
  const list = activeWatch(S.watch);
  let html = `<div class="section-head"><h2>Deine Merkliste</h2><a class="btn primary" href="#neu">+ Produkt</a></div>`;
  if (!S.canEdit) html += `<p class="hint-box">Zum Bearbeiten auf diesem Gerät einmal unter <a href="#mehr">Mehr</a> freischalten.</p>`;
  if (!list.length) return html + `<p class="empty">Noch nichts auf der Merkliste. Leg ein Produkt an, zum Beispiel „Butter“, und wähl die Marken aus, die du willst. Danach siehst du hier jeden Tag, wo es am günstigsten ist.</p>`;
  html += '<ul class="watch">' + list.map(w => {
    const st = watchStats(w, S.entries, S.current, now);
    const brands = w.brands && w.brands.length ? w.brands.join(', ') : 'Alle Marken';
    let right;
    if (st.best) {
      right = `<span class="tag">${formatPrice(st.best.p)}</span><span class="where">${esc(storeName(st.best.s))}</span>`;
    } else {
      const last = st.runs.length ? st.runs.reduce((m, r) => (r.d1 > m.d1 ? r : m)) : null;
      right = `<span class="small muted">Gerade nicht im Angebot${last ? `<br>zuletzt ${formatPrice(last.p)} am ${fmtDay(last.d1)}` : ''}</span>`;
    }
    return `<li><a class="watch-item" href="#p-${esc(w.id)}">
      <span class="wi-main"><strong>${esc(w.product)}</strong><span class="muted small">${esc(brands)}</span>${verdictBadge(st.verdict)}</span>
      <span class="wi-price">${right}</span></a></li>`;
  }).join('') + '</ul>';
  return html;
}

// ---------- Produktseite ----------
function viewProdukt(id) {
  const w = S.watch.find(x => x.id === id && !x.deleted);
  if (!w) return `<p class="empty">Dieses Produkt ist nicht mehr auf deiner Merkliste. <a href="#liste">Zur Merkliste</a></p>`;
  const now = todayNumber();
  const st = watchStats(w, S.entries, S.current, now);
  const brands = w.brands && w.brands.length ? w.brands.join(', ') : 'Alle Marken';
  const editLink = S.canEdit ? `<a class="btn" href="#edit-${esc(w.id)}">Bearbeiten</a>` : `<a class="btn" href="#mehr">Bearbeiten</a>`;

  let html = `<a class="back" href="#liste">← Merkliste</a>
    <div class="section-head"><div><h2 class="big">${esc(w.product)}</h2><p class="muted">${esc(brands)}${w.exclude && w.exclude.length ? ` · ohne ${esc(w.exclude.join(', '))}` : ''}</p></div>${editLink}</div>`;

  // Gerade im Angebot
  html += '<section class="card">';
  if (st.best) {
    const b = st.best;
    html += `<div class="best"><span class="tag big">${formatPrice(b.p)}</span>
      <div><span class="where strong">Am günstigsten bei ${esc(storeName(b.s))}</span>
      <span class="block">${esc(b.t)}</span>
      ${b.o ? `<span class="old">statt <s>${formatPrice(b.o)}</s></span>` : ''}</div></div>
      ${st.verdict ? `<p class="verdict ${st.verdict.level}">${esc(st.verdict.text)}</p>` : ''}`;
    const others = st.current.slice(1, 7);
    if (others.length) html += `<ul class="others">${others.map(o => `<li><span>${storeIcon(o.s)}${esc(storeName(o.s))}: ${esc(o.t)}</span><span class="p">${formatPrice(o.p)}</span></li>`).join('')}</ul>`;
  } else {
    html += `<p class="muted">Gerade in keinem Markt im Angebot.</p>`;
  }
  html += '</section>';

  // Verlauf
  html += `<div class="section-head"><h3>Preisverlauf</h3><div class="seg" role="group" aria-label="Zeitraum">
    ${[30, 90, 365].map(d => `<button type="button" data-act="range" data-range="${d}" aria-pressed="${ui.range === d}">${d === 365 ? '1 Jahr' : d + ' Tage'}</button>`).join('')}</div></div>`;
  html += '<section class="card">';
  if (!st.runs.length) {
    const inCatalog = S.catalog.some(e => matchWatch(w, e.t, e.b));
    html += `<p class="muted">${!IS_EXT && inCatalog
      ? 'Der Verlauf für dieses Produkt wird bei der nächsten Aktualisierung am Computer ergänzt.'
      : 'Noch kein Verlauf. Er wird ab jetzt mit jeder Aktualisierung aufgebaut, sobald das Produkt im Angebot ist.'}</p>`;
  } else {
    html += chart(st.runs, now, ui.range);
    html += `<dl class="stats">
      <div><dt>Tiefstpreis</dt><dd>${formatPrice(st.minRun.p)}</dd><span class="small muted">${esc(storeName(st.minRun.s))}, ${fmtDay(st.minRun.d0)}</span></div>
      <div><dt>Im Schnitt</dt><dd>${formatPrice(st.avg)}</dd><span class="small muted">wenn im Angebot</span></div>
      <div><dt>Zuletzt im Angebot</dt><dd>${st.lastOffer >= now ? 'gerade' : fmtDay(st.lastOffer)}</dd><span class="small muted">an ${st.coveredDays} von ${st.trackedDays} Tagen</span></div>
      <div><dt>Rhythmus</dt><dd>${st.interval ? `≈ ${st.interval} Tage` : '–'}</dd><span class="small muted">${st.interval ? 'zwischen zwei Angeboten' : 'noch zu wenig Daten'}</span></div>
    </dl>`;
  }
  html += '</section>';

  if (st.runs.length) {
    const past = [...st.runs].sort((a, b) => b.d0 - a.d0 || a.p - b.p).slice(0, 40);
    html += `<h3>Bisherige Angebote</h3><ul class="history">${past.map(r => `<li>
      <span class="h-date">${fmtDay(r.d0)}${r.d1 > r.d0 ? '–' + fmtDay(r.d1) : ''}</span>
      <span class="h-what"><span class="dot" style="background:${color(r.s)}"></span>${esc(storeName(r.s))} · ${esc(r.t)}</span>
      <span class="p">${formatPrice(r.p)}</span></li>`).join('')}</ul>`;
  }
  return html;
}

function chart(runs, now, range) {
  const start = now - range + 1;
  const rs = runs.filter(r => r.d1 >= start);
  if (!rs.length) return `<p class="muted">Im gewählten Zeitraum war das Produkt nicht im Angebot.</p>`;
  const avail = (document.querySelector('#main').clientWidth || 640) - 66;
  const W = Math.max(280, Math.min(720, avail)), H = W < 420 ? 200 : 240, L = 50, R = 8, T = 12, B = 28;
  let min = Math.min(...rs.map(r => r.p)), max = Math.max(...rs.map(r => r.p));
  if (max - min < 0.3) { min -= 0.15; max += 0.15; }
  const pad = (max - min) * 0.15;
  min = Math.max(0, min - pad); max += pad;
  const x = d => L + (d - start) / range * (W - L - R);
  const y = p => T + (max - p) / (max - min) * (H - T - B);
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = min + (max - min) * i / 3;
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${formatPrice(v)}</text>`;
  }
  for (let i = 0; i <= 3; i++) {
    const d = start + Math.round((range - 1) * i / 3);
    g += `<text class="ax" x="${x(d)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}">${fmtDay(d)}</text>`;
  }
  const bars = rs.map(r => {
    const x1 = x(Math.max(r.d0, start)), x2 = Math.max(x(r.d1 + 1), x1 + 4);
    return `<g><title>${esc(storeName(r.s))}: ${formatPrice(r.p)} (${fmtDay(r.d0)}–${fmtDay(r.d1)}) ${esc(r.t)}</title>
      <line x1="${x1 + 2}" x2="${x2 - 2}" y1="${y(r.p)}" y2="${y(r.p)}" stroke="${color(r.s)}" stroke-width="6" stroke-linecap="round"/></g>`;
  }).join('');
  const legend = [...new Set(rs.map(r => r.s))].map(s => `<span><span class="dot" style="background:${color(s)}"></span>${esc(storeName(s))}</span>`).join('');
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Preisverlauf der letzten ${range} Tage">${g}${bars}</svg></div>
    <div class="legend">${legend}</div>`;
}

// ---------- Anlegen / Bearbeiten ----------
function renderForm(id) {
  const key = id || 'neu';
  const main = $('#main');
  if (!S.canEdit) {
    main.innerHTML = `<a class="back" href="#liste">← Merkliste</a><p class="empty">Um die Merkliste am Handy zu bearbeiten, gib einmal deinen GitHub-Token ein. <a href="#mehr">Jetzt freischalten</a></p>`;
    return;
  }
  if (ui.formKey === key) return updateFormDynamic();
  const w = id ? S.watch.find(x => x.id === id && !x.deleted) : null;
  if (id && !w) { main.innerHTML = `<p class="empty">Produkt nicht gefunden. <a href="#liste">Zur Merkliste</a></p>`; return; }
  ui.formKey = key;
  ui.draft = { id: w ? w.id : null, createdAt: w ? w.createdAt : null, product: w ? w.product : ui.prefill, brands: new Set(w ? w.brands : []), exclude: w ? (w.exclude || []).join(', ') : '' };
  ui.prefill = '';
  main.innerHTML = `<a class="back" href="${w ? '#p-' + esc(w.id) : '#liste'}">← Zurück</a>
    <h2 class="big">${w ? 'Produkt bearbeiten' : 'Produkt hinzufügen'}</h2>
    <form id="watch-form" class="card form" autocomplete="off">
      <label for="f-product">Produkt</label>
      <input id="f-product" value="${esc(ui.draft.product)}" placeholder="z. B. Butter, Kaffee, Haferdrink" required>
      <p class="hint">Ein oder zwei Wörter reichen. Alle Wörter müssen im Angebotsnamen vorkommen.</p>

      <div class="label-row"><span class="label">Marken</span><span class="hint">Nichts ausgewählt = alle Marken</span></div>
      <div id="brand-box"></div>
      <div class="row"><input id="f-brand" placeholder="Andere Marke eintippen"><button class="btn" type="button" data-act="add-brand">Hinzufügen</button></div>

      <label for="f-exclude">Ausschließen <span class="hint">(optional, mit Komma trennen)</span></label>
      <input id="f-exclude" value="${esc(ui.draft.exclude)}" placeholder="z. B. Kekse, Brezel">

      <div id="preview" class="preview"></div>
      <p id="form-error" class="error" hidden></p>
      <div class="row-actions">
        <button class="btn primary" type="submit">Speichern</button>
        ${w ? '<button class="btn danger" type="button" data-act="delete">Von der Merkliste entfernen</button>' : ''}
      </div>
    </form>`;
  updateFormDynamic();
  if (!w) $('#f-product').focus();
}

function updateFormDynamic() {
  const d = ui.draft;
  if (!d || !$('#brand-box')) return;
  const product = d.product.trim();
  const exclude = splitList(d.exclude);
  const pool = [...new Map([...S.catalog, ...S.current.map(i => ({ t: i.t, b: i.b, s: i.s }))].map(e => [e.s + '|' + normalizeText(e.t), e])).values()];
  const box = $('#brand-box');
  if (product.length < 2) {
    box.innerHTML = '<p class="hint">Gib zuerst ein Produkt ein, dann erscheinen hier die Marken aus den Angeboten.</p>';
  } else {
    const cands = brandCandidates(product, exclude, pool).slice(0, 40);
    const known = new Set(cands.map(c => normalizeText(c.name)));
    const custom = [...d.brands].filter(b => !known.has(normalizeText(b))).map(b => ({ name: b, n: 0 }));
    const all = [...custom, ...cands];
    box.innerHTML = all.length
      ? `<div class="chips wrap-chips">${all.map(c => `<button type="button" class="chip" data-act="brand" data-brand="${esc(c.name)}" aria-pressed="${[...d.brands].some(b => normalizeText(b) === normalizeText(c.name))}">${esc(c.name)}${c.n ? `<span class="n">${c.n}</span>` : ''}</button>`).join('')}</div>`
      : '<p class="hint">Dazu gibt es bisher keine Angebote. Du kannst Marken trotzdem unten eintippen.</p>';
  }
  const w = { product, brands: [...d.brands], exclude };
  const matches = product.length >= 2 ? pool.filter(e => matchWatch(w, e.t, e.b)) : [];
  const uniq = [...new Map(matches.map(m => [normalizeText(m.t), m])).values()];
  $('#preview').innerHTML = product.length < 2 ? '' :
    `<p class="strong">${uniq.length ? `${uniq.length} passende Produkte in den Angeboten` : 'Gerade keine passenden Produkte in den Angeboten'}</p>
     ${uniq.length ? `<ul class="preview-list">${uniq.slice(0, 6).map(m => `<li>${esc(m.t)}</li>`).join('')}</ul>` : ''}`;
}

async function submitForm(e) {
  e.preventDefault();
  const d = ui.draft;
  const product = d.product.trim();
  if (!product) return;
  const now = Date.now();
  const w = { id: d.id || uid(), product, brands: [...d.brands], exclude: splitList(d.exclude), createdAt: d.createdAt || now, updatedAt: now };
  await saveWithFeedback(w, '#p-' + w.id);
}
async function saveWithFeedback(w, next) {
  const errEl = $('#form-error');
  const btns = document.querySelectorAll('#watch-form button');
  btns.forEach(b => (b.disabled = true));
  try {
    await DB.saveWatch(w);
    ui.formKey = null;
    location.hash = next;
    render();
  } catch (err) {
    if (errEl) { errEl.hidden = false; errEl.textContent = err.message; }
  } finally {
    btns.forEach(b => (b.disabled = false));
  }
}

// ---------- Alle Angebote ----------
function viewAlleShell() {
  const counts = {};
  S.current.forEach(i => { counts[i.s] = (counts[i.s] || 0) + 1; });
  let head = '';
  if (ui.stores.size === 1) {
    const sid = [...ui.stores][0];
    const hits = activeWatch(S.watch)
      .map(w => ({ w, m: S.current.filter(i => i.s === sid && matchWatch(w, i.t, i.b)).sort((a, b) => a.p - b.p)[0] }))
      .filter(h => h.m);
    head = `<h2 class="big store-title">${storeIcon(sid, true)}Angebote bei ${esc(storeName(sid))}</h2>
      ${hits.length ? `<section class="card store-hits"><h3 class="first">Von deiner Merkliste</h3><ul class="plain">${hits.map(h =>
        `<li><a class="hit-link" href="#p-${esc(h.w.id)}"><span><strong>${esc(h.w.product)}</strong><span class="block muted small">${esc(h.m.t)}</span></span><span class="tag">${formatPrice(h.m.p)}</span></a></li>`).join('')}</ul></section>`
      : `<p class="hint-box">Von deiner Merkliste ist hier gerade nichts im Angebot.</p>`}`;
  }
  return head + `<div class="search"><input id="q" type="search" value="${esc(ui.q)}" placeholder="Angebote durchsuchen" aria-label="Angebote durchsuchen"></div>
    <div class="chips">${S.stores.map(s => `<button class="chip" type="button" data-act="store" data-store="${s.id}" aria-pressed="${ui.stores.has(s.id)}">${storeIcon(s.id)}${esc(s.name)}<span class="n">${counts[s.id] || 0}</span></button>`).join('')}</div>
    ${S.stores.filter(s => s.error).map(s => `<p class="notice"><strong>${esc(s.name)}:</strong> ${esc(s.error)}</p>`).join('')}
    <ul id="offer-list" class="offers"></ul>
    <button id="more" class="btn wide" type="button" data-act="more" hidden>Mehr anzeigen</button>`;
}
function renderAlleList() {
  const watch = activeWatch(S.watch);
  const list = S.current.filter(i => (!ui.stores.size || ui.stores.has(i.s)) && (!ui.q || matchesKeyword(i.t, ui.q))).sort((a, b) => a.p - b.p);
  $('#offer-list').innerHTML = list.slice(0, ui.limit).map(i => {
    const onList = watch.some(w => matchWatch(w, i.t, i.b));
    return `<li class="offer">
      ${i.i ? `<img src="${esc(i.i)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="info"><span class="store">${storeIcon(i.s)}${esc(storeName(i.s))}${onList ? ' · <span class="on-list">auf deiner Merkliste</span>' : ''}</span>
        <span class="block">${esc(i.t)}</span>
        ${i.o ? `<span class="old">statt <s>${formatPrice(i.o)}</s></span>` : ''}</div>
      <span class="tag">${formatPrice(i.p)}</span>
      <button class="add" type="button" data-act="add-offer" data-title="${esc(i.t)}" aria-label="Zur Merkliste hinzufügen">+</button>
    </li>`;
  }).join('') || '<li class="offer muted">Keine Angebote gefunden.</li>';
  $('#more').hidden = list.length <= ui.limit;
}

// ---------- Mehr ----------
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function storeStatusHtml() {
  if (!S.stores.length) return '<p class="muted">Noch keine Daten.</p>';
  return `<ul class="plain">${S.stores.map(s => `<li><span>${storeIcon(s.id)}${esc(s.name)}</span>
    <span class="${s.error ? 'error-text' : 'muted'}">${s.error ? 'Fehler' : s.count + ' Angebote'}</span></li>`).join('')}</ul>`;
}

function viewMehr() {
  if (IS_EXT) {
    return `<h2 class="big">Mehr</h2>
      <section class="card"><h3 class="first">Märkte</h3>${storeStatusHtml()}
      <div class="row-actions"><a class="btn primary" href="dashboard.html">Einstellungen öffnen</a></div></section>`;
  }
  const installed = isStandalone();
  const install = installed ? '<p class="ok-text">Die App ist installiert.</p>'
    : isIOS()
      ? `<ol class="steps"><li>Diese Seite in <strong>Safari</strong> öffnen.</li><li>Unten auf <strong>Teilen</strong> tippen (Quadrat mit Pfeil).</li><li><strong>Zum Home-Bildschirm</strong> wählen und bestätigen.</li></ol>`
      : `<ol class="steps"><li>Diese Seite in <strong>Chrome</strong> öffnen.</li><li>Oben rechts auf <strong>⋮</strong> tippen.</li><li><strong>App installieren</strong> oder <strong>Zum Startbildschirm hinzufügen</strong> wählen.</li></ol>
         ${deferredPrompt ? '<button class="btn primary" type="button" data-act="install">Jetzt installieren</button>' : ''}`;
  const t = Web.token();
  return `<h2 class="big">Mehr</h2>
    <section class="card"><h3 class="first">Als App installieren</h3>${install}</section>

    <section class="card form">
      <h3 class="first">Merkliste bearbeiten</h3>
      ${S.canEdit
        ? `<p class="ok-text">Bearbeiten ist auf diesem Gerät freigeschaltet.</p>
           <div class="row-actions"><button class="btn" type="button" data-act="remove-token">Token von diesem Gerät löschen</button></div>`
        : `<p>Gib einmal denselben GitHub-Token ein wie in der Erweiterung. Er bleibt nur auf diesem Gerät gespeichert und wird nirgends hochgeladen.</p>
           <label for="tok">GitHub-Token</label>
           <input id="tok" type="password" placeholder="github_pat_…" autocomplete="off">
           <p id="tok-status" class="hint"></p>
           <div class="row-actions"><button class="btn primary" type="button" data-act="save-token">Freischalten</button></div>`}
    </section>

    <section class="card"><h3 class="first">Datenstand</h3>
      <p class="muted small">${S.updatedAt ? 'Zuletzt aktualisiert ' + esc(fmtTime(S.updatedAt)) + '. ' : ''}Aktualisiert wird täglich über die Chrome-Erweiterung am Computer.</p>
      ${storeStatusHtml()}</section>

    <section class="card"><h3 class="first">Datenschutz</h3>
      <p class="muted small">Die App enthält nur Supermarkt-Angebote, deine Merkliste und den Preisverlauf. Keine Namen, Adressen oder Zugangsdaten. Wer die Adresse nicht kennt, findet die Seite nicht.</p></section>`;
}

// Installationshinweis (nur Handy-Seite, nicht installiert)
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; renderInstall(); });
function renderInstall() {
  const box = $('#install');
  if (!box) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('radar-install-hidden') === '1'; } catch {}
  if (IS_EXT || EMBED || isStandalone() || dismissed || route().v === 'mehr') { box.innerHTML = ''; return; }
  const text = isIOS() ? 'Tipp: In Safari auf <strong>Teilen → Zum Home-Bildschirm</strong>, dann startet Radar wie eine App.'
    : 'Installier Radar als App, dann startet es ohne Browserleiste.';
  box.innerHTML = `<div class="install-banner"><p>${text}</p>
    ${!isIOS() && deferredPrompt ? '<button class="btn primary" type="button" data-act="install">Installieren</button>' : '<a class="btn" href="#mehr">Anleitung</a>'}
    <button class="icon-btn" type="button" data-act="hide-install" aria-label="Hinweis ausblenden">×</button></div>`;
}
async function doInstall() {
  if (!deferredPrompt) { location.hash = '#mehr'; return; }
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => {});
  deferredPrompt = null;
  render();
}

async function saveToken() {
  const t = $('#tok').value.trim();
  const st = $('#tok-status');
  if (!t) return;
  Web.setToken(t);
  st.textContent = 'Wird geprüft …';
  try {
    const r = await Web.api('watchlist.json');
    if (r.status === 401) throw new Error(ghMsg(401));
    if (!r.ok && r.status !== 404) throw new Error(ghMsg(r.status));
    S.canEdit = true;
    S.watch = await Web.loadWatch();
    render();
  } catch (e) {
    Web.setToken('');
    st.textContent = e.message;
  }
}

// ================= Ereignisse =================
$('#main').addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'range') { ui.range = Number(el.dataset.range); render(); }
  if (act === 'store') {
    const id = el.dataset.store;
    ui.stores.has(id) ? ui.stores.delete(id) : ui.stores.add(id);
    ui.limit = 100;
    if (route().store) history.replaceState(null, '', '#alle');
    ui.storeRoute = null;
    render();
  }
  if (act === 'more') { ui.limit += 100; renderAlleList(); }
  if (act === 'add-offer') { ui.prefill = el.dataset.title; ui.formKey = null; if (location.hash === '#neu') render(); else location.hash = '#neu'; }
  if (act === 'brand') {
    const name = el.dataset.brand;
    const ex = [...ui.draft.brands].find(b => normalizeText(b) === normalizeText(name));
    ex ? ui.draft.brands.delete(ex) : ui.draft.brands.add(name);
    updateFormDynamic();
  }
  if (act === 'add-brand') {
    const inp = $('#f-brand');
    for (const b of splitList(inp.value)) ui.draft.brands.add(b);
    inp.value = '';
    updateFormDynamic();
  }
  if (act === 'delete') {
    const w = S.watch.find(x => x.id === ui.draft.id);
    if (w && confirm(`„${w.product}“ von der Merkliste entfernen?`)) await saveWithFeedback({ ...w, deleted: true, updatedAt: Date.now() }, '#liste');
  }
  if (act === 'save-token') saveToken();
  if (act === 'remove-token') { Web.setToken(''); S.canEdit = false; render(); }
  if (act === 'install') doInstall();
});
$('#main').addEventListener('input', e => {
  if (e.target.id === 'q') { ui.q = e.target.value; ui.limit = 100; renderAlleList(); }
  if (e.target.id === 'f-product') { ui.draft.product = e.target.value; updateFormDynamic(); }
  if (e.target.id === 'f-exclude') { ui.draft.exclude = e.target.value; updateFormDynamic(); }
});
$('#main').addEventListener('keydown', e => {
  if (e.target.id === 'f-brand' && e.key === 'Enter') { e.preventDefault(); $('[data-act="add-brand"]').click(); }
});
$('#main').addEventListener('submit', e => { if (e.target.id === 'watch-form') submitForm(e); });
$('#install').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'install') doInstall();
  if (el.dataset.act === 'hide-install') { try { localStorage.setItem('radar-install-hidden', '1'); } catch {} renderInstall(); }
});
$('#top-actions').addEventListener('click', e => {
  if (e.target.closest('[data-act="reload"]')) { $('#status').textContent = 'Wird geladen …'; reload(); return; }
  if (!e.target.closest('[data-act="refresh"]')) return;
  S.running = true;
  render();
  chrome.runtime.sendMessage({ type: 'runNow' }, () => reload());
});
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (route().v === 'produkt') render(); }, 200);
});

async function reload() {
  try { await DB.load(); } catch (e) { S.error = 'Daten konnten nicht geladen werden.'; }
  render();
}
if (IS_EXT) {
  let t;
  chrome.storage.onChanged.addListener(() => { clearTimeout(t); t = setTimeout(reload, 300); });
}
reload();
if (!IS_EXT && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => { if (!IS_EXT && document.visibilityState === 'visible' && route().v !== 'form') reload(); });
