import { visitStats, getEntryActivity, getPlants, MODE } from "./api.js";
import { MESI, fmt, cssVar, esc } from "./common.js";
import { track, isTrackingOff, setTrackingOff } from "./track.js";

track("statistiche");

const $ = (s) => document.querySelector(s);
const state = { days: 30, when: "hours", stats: null, plants: [], activity: [] };
const charts = {};

const PAGES = { dashboard: "Dashboard", dati: "Dati", inserisci: "Inserisci", statistiche: "Statistiche" };
const DEVICES = { mobile: "Telefono", tablet: "Tablet", desktop: "Computer" };
const WEEKDAYS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
const TZ = "Europe/Rome";

const dayFmt = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short", timeZone: "UTC" });
const dateFmt = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const dtFmt = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const n = (v) => fmt(v, 0);
const plural = (v, one, many) => `${n(v)} ${v === 1 ? one : many}`;

function chartDefaults() {
  const C = window.Chart;
  C.defaults.font.family = cssVar("--font");
  C.defaults.font.size = 12;
  C.defaults.color = cssVar("--muted");
  C.defaults.borderColor = cssVar("--grid");
  C.defaults.animation.duration = 250;
  const t = C.defaults.plugins.tooltip;
  t.backgroundColor = cssVar("--surface");
  t.titleColor = cssVar("--text");
  t.bodyColor = cssVar("--text-2");
  t.borderColor = cssVar("--border");
  t.borderWidth = 1;
  t.padding = 10;
  t.boxPadding = 4;
  t.usePointStyle = true;
  t.cornerRadius = 8;
  C.defaults.plugins.legend.display = false;
}

const axis = (extra = {}) => ({
  grid: { color: cssVar("--grid"), drawTicks: false },
  border: { color: cssVar("--axis") },
  ticks: { padding: 6, color: cssVar("--muted") },
  ...extra,
});
const countAxis = () => axis({ beginAtZero: true, ticks: { padding: 6, color: cssVar("--muted"), precision: 0 } });

function draw(id, config) {
  charts[id]?.destroy();
  const old = document.getElementById(id);
  const canvas = document.createElement("canvas"); // canvas nuovo a ogni render
  canvas.id = id;
  canvas.setAttribute("aria-label", old.getAttribute("aria-label"));
  old.replaceWith(canvas);
  charts[id] = new window.Chart(canvas, config);
}

/* ---------------- riquadri ---------------- */

function renderTiles() {
  const s = state.stats;
  const perVisitor = s.visitors ? s.visits / s.visitors : 0;
  const tiles = [
    { k: "Visite", v: n(s.visits), sub: `${fmt(perVisitor, 1)} per visitatore` },
    { k: "Visitatori", v: n(s.visitors), sub: `${plural(s.new_visitors, "nuovo", "nuovi")} nel periodo` },
    { k: "Oggi", v: n(s.today_visits), sub: plural(s.today_visits, "visita", "visite") + " da mezzanotte" },
    { k: "Da sempre", v: n(s.total_all), sub: s.first_visit ? `${plural(s.visitors_all, "visitatore", "visitatori")} dal ${dateFmt.format(new Date(s.first_visit))}` : "nessuna visita ancora" },
  ];
  $("#tiles").innerHTML = tiles.map((t) =>
    `<div class="tile"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="sub">${esc(t.sub)}</div></div>`).join("");
}

/* ---------------- andamento ---------------- */

function renderDaily() {
  const s = state.stats;
  const weekly = s.days > 90;
  const rows = weekly ? s.weekly : s.daily;
  const key = weekly ? "week" : "day";
  const labels = rows.map((r) => dayFmt.format(new Date(r[key] + "T00:00:00Z")));
  $("#daily-title").textContent = weekly ? "Visite per settimana" : "Visite al giorno";
  $("#daily-sub").textContent = weekly
    ? "Ogni barra è una settimana (da lunedì). Visitatori = browser diversi nella settimana."
    : "Visitatori = browser diversi nel giorno";
  const c1 = cssVar("--series-1"), c2 = cssVar("--series-2");
  draw("c-daily", {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "Visite", data: rows.map((r) => r.visits), backgroundColor: c1,
          borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "start", maxBarThickness: 28, order: 2 },
        { type: "line", label: "Visitatori", data: rows.map((r) => r.visitors), borderColor: c2, backgroundColor: c2,
          borderWidth: 2, pointRadius: rows.length > 40 ? 0 : 3, pointHoverRadius: 5, tension: 0.25, order: 1 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: axis({ grid: { display: false }, ticks: { color: cssVar("--muted"), maxRotation: 0, autoSkipPadding: 12 } }),
        y: countAxis(),
      },
      plugins: { tooltip: { callbacks: { title: (it) => (weekly ? `Settimana dal ${it[0].label}` : it[0].label) } } },
    },
  });
  $("#daily-legend").innerHTML =
    `<span><i style="--c:${c1};height:8px;width:10px"></i>Visite</span><span><i style="--c:${c2}"></i>Visitatori</span>`;
}

/* ---------------- quando ---------------- */

