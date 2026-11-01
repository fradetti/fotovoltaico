import { getPlants, getReadings, saveReading, deleteReading, changePin, MODE } from "./api.js";
import { MESI, fmt, daysInMonth, esc } from "./common.js";

const $ = (s) => document.querySelector(s);
const f = {
  plant: $("#plant"), year: $("#year"), month: $("#month"), kwh: $("#kwh"),
  kwp: $("#kwp"), days: $("#days"), pin: $("#pin"), remember: $("#remember"),
};

let plants = [];
let rows = [];

/* ---------- storage per-dispositivo (comodita', non indispensabile) ---------- */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignora */ } },
};

const num = (el) => (el.value === "" ? NaN : Number(String(el.value).replace(",", ".")));
const sel = () => ({ plant_id: +f.plant.value, year: +f.year.value, month: +f.month.value });
const find = (pid, y, m) => rows.find((r) => r.plant_id === pid && r.year === y && r.month === m);

function msg(el, text, kind) {
  el.textContent = text;
  el.className = `notice full ${kind} ${text ? "show" : ""}`;
}

/** kWp piu' recente dell'impianto fino al mese indicato (o l'ultimo noto). */
function lastKwp(pid, y, m) {
  const list = rows.filter((r) => r.plant_id === pid).sort((a, b) => a.year - b.year || a.month - b.month);
  const before = list.filter((r) => r.year * 12 + r.month <= y * 12 + m);
  return (before.at(-1) ?? list.at(-1))?.kwp ?? "";
}

function loadSelection() {
  const { plant_id, year, month } = sel();
  if (!plant_id || !year || !month) return;
  const ex = find(plant_id, year, month);
  f.days.max = daysInMonth(year, month);
  if (ex) {
    f.kwh.value = ex.kwh;
    f.kwp.value = ex.kwp;
    f.days.value = ex.days;
    msg($("#existing"), `${MESI[month - 1]} ${year} è già registrato (${fmt(ex.kwh, 0)} kWh). Se salvi, il valore viene sostituito.`, "info");
    $("#delete").classList.remove("hidden");
    $("#save").textContent = "Aggiorna";
  } else {
    f.kwh.value = "";
    f.kwp.value = lastKwp(plant_id, year, month);
    f.days.value = daysInMonth(year, month);
    msg($("#existing"), "", "info");
    $("#delete").classList.add("hidden");
    $("#save").textContent = "Salva";
  }
  const saved = store.get(`fv-pin-${plant_id}`);
  if (saved) { f.pin.value = saved; f.remember.checked = true; } else if (!f.pin.dataset.typed) { f.pin.value = ""; f.remember.checked = false; }
  msg($("#msg"), "", "");
  updateCalc();
}

function updateCalc() {
  const kwh = num(f.kwh), kwp = num(f.kwp), days = num(f.days);
  const ok = kwh >= 0 && kwp > 0;
  $("#c-spec").textContent = ok ? fmt(kwh / kwp, 1) : "–";
  $("#c-day").textContent = ok && days > 0 ? fmt(kwh / kwp / days, 2) : "–";
  const { plant_id, year, month } = sel();
  const prev = find(plant_id, year - 1, month);
  $("#c-prev").innerHTML = prev
    ? `${MESI_SHORT(month)} ${year - 1}: <b>${fmt(prev.kwh / prev.kwp, 1)}</b> kWh/kWp`
    : "";
}
const MESI_SHORT = (m) => MESI[m - 1].slice(0, 3);

function renderHistory() {
  const pid = +f.plant.value;
  const p = plants.find((x) => x.id === pid);
  $("#hist-title").textContent = `Ultime letture · ${p?.name ?? ""}`;
  const list = rows.filter((r) => r.plant_id === pid)
    .sort((a, b) => b.year - a.year || b.month - a.month).slice(0, 24);
  $("#hist").innerHTML = `<thead><tr><th>Mese</th><th class="n">kWh</th><th class="n">kWp</th><th class="n">Giorni</th><th class="n">kWh/kWp</th></tr></thead>
    <tbody>${list.map((r) => `<tr data-y="${r.year}" data-m="${r.month}" style="cursor:pointer">
      <td>${MESI[r.month - 1]} ${r.year}</td><td class="n">${fmt(r.kwh, 0)}</td><td class="n">${fmt(r.kwp, 2)}</td>
      <td class="n">${r.days}</td><td class="n">${fmt(r.kwh / r.kwp, 1)}</td></tr>`).join("")}</tbody>`;
  $("#hist").querySelectorAll("tbody tr").forEach((tr) => {
    tr.onclick = () => {
      f.year.value = tr.dataset.y;
      f.month.value = tr.dataset.m;
      loadSelection();
      scrollTo({ top: 0, behavior: "smooth" });
    };
  });
}

