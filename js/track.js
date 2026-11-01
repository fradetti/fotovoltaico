// Conteggio visite anonimo: id casuale per browser in localStorage, niente cookie.
// ?notrack su qualunque pagina esclude questo browser, ?track lo riattiva.
import { logVisit } from "./api.js";

const VID = "fv-vid";
const OFF = "fv-notrack";

function ls(fn) { try { return fn(localStorage); } catch { return null; } }

export const isTrackingOff = () => ls((s) => s.getItem(OFF)) === "1";
export function setTrackingOff(off) {
  ls((s) => (off ? s.setItem(OFF, "1") : s.removeItem(OFF)));
}

function visitorId() {
  let id = ls((s) => s.getItem(VID));
  if (!id || !/^[a-z0-9]{12,32}$/.test(id)) {
    const b = crypto.getRandomValues(new Uint8Array(10));
    id = [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 20);
    ls((s) => s.setItem(VID, id));
  }
  return id;
}

function device() {
  const w = Math.min(screen.width, screen.height);
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (coarse && w < 600) return "mobile";
  if (coarse) return "tablet";
  return "desktop";
}

function referrer() {
  try {
    const u = new URL(document.referrer);
    return u.host && u.host !== location.host ? u.hostname.replace(/^www\./, "") : null;
  } catch { return null; }
}

export function track(page) {
  const q = new URLSearchParams(location.search);
  if (q.has("notrack")) setTrackingOff(true);
  if (q.has("track")) setTrackingOff(false);
  if (isTrackingOff()) return;
  logVisit({ page, visitor: visitorId(), referrer: referrer(), device: device() }).catch(() => {});
}
