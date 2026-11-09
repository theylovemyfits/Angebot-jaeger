// Märkte, Einstellungen (Erweiterung) und Farben
const DEFAULT_STORES = [
  { id: 'aldi-sued', name: 'Aldi Süd',  url: 'https://www.aldi-sued.de/de/angebote.html', enabled: true },
  { id: 'aldi-nord', name: 'Aldi Nord', url: 'https://www.aldi-nord.de/angebote.html', enabled: true },
  { id: 'lidl',      name: 'Lidl',      url: 'https://www.lidl.de/', enabled: true },
  { id: 'rewe',      name: 'REWE',      url: 'https://www.rewe.de/angebote/', enabled: true },
  { id: 'edeka',     name: 'Edeka',     url: 'https://www.edeka.de/eh/angebote.jsp', enabled: true },
  { id: 'kaufland',  name: 'Kaufland',  url: 'https://filiale.kaufland.de/angebote/aktuelle-woche.html', enabled: true },
  { id: 'penny',     name: 'Penny',     url: 'https://www.penny.de/angebote', enabled: true },
  { id: 'netto',     name: 'Netto',     url: 'https://www.netto-online.de/filialangebote', enabled: true }
];
const STORE_COLORS = {
  'aldi-sued': '#2563EB', 'aldi-nord': '#0891B2', 'lidl': '#CA8A04', 'rewe': '#DC2626',
  'edeka': '#7C3AED', 'kaufland': '#DB2777', 'penny': '#059669', 'netto': '#EA580C'
};
const DEFAULT_SETTINGS = { hour: 7, stores: DEFAULT_STORES, mobile: {} };

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!settings.mobile) settings.mobile = {};
  const ids = new Set(settings.stores.map(s => s.id));
  for (const d of DEFAULT_STORES) if (!ids.has(d.id)) settings.stores.push({ ...d });
  return settings;
}

function githubPageUrl(repo) {
  const [owner, name] = String(repo || '').trim().split('/');
  if (!owner || !name) return null;
  const o = owner.toLowerCase();
  return name.toLowerCase() === o + '.github.io' ? `https://${o}.github.io/` : `https://${o}.github.io/${name}/`;
}
