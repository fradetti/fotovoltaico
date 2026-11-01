import { getPlants, getReadings, MODE, resetLocal } from "./api.js";
import {
  MESI, MESI_BREVI, fmt, seriesColor, cssVar, enrich, monthlyIndex, yearSummary, esc,
} from "./common.js";

const $ = (s) => document.querySelector(s);
const tip = $("#tip");

const state = {
  plants: [],
  rows: [],
  idx: new Map(),
  years: [],
  year: null,
  selected: new Set(),
  metric: "spec",
  yoyPlant: null,
  tableAll: false,
  sort: { key: "date", dir: -1 },
  highlight: null,
};
const charts = {};

/* ---------------- helpers ---------------- */

const plantName = (id) => state.plants.find((p) => p.id === id)?.name ?? `#${id}`;
const plantColor = (id) => seriesColor(state.plants.findIndex((p) => p.id === id));
const visiblePlants = () => state.plants.filter((p) => state.selected.has(p.id));
const rowAt = (pid, y, m) => state.rows.find((r) => r.plant_id === pid && r.year === y && r.month === m);

function withAlpha(hex, a) {
  return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`;
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
  C.defaults.animation = { duration: 250 };
  Object.assign(C.defaults.plugins.tooltip, {
    backgroundColor: cssVar("--surface"),
    titleColor: cssVar("--text"),
    bodyColor: cssVar("--text-2"),
    borderColor: cssVar("--border"),
    borderWidth: 1,
    padding: 10,
    boxPadding: 4,
    usePointStyle: true,
    cornerRadius: 8,
  });
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

/* ---------------- filtri ---------------- */

function buildFilters() {
  const ysel = $("#year");
  ysel.innerHTML = state.years.slice().reverse().map((y) => `<option>${y}</option>`).join("");
  ysel.value = state.year;
  ysel.onchange = () => { state.year = +ysel.value; renderAll(); };

  const chips = $("#plant-chips");
  chips.innerHTML = state.plants.map((p) => `
    <label class="chip" style="--c:${plantColor(p.id)}" data-pid="${p.id}">
      <input type="checkbox" value="${p.id}" ${state.selected.has(p.id) ? "checked" : ""}>
      <span class="sw"></span>${esc(p.name)}
    </label>`).join("");
  chips.querySelectorAll("input").forEach((cb) => {
    cb.onchange = () => {
      const id = +cb.value;
      cb.checked ? state.selected.add(id) : state.selected.delete(id);
      renderAll();
    };
  });
  chips.querySelectorAll(".chip").forEach((chip) => {
    chip.onmouseenter = () => setHighlight(+chip.dataset.pid);
    chip.onmouseleave = () => setHighlight(null);
  });

  document.querySelectorAll(".seg button[data-metric]").forEach((b) => {
    b.onclick = () => {
      state.metric = b.dataset.metric;
      document.querySelectorAll(".seg button[data-metric]").forEach((x) =>
        x.setAttribute("aria-pressed", x === b ? "true" : "false"));
      renderLine();
    };
  });

  const yp = $("#yoy-plant");
  yp.innerHTML = state.plants.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  yp.value = state.yoyPlant;
  yp.onchange = () => { state.yoyPlant = +yp.value; renderYoy(); };

  $("#table-all").onchange = (e) => { state.tableAll = e.target.checked; renderTable(); };
}

/* ---------------- KPI ---------------- */

function renderKpis() {
  const sum = yearSummary(state.rows, state.idx, state.year)
    .filter((s) => state.selected.has(s.plant_id))
    .sort((a, b) => (b.index ?? -1) - (a.index ?? -1));

  $("#kpis").innerHTML = sum.map((s, i) => {
    // confronto con l'anno precedente sugli stessi mesi
    const cur = state.rows.filter((r) => r.plant_id === s.plant_id && r.year === state.year);
    let a = 0, b = 0;
    for (const r of cur) {
      const p = rowAt(s.plant_id, state.year - 1, r.month);
      if (p) { a += r.spec; b += p.spec; }
    }
    const delta = b ? (a / b - 1) * 100 : null;
    const deltaHtml = delta == null ? "" :
      `<span class="${delta >= 0 ? "delta-up" : "delta-down"}">${delta >= 0 ? "▲" : "▼"} ${fmt(Math.abs(delta), 1)}%</span> vs ${state.year - 1} stessi mesi`;
    return `
      <article class="kpi ${i === 0 && s.index != null ? "first" : ""}" style="--c:${plantColor(s.plant_id)}">
        <div class="name"><span class="sw"></span>${esc(plantName(s.plant_id))}<span class="rank">${s.index != null ? `#${i + 1}` : ""}</span></div>
        <div class="value">${fmt(s.spec, 0)}<small>kWh/kWp</small></div>
        <div class="meta">Indice <b>${fmt(s.index, 0)}</b> · ${s.months} ${s.months === 1 ? "mese" : "mesi"} · ${fmt(s.kwh, 0)} kWh</div>
        ${deltaHtml ? `<div class="meta">${deltaHtml}</div>` : ""}
      </article>`;
  }).join("") || `<p class="sub">Nessun dato per ${state.year}.</p>`;
}

/* ---------------- linee mensili ---------------- */

function renderLine() {
  const m = state.metric;
  $("#line-title").textContent = `Resa mensile ${state.year}`;
  $("#line-sub").textContent = m === "spec"
    ? "kWh/kWp prodotti in ciascun mese"
    : "kWh/kWp medi al giorno: confronto equo anche con mesi parziali";
  const datasets = visiblePlants().map((p) => {
    const c = plantColor(p.id);
    return {
      label: p.name,
      pid: p.id,
      data: MESI.map((_, i) => rowAt(p.id, state.year, i + 1)?.[m] ?? null),
      borderColor: c,
      backgroundColor: c,
      baseColor: c,
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
      pointBorderColor: cssVar("--surface"),
      pointBorderWidth: 2,
      tension: 0.25,
      spanGaps: false,
    };
  });
  const dec = m === "spec" ? 1 : 2;
  const cfg = {
    type: "line",
    data: { labels: MESI_BREVI, datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: axis({ grid: { display: false } }),
        y: axis({ beginAtZero: true, title: { display: true, text: m === "spec" ? "kWh/kWp" : "kWh/kWp al giorno", color: cssVar("--muted") } }),
      },
      plugins: {
        tooltip: {
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: {
            title: (it) => `${MESI[it[0].dataIndex]} ${state.year}`,
            label: (it) => ` ${it.dataset.label}: ${fmt(it.parsed.y, dec)}`,
          },
        },
      },
    },
  };
  charts.line?.destroy();
  charts.line = new window.Chart($("#line-chart"), cfg);
  $("#line-legend").innerHTML = datasets.map((d) =>
    `<span data-pid="${d.pid}" style="--c:${d.baseColor}"><i></i>${esc(d.label)}</span>`).join("");
  $("#line-legend").querySelectorAll("span").forEach((el) => {
    el.onmouseenter = () => setHighlight(+el.dataset.pid);
    el.onmouseleave = () => setHighlight(null);
  });
  applyHighlight();
}

function setHighlight(pid) {
  state.highlight = pid;
  applyHighlight();
}
function applyHighlight() {
  const ch = charts.line;
  if (!ch) return;
  const grey = cssVar("--axis");
  for (const d of ch.data.datasets) {
    const on = state.highlight == null || d.pid === state.highlight;
    d.borderColor = on ? d.baseColor : withAlpha(grey, 0.9);
    d.backgroundColor = d.borderColor;
    d.borderWidth = state.highlight === d.pid ? 3 : 2;
    d.order = state.highlight === d.pid ? 0 : 1;
  }
  ch.update("none");
}

/* ---------------- classifica ---------------- */

const valueLabels = {
  id: "valueLabels",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    ctx.save();
    ctx.font = `600 12px ${cssVar("--font")}`;
    ctx.fillStyle = cssVar("--text");
    ctx.textBaseline = "middle";
    meta.data.forEach((bar, i) => {
      const v = chart.data.datasets[0].raw[i];
      const right = v >= 100;
      ctx.textAlign = right ? "left" : "right";
      ctx.fillText(fmt(v, 0), bar.x + (right ? 6 : -6), bar.y);
    });
    ctx.restore();
  },
};

function renderRank() {
  const sum = yearSummary(state.rows, state.idx, state.year)
    .filter((s) => state.selected.has(s.plant_id) && s.index != null)
    .sort((a, b) => b.index - a.index);
  const vals = sum.map((s) => s.index);
  const span = Math.max(10, ...vals.map((v) => Math.abs(v - 100))) * 1.25;
  const cfg = {
    type: "bar",
    data: {
      labels: sum.map((s) => plantName(s.plant_id)),
      datasets: [{
        data: vals.map((v) => [100, v]),
        raw: vals,
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
      scales: {
        x: axis({
          min: Math.floor(100 - span), max: Math.ceil(100 + span),
          grid: { color: (c) => (c.tick.value === 100 ? cssVar("--axis") : cssVar("--grid")), drawTicks: false },
        }),
        y: axis({ grid: { display: false }, ticks: { color: cssVar("--text-2"), padding: 8 } }),
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (it) => {
              const s = sum[it.dataIndex];
              return [` Indice ${fmt(s.index, 1)}`, ` ${fmt(s.spec, 0)} kWh/kWp in ${s.months} mesi`, ` ${fmt(s.specDay, 2)} kWh/kWp al giorno`];
            },
          },
        },
      },
    },
    plugins: [valueLabels],
  };
  charts.rank?.destroy();
  charts.rank = new window.Chart($("#rank-chart"), cfg);
}

/* ---------------- anno su anno ---------------- */

function yearRamp(n) {
  const dark = matchDark();
  const light = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"];
  const drk = ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"];
  const ramp = dark ? drk : light;
  // gli anni piu' recenti prendono i passi piu' marcati
  return Array.from({ length: n }, (_, i) => ramp[Math.max(0, ramp.length - n + i)]);
}
function matchDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function renderYoy() {
  const pid = state.yoyPlant;
  const years = [...new Set(state.rows.filter((r) => r.plant_id === pid).map((r) => r.year))].sort();
  const colors = yearRamp(years.length);
  const datasets = years.map((y, i) => ({
    label: String(y),
    data: MESI.map((_, m) => rowAt(pid, y, m + 1)?.spec ?? null),
    borderColor: colors[i],
    backgroundColor: colors[i],
    borderWidth: y === years.at(-1) ? 2.5 : 2,
    pointRadius: 3,
    pointBorderColor: cssVar("--surface"),
    pointBorderWidth: 2,
    tension: 0.25,
  }));
  const cfg = {
    type: "line",
    data: { labels: MESI_BREVI, datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: axis({ grid: { display: false } }),
        y: axis({ beginAtZero: true, title: { display: true, text: "kWh/kWp", color: cssVar("--muted") } }),
      },
      plugins: {
        tooltip: {
          callbacks: {
            title: (it) => `${plantName(pid)} · ${MESI[it[0].dataIndex]}`,
            label: (it) => ` ${it.dataset.label}: ${fmt(it.parsed.y, 1)} kWh/kWp`,
          },
        },
      },
    },
  };
  charts.yoy?.destroy();
  charts.yoy = new window.Chart($("#yoy-chart"), cfg);
  $("#yoy-legend").innerHTML = datasets.map((d) =>
    `<span style="--c:${d.borderColor}"><i></i>${d.label}</span>`).join("");
}

/* ---------------- heatmap ---------------- */

function heatColor(v) {
  const t = Math.max(-1, Math.min(1, (v - 100) / 25));
  const pole = t >= 0 ? "var(--div-pos)" : "var(--div-neg)";
  return { bg: `color-mix(in oklab, ${pole} ${Math.round(Math.abs(t) * 100)}%, var(--div-mid))`, strong: Math.abs(t) > 0.55 };
}

function renderHeat() {
  const plants = visiblePlants();
  const sum = new Map(yearSummary(state.rows, state.idx, state.year).map((s) => [s.plant_id, s]));
  const head = `<tr><th></th>${MESI_BREVI.map((m) => `<th>${m}</th>`).join("")}<th>Anno</th></tr>`;
  const body = plants.map((p) => {
    const cells = MESI.map((_, i) => {
      const v = state.idx.get(`${p.id}-${state.year}-${i + 1}`);
      if (v == null) return `<td class="empty" aria-label="nessun dato"></td>`;
      const { bg, strong } = heatColor(v);
      return `<td data-pid="${p.id}" data-m="${i + 1}" style="background:${bg};color:${strong ? "#fff" : "var(--text)"}">${fmt(v, 0)}</td>`;
    }).join("");
    const s = sum.get(p.id);
    let tot = `<td class="empty"></td>`;
    if (s?.index != null) {
      const { bg, strong } = heatColor(s.index);
      tot = `<td style="background:${bg};color:${strong ? "#fff" : "var(--text)"};font-weight:600">${fmt(s.index, 0)}</td>`;
    }
    return `<tr><th class="row"><span class="sw" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${plantColor(p.id)};margin-right:6px"></span>${esc(p.name)}</th>${cells}${tot}</tr>`;
  }).join("");
  const t = $("#heat");
  t.innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
  t.querySelectorAll("td[data-pid]").forEach((td) => {
    td.onmousemove = (e) => {
      const r = rowAt(+td.dataset.pid, state.year, +td.dataset.m);
      showTip(`<b>${esc(plantName(r.plant_id))}</b> · ${MESI[r.month - 1]} ${r.year}<br>
        Indice <b>${fmt(state.idx.get(`${r.plant_id}-${r.year}-${r.month}`), 1)}</b><br>
        ${fmt(r.kwh, 0)} kWh · ${fmt(r.kwp, 2)} kWp · ${r.days} gg<br>
        ${fmt(r.spec, 1)} kWh/kWp · ${fmt(r.specDay, 2)} al giorno`, e.clientX, e.clientY);
    };
    td.onmouseleave = hideTip;
  });
}