async function refresh() {
  rows = await getReadings();
  renderHistory();
}

function rememberPin(pid, pin) {
  if (f.remember.checked) store.set(`fv-pin-${pid}`, pin);
  else store.del(`fv-pin-${pid}`);
}

async function onSave(e) {
  e.preventDefault();
  const { plant_id, year, month } = sel();
  const payload = { plant_id, year, month, kwh: num(f.kwh), kwp: num(f.kwp), days: num(f.days), pin: f.pin.value.trim() };
  if (!plant_id) return msg($("#msg"), "Scegli il tuo impianto.", "err");
  if (!payload.pin) return msg($("#msg"), "Inserisci il PIN del tuo impianto.", "err");
  if (Number.isNaN(payload.kwh)) return msg($("#msg"), "Inserisci la produzione in kWh.", "err");
  $("#save").disabled = true;
  try {
    await saveReading(payload);
    rememberPin(plant_id, payload.pin);
    await refresh();
    loadSelection();
    msg($("#msg"), `Salvato: ${MESI[month - 1]} ${year}, ${fmt(payload.kwh, 0)} kWh.`, "ok");
  } catch (err) {
    msg($("#msg"), err.message, "err");
  } finally {
    $("#save").disabled = false;
  }
}

async function onDelete() {
  const { plant_id, year, month } = sel();
  const pin = f.pin.value.trim();
  if (!pin) return msg($("#msg"), "Inserisci il PIN per eliminare.", "err");
  if (!confirm(`Eliminare ${MESI[month - 1]} ${year}?`)) return;
  try {
    await deleteReading({ plant_id, year, month, pin });
    rememberPin(plant_id, pin);
    await refresh();
    loadSelection();
    msg($("#msg"), `Eliminato ${MESI[month - 1]} ${year}.`, "ok");
  } catch (err) {
    msg($("#msg"), err.message, "err");
  }
}

async function onChangePin(e) {
  e.preventDefault();
  const plant_id = +f.plant.value;
  const old_pin = $("#old-pin").value.trim(), new_pin = $("#new-pin").value.trim();
  try {
    await changePin({ plant_id, old_pin, new_pin });
    if (store.get(`fv-pin-${plant_id}`)) store.set(`fv-pin-${plant_id}`, new_pin);
    if (f.pin.value) f.pin.value = new_pin;
    $("#old-pin").value = $("#new-pin").value = "";
    msg($("#pin-msg"), "PIN cambiato.", "ok");
  } catch (err) {
    msg($("#pin-msg"), err.message, "err");
  }
}

async function init() {
  if (MODE === "local") $("#mode-badge").classList.remove("hidden");
  try {
    [plants, rows] = await Promise.all([getPlants(), getReadings()]);
  } catch (e) {
    msg($("#msg"), `Impossibile caricare i dati: ${e.message}`, "err");
    return;
  }
  f.plant.innerHTML = `<option value="" disabled>Scegli il tuo impianto…</option>` +
    plants.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  f.month.innerHTML = MESI.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");

  // default: mese scorso, ultimo impianto usato su questo dispositivo
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const q = new URLSearchParams(location.search);
  f.year.value = q.get("y") ?? prev.getFullYear();
  f.month.value = q.get("m") ?? prev.getMonth() + 1;
  const lastPlant = q.get("plant") ?? store.get("fv-last-plant");
  f.plant.value = plants.some((p) => String(p.id) === lastPlant) ? lastPlant : "";

  const onSel = () => {
    if (f.plant.value) store.set("fv-last-plant", f.plant.value);
    f.pin.dataset.typed = "";
    loadSelection();
    renderHistory();
  };
  f.plant.onchange = onSel;
  f.year.onchange = loadSelection;
  f.month.onchange = loadSelection;
  for (const el of [f.kwh, f.kwp, f.days]) el.oninput = updateCalc;
  f.pin.oninput = () => { f.pin.dataset.typed = "1"; };
  $("#form").onsubmit = onSave;
  $("#delete").onclick = onDelete;
  $("#pin-form").onsubmit = onChangePin;

  if (f.plant.value) { loadSelection(); renderHistory(); }
  else f.plant.focus();
}

init();
