import { getPlants, getReadings, MODE, resetLocal } from "./api.js";
import {
  MESI, MESI_BREVI, fmt, seriesColor, cssVar, enrich, monthlyIndex, periodSummary, esc,
} from "./common.js";
import { createMultiSelect } from "./multiselect.js";

const $ = (s) => document.querySelector(s);
const tip = $("#tip");

const UNITS = {
  index: { label: "Indice di rendimento", short: "indice", dec: 0 },
  spec: { label: "kWh/kWp", short: "kWh/kWp", dec: 1 },
  specDay: { label: "kWh/kWp al giorno", short: "kWh/kWp/g", dec: 2 },
  kwh: { label: "kWh", short: "kWh", dec: 0 },
};
const TYPE_UNITS = {
  monthly: ["spec", "specDay", "kwh", "index"],
  yoy: ["spec", "specDay", "kwh"],
  cum: ["kwh", "spec"],
  rank: ["index", "spec", "specDay", "kwh"],
  heat: ["index", "spec", "specDay", "kwh"],
};
const QUARTERS = { 1: [1, 2, 3], 2: [4, 5, 6], 3: [7, 8, 9], 4: [10, 11, 12] };
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const state = {
  plants: [],
  rows: [],
  idx: new Map(),
  years: [],
  year: null,
  plantSel: new Set(),
  months: new Set(ALL_MONTHS),
  type: "monthly",
  unit: "spec",
  yoyPlant: null,
  highlight: null,
};
let chart = null;
let msMonths, msPlants;

/* ---------------- helpers ---------------- */

const plantName = (id) => state.plants.find((p) => p.id === id)?.name ?? `#${id}`;
const plantColor = (id) => seriesColor(state.plants.findIndex((p) => p.id === id));
const visiblePlants = () => state.plants.filter((p) => state.plantSel.has(p.id));
const monthList = () => ALL_MONTHS.filter((m) => state.months.has(m));
const rowAt = (pid, y, m) => state.rows.find((r) => r.plant_id === pid && r.year === y && r.month === m);
const idxOf = (r) => state.idx.get(`${r.plant_id}-${r.year}-${r.month}`) ?? null;
const valueOf = (r, unit) => (r ? (unit === "index" ? idxOf(r) : r[unit]) : null);

function periodLabel() {
  const ms = monthList();
  const q = Object.entries(QUARTERS).find(([, v]) => v.length === ms.length && v.every((m) => state.months.has(m)));
  if (ms.length === 12) return `${state.year}`;
  if (q) return `T${q[0]} ${state.year}`;
  if (ms.length === 0) return `${state.year} · nessun mese`;
  const contiguous = ms.every((m, i) => i === 0 || m === ms[i - 1] + 1);
  if (contiguous && ms.length > 1) return `${MESI_BREVI[ms[0] - 1]}–${MESI_BREVI[ms.at(-1) - 1]} ${state.year}`;
  return `${ms.map((m) => MESI_BREVI[m - 1]).join(", ")} ${state.year}`;
}

function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.classList.add("show");
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > innerWidth - 8) left = x - w - 14;
  if (top + h > innerHeight - 8) top = y - h - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}
const hideTip = () => tip.classList.remove("show");

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

function axis(extra = {}) {
  return {
    grid: { color: cssVar("--grid"), drawTicks: false },
    border: { color: cssVar("--axis") },
    ticks: { padding: 6, color: cssVar("--muted") },
    ...extra,
  };
}

/** Svuota l'area grafico e restituisce un canvas nuovo (mai riusato tra un grafico e l'altro). */
function freshCanvas(label) {
  chart?.destroy();
  chart = null;
  hideTip();
  $("#chart-area").innerHTML = `<div class="chart"><canvas aria-label="${esc(label)}"></canvas></div>`;
  return $("#chart-area canvas");
}

