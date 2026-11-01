// Utilita' condivise: mesi, formattazione, colori per impianto, metriche.

export const MESI = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio",
  "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
export const MESI_BREVI = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];

export const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

const nf = (d) => new Intl.NumberFormat("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: "always" });
export const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : nf(d).format(v));

// Colore = identita' dell'impianto: dipende dall'id, mai dalla posizione in classifica.
// 8 slot validati (adjacent CVD); con piu' di 8 impianti si ricicla e servono le etichette.
export function seriesColor(index) {
  const slot = (index % 8) + 1;
  return cssVar(`--series-${slot}`);
}
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Arricchisce le letture con resa specifica e resa giornaliera. */
export function enrich(readings) {
  return readings.map((r) => ({
    ...r,
    spec: r.kwh / r.kwp,                 // kWh/kWp nel mese
    specDay: r.kwh / r.kwp / r.days,     // kWh/kWp al giorno
    daily: r.kwh / r.days,               // kWh al giorno
  }));
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Indice di rendimento: per ogni mese, resa giornaliera dell'impianto rispetto alla
 * mediana del gruppo in quel mese (100 = in linea col gruppo). Elimina l'effetto
 * stagione e dei mesi parziali, quindi e' confrontabile anche tra impianti entrati a meta' anno.
 * Restituisce Map "pid-y-m" -> indice. I mesi con un solo impianto non hanno indice.
 */
export function monthlyIndex(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const key = `${r.year}-${r.month}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  const out = new Map();
  for (const list of byMonth.values()) {
    if (list.length < 2) continue;
    const med = median(list.map((r) => r.specDay));
    for (const r of list) out.set(`${r.plant_id}-${r.year}-${r.month}`, (r.specDay / med) * 100);
  }
  return out;
}

/** Riepilogo annuo per impianto. */
export function yearSummary(rows, idx, year) {
  const per = new Map();
  for (const r of rows) {
    if (r.year !== year) continue;
    const s = per.get(r.plant_id) ?? { plant_id: r.plant_id, kwh: 0, spec: 0, days: 0, months: 0, idx: [] };
    s.kwh += r.kwh;
    s.spec += r.spec;
    s.days += r.days;
    s.months += 1;
    s.kwp = r.kwp; // ultimo valore (le righe sono ordinate per mese)
    const i = idx.get(`${r.plant_id}-${r.year}-${r.month}`);
    if (i != null) s.idx.push(i);
    per.set(r.plant_id, s);
  }
  return [...per.values()].map((s) => ({
    ...s,
    specDay: s.spec / s.days,
    index: s.idx.length ? s.idx.reduce((a, b) => a + b, 0) / s.idx.length : null,
  }));
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
