import { getPlants, getReadings, MODE } from "./api.js";
import { MESI, fmt, seriesColor, enrich, monthlyIndex, esc } from "./common.js";
import { createMultiSelect } from "./multiselect.js";
import { track } from "./track.js";

track("dati");

const $ = (s) => document.querySelector(s);
const state = { plants: [], rows: [], idx: new Map(), year: "all", plantSel: new Set(), sort: { key: "date", dir: -1 } };

const plantName = (id) => state.plants.find((p) => p.id === id)?.name ?? `#${id}`;
const plantColor = (id) => seriesColor(state.plants.findIndex((p) => p.id === id));
const idxOf = (r) => state.idx.get(`${r.plant_id}-${r.year}-${r.month}`);

const COLS = [
  { key: "date", label: "Anno", get: (r) => r.year * 100 + r.month, show: (r) => r.year, csv: (r) => r.year },
  { key: "month", label: "Mese", get: (r) => r.month, show: (r) => MESI[r.month - 1], csv: (r) => MESI[r.month - 1] },
  { key: "name", label: "Impianto", get: (r) => plantName(r.plant_id).toLowerCase(),
    show: (r) => `<span class="sw" style="--c:${plantColor(r.plant_id)}"></span>${esc(plantName(r.plant_id))}`,
    csv: (r) => plantName(r.plant_id) },
  { key: "kwp", label: "kWp", n: true, get: (r) => r.kwp, show: (r) => fmt(r.kwp, 2), csv: (r) => r.kwp },
  { key: "kwh", label: "kWh", n: true, get: (r) => r.kwh, show: (r) => fmt(r.kwh, 0), csv: (r) => r.kwh },
  { key: "spec", label: "kWh/kWp", n: true, get: (r) => r.spec, show: (r) => fmt(r.spec, 1), csv: (r) => r.spec.toFixed(2) },
  { key: "days", label: "Giorni", n: true, get: (r) => r.days, show: (r) => r.days, csv: (r) => r.days },
  { key: "specDay", label: "kWh/kWp/g", n: true, get: (r) => r.specDay, show: (r) => fmt(r.specDay, 2), csv: (r) => r.specDay.toFixed(3) },
  { key: "idx", label: "Indice", n: true, get: (r) => idxOf(r) ?? -1, show: (r) => fmt(idxOf(r), 0), csv: (r) => idxOf(r)?.toFixed(1) ?? "" },
];

function filtered() {
  const col = COLS.find((c) => c.key === state.sort.key);
  return state.rows
    .filter((r) => state.plantSel.has(r.plant_id) && (state.year === "all" || r.year === +state.year))
    .sort((a, b) => {
      const x = col.get(a), y = col.get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir || a.plant_id - b.plant_id;
    });
}

function render() {
  const rows = filtered();
  $("#table-sub").textContent = `${rows.length} letture${state.year === "all" ? "" : ` del ${state.year}`} · clicca un'intestazione per ordinare`;
  const t = $("#data-table");
  t.innerHTML = `<thead><tr>${COLS.map((c) => `<th class="${c.n ? "n" : ""}" data-k="${c.key}" ${c.key === state.sort.key ? `aria-sort="${state.sort.dir > 0 ? "ascending" : "descending"}"` : ""}>${c.label}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${COLS.map((c) => `<td class="${c.n ? "n" : ""}">${c.show(r)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  t.querySelectorAll("th").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      const n = COLS.find((c) => c.key === k).n;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (n ? -1 : 1) };
      render();
    };
  });
}

function downloadCsv() {
  const q = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const lines = [COLS.map((c) => c.label).join(";"), ...filtered().map((r) => COLS.map((c) => q(c.csv(r))).join(";"))];
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `fotovoltaico-${state.year === "all" ? "tutti" : state.year}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function init() {
  if (MODE === "local") $("#mode-badge").classList.remove("hidden");
  try {
    const [plants, readings] = await Promise.all([getPlants(), getReadings()]);
    state.plants = plants;
    state.rows = enrich(readings);
  } catch (e) {
    $("main").insertAdjacentHTML("afterbegin", `<p class="notice err show">Impossibile caricare i dati: ${esc(e.message)}</p>`);
    return;
  }
  state.idx = monthlyIndex(state.rows);
  state.plantSel = new Set(state.plants.map((p) => p.id));
  const years = [...new Set(state.rows.map((r) => r.year))].sort().reverse();
  state.year = String(years[0]);

  const ys = $("#year");
  ys.innerHTML = years.map((y) => `<option>${y}</option>`).join("") + `<option value="all">Tutti</option>`;
  ys.value = state.year;
  ys.onchange = () => { state.year = ys.value; render(); };
  createMultiSelect($("#ms-plants"), {
    label: "Impianti",
    unit: "impianti",
    options: state.plants.map((p) => ({ value: p.id, label: p.name, color: plantColor(p.id) })),
    selected: state.plantSel,
    onChange: (s) => { state.plantSel = s; render(); },
  });
  $("#csv").onclick = downloadCsv;
  render();
}

init();