function legend(items, hoverable = false) {
  const el = $("#chart-legend");
  el.innerHTML = items.map((d) =>
    `<span ${d.pid != null ? `data-pid="${d.pid}"` : ""} style="--c:${d.color}"><i></i>${esc(d.label)}</span>`).join("");
  if (!hoverable) return;
  el.querySelectorAll("span[data-pid]").forEach((s) => {
    s.onmouseenter = () => setHighlight(+s.dataset.pid);
    s.onmouseleave = () => setHighlight(null);
  });
}

function emptyChart(msg) {
  chart?.destroy();
  chart = null;
  $("#chart-area").innerHTML = `<p class="empty-msg">${esc(msg)}</p>`;
  $("#chart-legend").innerHTML = "";
}

/* ---------------- filtri ---------------- */

function syncQuarter() {
  const q = $("#quarter");
  const ms = monthList();
  if (ms.length === 12) q.value = "all";
  else {
    const hit = Object.entries(QUARTERS).find(([, v]) => v.length === ms.length && v.every((m) => state.months.has(m)));
    q.value = hit ? hit[0] : "custom";
  }
}

function buildFilters() {
  const ysel = $("#year");
  ysel.innerHTML = state.years.slice().reverse().map((y) => `<option>${y}</option>`).join("");
  ysel.value = state.year;
  ysel.onchange = () => { state.year = +ysel.value; renderAll(); };

  $("#quarter").onchange = (e) => {
    const v = e.target.value;
    state.months = new Set(v === "all" ? ALL_MONTHS : QUARTERS[v] ?? ALL_MONTHS);
    msMonths.set(state.months);
    renderAll();
  };

  msMonths = createMultiSelect($("#ms-months"), {
    label: "Mesi",
    unit: "mesi",
    options: ALL_MONTHS.map((m) => ({ value: m, label: MESI[m - 1], short: MESI_BREVI[m - 1] })),
    selected: state.months,
    onChange: (s) => { state.months = s; syncQuarter(); renderAll(); },
  });

  msPlants = createMultiSelect($("#ms-plants"), {
    label: "Impianti",
    unit: "impianti",
    options: state.plants.map((p) => ({ value: p.id, label: p.name, color: plantColor(p.id) })),
    selected: state.plantSel,
    onChange: (s) => { state.plantSel = s; renderAll(); },
  });

  $("#chart-type").value = state.type;
  $("#chart-type").onchange = (e) => { state.type = e.target.value; state.unit = TYPE_UNITS[state.type][0]; renderChart(); };
  $("#chart-unit").onchange = (e) => { state.unit = e.target.value; renderChart(); };

  const yp = $("#yoy-plant");
  yp.innerHTML = state.plants.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  yp.value = state.yoyPlant;
  yp.onchange = () => { state.yoyPlant = +yp.value; renderChart(); };
}

/* ---------------- classifica (tabella) ---------------- */

