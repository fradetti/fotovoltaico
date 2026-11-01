// Livello dati: stessa interfaccia per la modalita' locale e per Supabase.
//   getPlants()   -> [{id, name}]
//   getReadings() -> [{plant_id, year, month, kwh, kwp, days}]
//   saveReading({plant_id, pin, year, month, kwh, kwp, days})
//   deleteReading({plant_id, pin, year, month})
//   changePin({plant_id, old_pin, new_pin})
// Gli errori vengono lanciati come Error con messaggio leggibile in italiano.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const MODE = SUPABASE_URL ? "supabase" : "local";

/* ---------------- Adapter locale (solo sviluppo, NON sicuro) ---------------- */

const LS_READINGS = "fv-local-readings"; // { "pid-y-m": reading | null }
const LS_PINS = "fv-local-pins";         // { pid: pin } (PIN cambiati)

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignora */ }
}

let seedPromise;
function seed() {
  seedPromise ??= Promise.all([
    fetch("data/seed.json").then((r) => r.json()),
    fetch("data/dev-pins.json").then((r) => (r.ok ? r.json() : {})),
  ]).then(([s, pins]) => ({ ...s, pins }));
  return seedPromise;
}

const k = (pid, y, m) => `${pid}-${y}-${m}`;

async function checkPinLocal(plant_id, pin) {
  const s = await seed();
  const expected = lsGet(LS_PINS)[plant_id] ?? s.pins[plant_id];
  if (!expected || String(pin) !== String(expected)) throw new Error("PIN errato");
}

const local = {
  async getPlants() {
    return (await seed()).plants;
  },
  async getReadings() {
    const s = await seed();
    const over = lsGet(LS_READINGS);
    const map = new Map(s.readings.map((r) => [k(r.plant_id, r.year, r.month), r]));
    for (const [key, r] of Object.entries(over)) {
      if (r === null) map.delete(key); else map.set(key, r);
    }
    return [...map.values()];
  },
  async saveReading({ plant_id, pin, year, month, kwh, kwp, days }) {
    await checkPinLocal(plant_id, pin);
    validate({ year, month, kwh, kwp, days });
    const over = lsGet(LS_READINGS);
    over[k(plant_id, year, month)] = { plant_id, year, month, kwh, kwp, days };
    lsSet(LS_READINGS, over);
  },
  async deleteReading({ plant_id, pin, year, month }) {
    await checkPinLocal(plant_id, pin);
    const over = lsGet(LS_READINGS);
    over[k(plant_id, year, month)] = null;
    lsSet(LS_READINGS, over);
  },
  async changePin({ plant_id, old_pin, new_pin }) {
    await checkPinLocal(plant_id, old_pin);
    if (!/^\d{4,8}$/.test(String(new_pin))) throw new Error("Il PIN deve avere da 4 a 8 cifre");
    const pins = lsGet(LS_PINS);
    pins[plant_id] = String(new_pin);
    lsSet(LS_PINS, pins);
  },
};

export function resetLocal() {
  try { localStorage.removeItem(LS_READINGS); localStorage.removeItem(LS_PINS); } catch { /* ignora */ }
}

function validate({ year, month, kwh, kwp, days }) {
  if (!(year >= 2000 && year <= 2100)) throw new Error("Anno non valido");
  if (!(month >= 1 && month <= 12)) throw new Error("Mese non valido");
  const max = new Date(year, month, 0).getDate();
  if (!(days >= 1 && days <= max)) throw new Error(`I giorni devono essere tra 1 e ${max}`);
  if (!(kwh >= 0)) throw new Error("kWh non valido");
  if (!(kwp > 0)) throw new Error("kWp non valido");
}

/* ---------------- Adapter Supabase ---------------- */

let clientPromise;
function client() {
  clientPromise ??= import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm")
    .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
  return clientPromise;
}

function rpcError(error) {
  // Le funzioni SQL sollevano eccezioni con messaggi gia' in italiano.
  return new Error(error.message || "Errore del server");
}

const supa = {
  async getPlants() {
    const { data, error } = await (await client()).from("plants_public").select("id,name").order("id");
    if (error) throw rpcError(error);
    return data;
  },
  async getReadings() {
    const { data, error } = await (await client())
      .from("readings").select("plant_id,year,month,kwh,kwp,days").range(0, 9999);
    if (error) throw rpcError(error);
    return data.map((r) => ({ ...r, kwh: +r.kwh, kwp: +r.kwp }));
  },
  async saveReading(p) {
    validate(p);
    const { data, error } = await (await client()).rpc("save_reading", {
      p_plant_id: p.plant_id, p_pin: String(p.pin), p_year: p.year, p_month: p.month,
      p_kwh: p.kwh, p_kwp: p.kwp, p_days: p.days,
    });
    if (error) throw rpcError(error);
    if (data?.error) throw new Error(data.error);
  },
  async deleteReading(p) {
    const { data, error } = await (await client()).rpc("delete_reading", {
      p_plant_id: p.plant_id, p_pin: String(p.pin), p_year: p.year, p_month: p.month,
    });
    if (error) throw rpcError(error);
    if (data?.error) throw new Error(data.error);
  },
  async changePin(p) {
    const { data, error } = await (await client()).rpc("change_pin", {
      p_plant_id: p.plant_id, p_old_pin: String(p.old_pin), p_new_pin: String(p.new_pin),
    });
    if (error) throw rpcError(error);
    if (data?.error) throw new Error(data.error);
  },
};

/* ---------------- Visite (solo Supabase) ---------------- */

export async function logVisit(p) {
  if (MODE !== "supabase") return;
  await (await client()).rpc("log_visit", {
    p_page: p.page, p_visitor: p.visitor, p_referrer: p.referrer, p_device: p.device,
  });
}

export async function visitStats(days) {
  if (MODE !== "supabase") throw new Error("Le statistiche delle visite sono disponibili solo con Supabase");
  const { data, error } = await (await client()).rpc("visit_stats", { p_days: days });
  if (error) throw rpcError(error);
  return data;
}

/** Letture con data di ultima modifica: serve a vedere chi inserisce e quando. */
export async function getEntryActivity() {
  if (MODE !== "supabase") return [];
  const { data, error } = await (await client())
    .from("readings").select("plant_id,year,month,updated_at").order("updated_at", { ascending: false }).range(0, 9999);
  if (error) throw rpcError(error);
  return data;
}

const impl = MODE === "supabase" ? supa : local;
export const getPlants = () => impl.getPlants();
export const getReadings = () => impl.getReadings();
export const saveReading = (p) => impl.saveReading(p);
export const deleteReading = (p) => impl.deleteReading(p);
export const changePin = (p) => impl.changePin(p);
