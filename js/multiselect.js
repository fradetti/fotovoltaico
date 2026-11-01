// Menu a tendina a selezione multipla (checkbox in un popover).
// createMultiSelect(host, { label, options: [{value, label, color?}], selected: Set, onChange, unit })
// Restituisce { set(selectedSet), get() }.
import { esc } from "./common.js";

let openOne = null;
document.addEventListener("click", (e) => {
  if (openOne && !openOne.contains(e.target)) close(openOne);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openOne) {
    const btn = openOne.querySelector(".ms-btn");
    close(openOne);
    btn.focus();
  }
});
function close(el) {
  el.classList.remove("open");
  el.querySelector(".ms-btn").setAttribute("aria-expanded", "false");
  if (openOne === el) openOne = null;
}

export function createMultiSelect(host, { label, options, selected, onChange, unit = "selezionati" }) {
  let sel = new Set(selected);
  host.classList.add("ms");
  host.innerHTML = `
    <button type="button" class="ms-btn" aria-haspopup="true" aria-expanded="false">
      <span class="ms-label">${esc(label)}</span><span class="ms-value"></span>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
    <div class="ms-panel" role="group" aria-label="${esc(label)}">
      <div class="ms-quick"><button type="button" data-q="all">Tutti</button><button type="button" data-q="none">Nessuno</button></div>
      ${options.map((o) => `
        <label class="ms-opt">
          <input type="checkbox" value="${esc(o.value)}">
          ${o.color ? `<span class="sw" style="--c:${o.color}"></span>` : ""}${esc(o.label)}
        </label>`).join("")}
    </div>`;
  const btn = host.querySelector(".ms-btn");
  const boxes = [...host.querySelectorAll(".ms-opt input")];
  const conv = (v) => (typeof options[0]?.value === "number" ? Number(v) : v);

  function paint() {
    boxes.forEach((b) => { b.checked = sel.has(conv(b.value)); });
    const n = sel.size;
    const names = options.filter((o) => sel.has(o.value)).map((o) => o.short ?? o.label);
    host.querySelector(".ms-value").textContent =
      n === options.length ? "Tutti" : n === 0 ? "Nessuno" : n <= 2 ? names.join(", ") : `${n} ${unit}`;
  }
  function emit() { paint(); onChange(new Set(sel)); }

  btn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = host.classList.contains("open");
    if (openOne && openOne !== host) close(openOne);
    if (isOpen) close(host);
    else { host.classList.add("open"); btn.setAttribute("aria-expanded", "true"); openOne = host; }
  };
  boxes.forEach((b) => {
    b.onchange = () => { const v = conv(b.value); b.checked ? sel.add(v) : sel.delete(v); emit(); };
  });
  host.querySelector('[data-q="all"]').onclick = () => { sel = new Set(options.map((o) => o.value)); emit(); };
  host.querySelector('[data-q="none"]').onclick = () => { sel = new Set(); emit(); };

  paint();
  return {
    set(s) { sel = new Set(s); paint(); },
    get: () => new Set(sel),
  };
}