function renderRanking() {
  $("#rank-title").textContent = `Classifica · ${periodLabel()}`;
  const sum = periodSummary(state.rows, state.idx, state.year, state.months)
    .filter((s) => state.plantSel.has(s.plant_id))
    .sort((a, b) => (b.index ?? -Infinity) - (a.index ?? -Infinity) || b.specDay - a.specDay);
  const nMonths = state.months.size;

  const body = sum.map((s, i) => {
    // confronto con l'anno precedente sugli stessi mesi disponibili in entrambi
    let a = 0, b = 0;
    for (const r of state.rows) {
      if (r.plant_id !== s.plant_id || r.year !== state.year || !state.months.has(r.month)) continue;
      const p = rowAt(s.plant_id, state.year - 1, r.month);
      if (p) { a += r.spec; b += p.spec; }
    }
    const d = b ? (a / b - 1) * 100 : null;
    const delta = d == null ? `<span class="muted">–</span>`
      : `<span class="${d >= 0 ? "delta-up" : "delta-down"}">${d >= 0 ? "▲" : "▼"} ${fmt(Math.abs(d), 1)}%</span>`;
    let bar = "";
    if (s.index != null) {
      const t = Math.max(-1, Math.min(1, (s.index - 100) / 25));
      const w = Math.abs(t) * 50;
      bar = `<span class="ibar"><span class="ibar-fill ${t >= 0 ? "pos" : "neg"}" style="${t >= 0 ? "left:50%" : `right:50%`};width:${w}%"></span></span>`;
    }
    return `<tr>
      <td class="pos-cell">${s.index != null ? i + 1 : ""}</td>
      <td><span class="sw" style="--c:${plantColor(s.plant_id)}"></span>${esc(plantName(s.plant_id))}</td>
      <td class="n"><div class="idx-cell"><b>${fmt(s.index, 0)}</b>${bar}</div></td>
      <td class="n">${fmt(s.spec, 0)}</td>
      <td class="n hide-sm">${fmt(s.specDay, 2)}</td>
      <td class="n hide-sm">${fmt(s.kwh, 0)}</td>
      <td class="n hide-sm">${s.months}/${nMonths}</td>
      <td class="n">${delta}</td>
    </tr>`;
  }).join("");

  $("#ranking").innerHTML = `<thead><tr>
      <th>#</th><th>Impianto</th><th class="n">Indice</th><th class="n">kWh/kWp</th>
      <th class="n hide-sm">kWh/kWp/g</th><th class="n hide-sm">kWh</th><th class="n hide-sm">Mesi</th>
      <th class="n" title="kWh/kWp rispetto agli stessi mesi dell'anno precedente">vs ${state.year - 1}</th>
    </tr></thead>
    <tbody>${body || `<tr><td colspan="8" class="muted">Nessun dato nel periodo selezionato.</td></tr>`}</tbody>`;
}

/* ---------------- grafico unico ---------------- */

function renderChart() {
  const units = TYPE_UNITS[state.type];
  if (!units.includes(state.unit)) state.unit = units[0];
  const us = $("#chart-unit");
  us.innerHTML = units.map((u) => `<option value="${u}">${UNITS[u].label}</option>`).join("");
  us.value = state.unit;
  const perPlant = state.type === "yoy" || state.type === "cum";
  $("#yoy-plant-field").classList.toggle("hidden", !perPlant);

  if (state.months.size === 0 && state.type !== "cum") return emptyChart("Seleziona almeno un mese.");
  if (!perPlant && state.plantSel.size === 0) return emptyChart("Seleziona almeno un impianto.");
  ({ monthly: renderMonthly, yoy: renderYoy, cum: renderCumulative, rank: renderRankChart, heat: renderHeat })[state.type]();
}

function lineDataset(label, data, color, extra = {}) {
  return {
    label, data, borderColor: color, backgroundColor: color, baseColor: color,
    borderWidth: 2, pointRadius: 3, pointHoverRadius: 5,
    pointBorderColor: cssVar("--surface"), pointBorderWidth: 2,
    tension: 0.25, spanGaps: false, ...extra,
  };
}

function lineOptions(unit, titleFn) {
  const u = UNITS[unit];
  return {
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: axis({ grid: { display: false } }),
      y: axis({ beginAtZero: unit !== "index", title: { display: true, text: u.label, color: cssVar("--muted") } }),
    },
    plugins: {
      tooltip: {
        itemSort: (a, b) => b.parsed.y - a.parsed.y,
        callbacks: {
          title: titleFn,
          label: (it) => ` ${it.dataset.label}: ${fmt(it.parsed.y, u.dec)} ${u.short === "indice" ? "" : u.short}`,
        },
      },
    },
  };
}

function renderMonthly() {
  const u = state.unit, ms = monthList();
  $("#chart-title").textContent = `Andamento mensile · ${periodLabel()}`;
  $("#chart-sub").textContent = {
    spec: "kWh prodotti per kWp installato in ciascun mese",
    specDay: "kWh/kWp medi al giorno: confronto equo anche con mesi parziali",
    kwh: "Produzione assoluta: dipende dalla taglia dell'impianto",
    index: "100 = mediana di tutti gli impianti in quel mese",
  }[u];
  const datasets = visiblePlants().map((p) => ({
    ...lineDataset(p.name, ms.map((m) => valueOf(rowAt(p.id, state.year, m), u)), plantColor(p.id)),
    pid: p.id,
  }));
  const canvas = freshCanvas("Andamento mensile per impianto");
  chart = new window.Chart(canvas, {
    type: "line",
    data: { labels: ms.map((m) => MESI_BREVI[m - 1]), datasets },
    options: lineOptions(u, (it) => `${MESI[ms[it[0].dataIndex] - 1]} ${state.year}`),
  });
  legend(datasets.map((d) => ({ label: d.label, color: d.baseColor, pid: d.pid })), true);
  applyHighlight();
}