function renderWhen() {
  const s = state.stats;
  const hours = state.when === "hours";
  const data = hours ? s.hours : s.weekdays;
  $("#when-sub").textContent = hours ? "Visite per ora del giorno (ora italiana)" : "Visite per giorno della settimana";
  draw("c-when", {
    type: "bar",
    data: {
      labels: hours ? data.map((_, h) => String(h)) : WEEKDAYS,
      datasets: [{ label: "Visite", data, backgroundColor: cssVar("--series-1"),
        borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "start", maxBarThickness: 36 }],
    },
    options: {
      maintainAspectRatio: false,
      scales: { x: axis({ grid: { display: false } }), y: countAxis() },
      plugins: { tooltip: { callbacks: { title: (it) => (hours ? `Dalle ${it[0].label}:00 alle ${it[0].label}:59` : it[0].label) } } },
    },
  });
}

/* ---------------- liste a barre ---------------- */

function barList(el, items, empty) {
  if (!items.length) { el.innerHTML = `<p class="empty-msg small">${empty}</p>`; return; }
  const max = Math.max(...items.map((i) => i.value), 1);
  el.innerHTML = `<ul class="barlist">${items.map((i) => `
    <li>
      <span class="bl-label">${esc(i.label)}</span>
      <span class="bl-track"><span class="bl-fill" style="width:${(i.value / max) * 100}%"></span></span>
      <span class="bl-val">${n(i.value)}${i.extra ? `<small>${esc(i.extra)}</small>` : ""}</span>
    </li>`).join("")}</ul>`;
}

function renderLists() {
  const s = state.stats;
  barList($("#pages"), s.pages.map((p) => ({ label: PAGES[p.page] ?? p.page, value: p.visits, extra: plural(p.visitors, "visitatore", "visitatori") })),
    "Nessuna visita nel periodo");
  barList($("#devices"), s.devices.map((d) => ({ label: DEVICES[d.device] ?? d.device, value: d.visits, extra: plural(d.visitors, "visitatore", "visitatori") })),
    "Nessuna visita nel periodo");
  barList($("#referrers"), s.referrers.map((r) => ({ label: r.referrer, value: r.visits })),
    "Nessuna visita arrivata da un link esterno: chi ha il sito nei preferiti o digita l'indirizzo non compare qui");
}

/* ---------------- inserimenti ---------------- */

function renderEntries() {
  const el = $("#entries");
  // L'import iniziale dallo sheet ha salvato decine di righe nello stesso minuto: non sono inserimenti dal sito.
  const perMinute = new Map();
  for (const a of state.activity) {
    const m = a.updated_at.slice(0, 16);
    perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
  }
  const real = state.activity.filter((a) => perMinute.get(a.updated_at.slice(0, 16)) < 20);
  const since = Date.now() - state.days * 864e5;
  const name = (id) => state.plants.find((p) => p.id === id)?.name ?? `#${id}`;

  const rows = state.plants.map((p) => {
    const mine = real.filter((a) => a.plant_id === p.id);
    return { name: p.name, last: mine[0], inPeriod: mine.filter((a) => Date.parse(a.updated_at) >= since).length };
  }).sort((a, b) => (b.last ? Date.parse(b.last.updated_at) : 0) - (a.last ? Date.parse(a.last.updated_at) : 0));

  $("#entries-sub").textContent = real.length
    ? `Letture salvate o modificate dal sito (escluso l'import iniziale dallo sheet) · ultima: ${name(real[0].plant_id)}, ${dtFmt.format(new Date(real[0].updated_at))}`
    : "Letture salvate o modificate dal sito (escluso l'import iniziale dallo sheet)";
  el.innerHTML = `<div class="table-wrap plain"><table class="data static">
    <thead><tr><th>Impianto</th><th>Ultimo inserimento</th><th>Mese inserito</th><th class="n">Nel periodo</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.name)}</td>
      <td>${r.last ? dtFmt.format(new Date(r.last.updated_at)) : '<span class="muted">mai dal sito</span>'}</td>
      <td>${r.last ? `${MESI[r.last.month - 1]} ${r.last.year}` : '<span class="muted">—</span>'}</td>
      <td class="n">${r.inPeriod || '<span class="muted">0</span>'}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

/* ---------------- caricamento ---------------- */

function renderAll() {
  if (!state.stats) return;
  renderTiles();
  renderDaily();
  renderWhen();
  renderLists();
  renderEntries();
}

async function load() {
  $("#err").classList.remove("show");
  try {
    state.stats = await visitStats(state.days);
    renderAll();
  } catch (e) {
    $("#err").textContent = `Impossibile caricare le statistiche: ${e.message}`;
    $("#err").classList.add("show");
  }
}

function seg(host, attr, onPick) {
  host.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      host.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      onPick(b.dataset[attr]);
    };
  });
}

async function init() {
  chartDefaults();
  const nt = $("#notrack");
  nt.checked = isTrackingOff();
  nt.onchange = () => setTrackingOff(nt.checked);
  seg($("#period"), "d", (d) => { state.days = +d; load(); });
  seg($("#when"), "w", (w) => { state.when = w; renderWhen(); });

  if (MODE !== "supabase") {
    $("#err").textContent = "Le statistiche delle visite funzionano solo con Supabase (in modalità locale non si registra nulla).";
    $("#err").classList.add("show");
    return;
  }
  try {
    [state.plants, state.activity] = await Promise.all([getPlants(), getEntryActivity()]);
  } catch { /* la tabella inserimenti resta vuota */ }
  await load();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { chartDefaults(); renderAll(); });
}

init();