/* ---------------- tabella ---------------- */

const COLS = [
  { key: "date", label: "Anno", get: (r) => r.year * 100 + r.month, show: (r) => r.year },
  { key: "month", label: "Mese", get: (r) => r.month, show: (r) => MESI[r.month - 1] },
  { key: "name", label: "Impianto", get: (r) => plantName(r.plant_id).toLowerCase(),
    show: (r) => `<span class="sw" style="--c:${plantColor(r.plant_id)}"></span>${esc(plantName(r.plant_id))}` },
  { key: "kwp", label: "kWp", n: true, get: (r) => r.kwp, show: (r) => fmt(r.kwp, 2) },
  { key: "kwh", label: "kWh", n: true, get: (r) => r.kwh, show: (r) => fmt(r.kwh, 0) },
  { key: "spec", label: "kWh/kWp", n: true, get: (r) => r.spec, show: (r) => fmt(r.spec, 1) },
  { key: "days", label: "Giorni", n: true, get: (r) => r.days, show: (r) => r.days },
  { key: "specDay", label: "Media giorn.", n: true, get: (r) => r.specDay, show: (r) => fmt(r.specDay, 2) },
  { key: "idx", label: "Indice", n: true, get: (r) => state.idx.get(`${r.plant_id}-${r.year}-${r.month}`) ?? -1,
    show: (r) => fmt(state.idx.get(`${r.plant_id}-${r.year}-${r.month}`), 0) },
];