function setHighlight(pid) { state.highlight = pid; applyHighlight(); }
function applyHighlight() {
  if (!chart || state.type !== "monthly") return;
  const grey = cssVar("--axis");
  for (const d of chart.data.datasets) {
    const on = state.highlight == null || d.pid === state.highlight;
    d.borderColor = on ? d.baseColor : grey;
    d.backgroundColor = d.borderColor;
    d.borderWidth = state.highlight === d.pid ? 3 : 2;
    d.order = state.highlight === d.pid ? 0 : 1;
  }
  chart.update("none");
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
function yearRamp(n) {
  const ramp = isDark()
    ? ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"]
    : ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"];
  return Array.from({ length: n }, (_, i) => ramp[Math.max(0, ramp.length - n + i)]);
}

function renderYoy() {
  const u = state.unit, ms = monthList(), pid = state.yoyPlant;
  $("#chart-title").textContent = `Anno su anno · ${plantName(pid)}`;
  $("#chart-sub").textContent = `${UNITS[u].label} negli stessi mesi di anni diversi (l'anno selezionato in alto non si applica)`;
  const years = [...new Set(state.rows.filter((r) => r.plant_id === pid).map((r) => r.year))].sort();
  const colors = yearRamp(years.length);
  const datasets = years.map((y, i) =>
    lineDataset(String(y), ms.map((m) => valueOf(rowAt(pid, y, m), u)), colors[i],
      { borderWidth: y === state.year ? 3 : 2 }));
  const canvas = freshCanvas(`Anno su anno ${plantName(pid)}`);
  chart = new window.Chart(canvas, {
    type: "line",
    data: { labels: ms.map((m) => MESI_BREVI[m - 1]), datasets },
    options: lineOptions(u, (it) => `${plantName(pid)} · ${MESI[ms[it[0].dataIndex] - 1]}`),
  });
  legend(datasets.map((d) => ({ label: d.label, color: d.baseColor })));
}

/** Cumulato da gennaio, per anno. null nei mesi senza lettura (la linea si interrompe). */
function cumulativeSeries(pid, year, unit) {
  let acc = 0;
  return ALL_MONTHS.map((m) => {
    const r = rowAt(pid, year, m);
    if (!r) return null;
    acc += unit === "kwh" ? r.kwh : r.spec;
    return acc;
  });
}

function renderCumulative() {
  const u = state.unit, pid = state.yoyPlant, U = UNITS[u];
  const years = [...new Set(state.rows.filter((r) => r.plant_id === pid).map((r) => r.year))].sort();
  if (!years.length) return emptyChart("Nessun dato per questo impianto.");
  const cur = years.includes(state.year) ? state.year : years.at(-1);
  $("#chart-title").textContent = `Cumulato anno su anno · ${plantName(pid)}`;
  $("#chart-sub").textContent = `${U.label} accumulati da gennaio; la linea più spessa è il ${cur} (i filtri mesi/trimestre non si applicano)`;

  // confronto "a questo punto dell'anno": stessi mesi registrati in entrambi gli anni
  const curRows = state.rows.filter((r) => r.plant_id === pid && r.year === cur);
  const lastM = Math.max(...curRows.map((r) => r.month));
  const val = (r) => (u === "kwh" ? r.kwh : r.spec);
  const prevAll = state.rows.filter((r) => r.plant_id === pid && r.year === cur - 1 && r.month <= lastM);
  const prevMonths = new Set(prevAll.map((r) => r.month));
  const curMonths = new Set(curRows.map((r) => r.month));
  // se i due anni non hanno gli stessi mesi, confronta solo quelli presenti in entrambi
  const partial = prevAll.length > 0 && (prevAll.length !== curRows.length || prevAll.some((r) => !curMonths.has(r.month)));
  const curCmp = partial ? curRows.filter((r) => prevMonths.has(r.month)) : curRows;
  const prevRows = partial ? prevAll.filter((r) => curMonths.has(r.month)) : prevAll;
  const totCur = curCmp.reduce((a, r) => a + val(r), 0);
  const totPrev = prevRows.reduce((a, r) => a + val(r), 0);
  const d = totPrev ? (totCur / totPrev - 1) * 100 : null;
  const dec = u === "kwh" ? 0 : 1;
  const stats = `<div class="cum-stats">
      <div><span class="k">${partial ? `${cur}, stessi mesi` : `Fino a ${MESI[lastM - 1].toLowerCase()} ${cur}`}</span><span class="v">${fmt(totCur, dec)} <small>${U.short}</small></span></div>
      <div><span class="k">${partial ? `${cur - 1}, stessi mesi` : `Stesso periodo ${cur - 1}`}</span><span class="v">${prevRows.length ? `${fmt(totPrev, dec)} <small>${U.short}</small>` : "–"}</span></div>
      <div><span class="k">Differenza</span><span class="v ${d == null ? "" : d >= 0 ? "delta-up" : "delta-down"}">${d == null ? "–"
        : `${d >= 0 ? "▲ +" : "▼ −"}${fmt(Math.abs(totCur - totPrev), dec)} <small>(${d >= 0 ? "+" : "−"}${fmt(Math.abs(d), 1)}%)</small>`}</span></div>
      ${partial ? `<p class="sub">Il ${cur - 1} ha mesi mancanti: il confronto usa solo i ${prevRows.length} mesi registrati in entrambi gli anni (${prevRows.map((r) => MESI_BREVI[r.month - 1].toLowerCase()).join(", ")}).</p>` : ""}
    </div>`;

  const colors = yearRamp(years.length);
  const datasets = years.map((y, i) =>
    lineDataset(String(y), cumulativeSeries(pid, y, u), colors[i],
      { borderWidth: y === cur ? 3 : 2, tension: 0.15, spanGaps: true }));
  const canvas = freshCanvas(`Produzione cumulata ${plantName(pid)}`);
  $("#chart-area").insertAdjacentHTML("afterbegin", stats);
  const opts = lineOptions(u, (it) => `${plantName(pid)} · fino a ${MESI[it[0].dataIndex].toLowerCase()}`);
  opts.scales.y.title.text = `${U.label} cumulati`;
  chart = new window.Chart(canvas, { type: "line", data: { labels: MESI_BREVI, datasets }, options: opts });
  legend(datasets.map((d) => ({ label: d.label, color: d.baseColor })));
}

const valueLabels = {
  id: "valueLabels",
  afterDatasetsDraw(c) {
    const { ctx } = c;
    const ds = c.data.datasets[0];
    ctx.save();
    ctx.font = `600 12px ${cssVar("--font")}`;
    ctx.fillStyle = cssVar("--text");
    ctx.textBaseline = "middle";
    c.getDatasetMeta(0).data.forEach((bar, i) => {
      const v = ds.raw[i];
      const right = ds.base == null || v >= ds.base;
      ctx.textAlign = right ? "left" : "right";
      ctx.fillText(fmt(v, ds.dec), bar.x + (right ? 6 : -6), bar.y);
    });
    ctx.restore();
  },
};

function renderRankChart() {
  const u = state.unit;
  const key = u === "kwh" ? "kwh" : u;
  $("#chart-title").textContent = `Classifica · ${periodLabel()}`;
  $("#chart-sub").textContent = {
    index: "Indice medio di rendimento: 100 = in linea con la mediana del gruppo",
    spec: "kWh/kWp totali nel periodo: penalizza chi ha meno mesi registrati",
    specDay: "kWh/kWp medi al giorno nel periodo",
    kwh: "Produzione assoluta nel periodo: dipende dalla taglia dell'impianto",
  }[u];
  const sum = periodSummary(state.rows, state.idx, state.year, state.months)
    .filter((s) => state.plantSel.has(s.plant_id) && s[key] != null)
    .sort((a, b) => b[key] - a[key]);
  if (!sum.length) return emptyChart("Nessun dato nel periodo selezionato.");
  const vals = sum.map((s) => s[key]);
  const isIdx = u === "index";
  let x;
  if (isIdx) {
    const span = Math.max(10, ...vals.map((v) => Math.abs(v - 100))) * 1.25;
    x = axis({
      min: Math.floor(100 - span), max: Math.ceil(100 + span),
      grid: { color: (c) => (c.tick.value === 100 ? cssVar("--axis") : cssVar("--grid")), drawTicks: false },
    });
  } else {
    x = axis({ beginAtZero: true, suggestedMax: Math.max(...vals) * 1.12 });
  }
  const canvas = freshCanvas("Classifica impianti");
  chart = new window.Chart(canvas, {
    type: "bar",
    data: {
      labels: sum.map((s) => plantName(s.plant_id)),
      datasets: [{
        data: isIdx ? vals.map((v) => [100, v]) : vals,
        raw: vals,
        base: isIdx ? 100 : null,
        dec: UNITS[u].dec,
        backgroundColor: sum.map((s) => plantColor(s.plant_id)),
        borderRadius: 4,
        borderSkipped: "start",
        maxBarThickness: 22,
        categoryPercentage: 0.8,
      }],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      scales: { x, y: axis({ grid: { display: false }, ticks: { color: cssVar("--text-2"), padding: 8 } }) },
      plugins: {
        tooltip: {
          callbacks: {
            label: (it) => {
              const s = sum[it.dataIndex];
              return [` Indice ${fmt(s.index, 1)}`, ` ${fmt(s.spec, 0)} kWh/kWp · ${fmt(s.specDay, 2)} al giorno`,
                ` ${fmt(s.kwh, 0)} kWh in ${s.months} mesi`];
            },
          },
        },
      },
    },
    plugins: [valueLabels],
  });
  $("#chart-legend").innerHTML = "";
}

function cellColor(v, unit, min, max) {
  if (unit === "index") {
    const t = Math.max(-1, Math.min(1, (v - 100) / 25));
    const pole = t >= 0 ? "var(--div-pos)" : "var(--div-neg)";
    return { bg: `color-mix(in oklab, ${pole} ${Math.round(Math.abs(t) * 100)}%, var(--div-mid))`, strong: Math.abs(t) > 0.55 };
  }
  const t = max > min ? (v - min) / (max - min) : 0.5;
  const p = Math.round(8 + t * 87);
  return { bg: `color-mix(in oklab, var(--div-pos) ${p}%, var(--div-mid))`, strong: p > 55 };
}

function renderHeat() {
  const u = state.unit, ms = monthList();
  const plants = visiblePlants().filter((p) => ms.some((m) => rowAt(p.id, state.year, m)));
  if (!plants.length) return emptyChart("Nessun dato nel periodo selezionato.");
  $("#chart-title").textContent = `Mese per mese · ${periodLabel()}`;
  $("#chart-sub").textContent = u === "index"
    ? "Indice di rendimento: resa giornaliera rispetto alla mediana del gruppo nello stesso mese"
    : `${UNITS[u].label} per impianto e mese: più scuro = valore più alto`;
  chart?.destroy();
  chart = null;
  const vals = [];
  for (const p of plants) for (const m of ms) { const v = valueOf(rowAt(p.id, state.year, m), u); if (v != null) vals.push(v); }
  const min = Math.min(...vals), max = Math.max(...vals);
  const sum = new Map(periodSummary(state.rows, state.idx, state.year, state.months).map((s) => [s.plant_id, s]));
  const totKey = u === "index" ? "index" : u;
  const dec = UNITS[u].dec === 2 ? 2 : 0;

  const head = `<tr><th></th>${ms.map((m) => `<th>${MESI_BREVI[m - 1]}</th>`).join("")}<th>Periodo</th></tr>`;
  const body = plants.map((p) => {
    const cells = ms.map((m) => {
      const r = rowAt(p.id, state.year, m);
      const v = valueOf(r, u);
      if (v == null) return `<td class="empty" aria-label="nessun dato"></td>`;
      const { bg, strong } = cellColor(v, u, min, max);
      return `<td data-pid="${p.id}" data-m="${m}" style="background:${bg};color:${strong ? "#fff" : "var(--text)"}">${fmt(v, dec)}</td>`;
    }).join("");
    const s = sum.get(p.id);
    const tv = s?.[totKey];
    let tot = `<td class="empty"></td>`;
    if (tv != null) {
      if (u === "index") {
        const { bg, strong } = cellColor(tv, u);
        tot = `<td class="tot" style="background:${bg};color:${strong ? "#fff" : "var(--text)"}">${fmt(tv, 0)}</td>`;
      } else tot = `<td class="tot plain">${fmt(tv, dec)}</td>`;
    }
    return `<tr><th class="row"><span class="sw" style="--c:${plantColor(p.id)}"></span>${esc(p.name)}</th>${cells}${tot}</tr>`;
  }).join("");

  $("#chart-area").innerHTML = `<div class="heat-wrap"><table class="heat">${`<thead>${head}</thead><tbody>${body}</tbody>`}</table></div>
    <div class="scale">${u === "index"
      ? `<span>sotto la media</span><span class="bar div"></span><span>sopra la media</span>`
      : `<span>${fmt(min, dec)}</span><span class="bar seq"></span><span>${fmt(max, dec)} ${UNITS[u].short}</span>`}</div>`;
  $("#chart-legend").innerHTML = "";
  $("#chart-area").querySelectorAll("td[data-pid]").forEach((td) => {
    td.onmousemove = (e) => {
      const r = rowAt(+td.dataset.pid, state.year, +td.dataset.m);
      showTip(`<b>${esc(plantName(r.plant_id))}</b> · ${MESI[r.month - 1]} ${r.year}<br>
        Indice <b>${fmt(idxOf(r), 1)}</b><br>
        ${fmt(r.kwh, 0)} kWh · ${fmt(r.kwp, 2)} kWp · ${r.days} gg<br>
        ${fmt(r.spec, 1)} kWh/kWp · ${fmt(r.specDay, 2)} al giorno`, e.clientX, e.clientY);
    };
    td.onmouseleave = hideTip;
  });
}

/* ---------------- avvio ---------------- */

function renderAll() {
  renderRanking();
  renderChart();
}

async function init() {
  if (MODE === "local") {
    $("#mode-badge").classList.remove("hidden");
    const btn = $("#reset-local");
    btn.classList.remove("hidden");
    btn.onclick = () => {
      if (confirm("Cancellare le modifiche fatte in questo browser e tornare ai dati importati dallo sheet?")) {
        resetLocal();
        location.reload();
      }
    };
  }
  try {
    const [plants, readings] = await Promise.all([getPlants(), getReadings()]);
    state.plants = plants;
    state.rows = enrich(readings).sort((a, b) => a.year - b.year || a.month - b.month || a.plant_id - b.plant_id);
  } catch (e) {
    $("main").insertAdjacentHTML("afterbegin", `<p class="notice err show">Impossibile caricare i dati: ${esc(e.message)}</p>`);
    return;
  }
  state.idx = monthlyIndex(state.rows);
  state.years = [...new Set(state.rows.map((r) => r.year))].sort();
  state.year = state.years.at(-1);
  state.plantSel = new Set(state.plants.map((p) => p.id));
  state.yoyPlant = (state.plants.find((p) => p.name === "Fradetti") ?? state.plants[0])?.id;
  const last = state.rows.at(-1);
  $("#footer-info").textContent = last ? `${state.rows.length} letture · ultima: ${MESI[last.month - 1]} ${last.year} · ` : "";

  chartDefaults();
  buildFilters();
  renderAll();

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { chartDefaults(); renderAll(); });
}

init();