function renderTable() {
  $("#table-sub").textContent = state.tableAll ? "Tutte le letture" : `Letture del ${state.year}`;
  const col = COLS.find((c) => c.key === state.sort.key);
  const rows = state.rows
    .filter((r) => state.selected.has(r.plant_id) && (state.tableAll || r.year === state.year))
    .sort((a, b) => {
      const x = col.get(a), y = col.get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir || a.plant_id - b.plant_id;
    });
  const t = $("#data-table");
  t.innerHTML = `<thead><tr>${COLS.map((c) => `<th class="${c.n ? "n" : ""}" data-k="${c.key}" ${c.key === state.sort.key ? `aria-sort="${state.sort.dir > 0 ? "ascending" : "descending"}"` : ""}>${c.label}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${COLS.map((c) => `<td class="${c.n ? "n" : ""}">${c.show(r)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  t.querySelectorAll("th").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (COLS.find((c) => c.key === k).n ? -1 : 1) };
      renderTable();
    };
  });
}

/* ---------------- avvio ---------------- */

function renderAll() {
  renderKpis();
  renderLine();
  renderRank();
  renderYoy();
  renderHeat();
  renderTable();
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
  state.selected = new Set(state.plants.map((p) => p.id));
  const me = state.plants.find((p) => p.name === "Fradetti") ?? state.plants[0];
  state.yoyPlant = me?.id;
  const last = state.rows.at(-1);
  $("#footer-info").textContent = last
    ? `${state.rows.length} letture · ultima: ${MESI[last.month - 1]} ${last.year} · `
    : "";

  chartDefaults();
  buildFilters();
  renderAll();

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    chartDefaults();
    buildFilters();
    renderAll();
  });
}

init();
