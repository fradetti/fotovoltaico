#!/usr/bin/env python3
"""Importa i dati dal Google Sheet pubblicato e genera:
  - data/seed.json      (usato dall'adapter locale del sito)
  - data/dev-pins.json  (PIN di sviluppo, SOLO per la modalita' locale)
  - supabase/seed.sql   (da eseguire su Supabase in fase 2)

Uso: python3 scripts/import_sheet.py [--pins-from data/dev-pins.json]
I PIN esistenti in data/dev-pins.json vengono riutilizzati.
"""
import csv
import io
import json
import secrets
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

BASE = ("https://docs.google.com/spreadsheets/d/e/"
        "2PACX-1vRu5nypiq5HN-i0U7pUu4GoOtwYnrr8aKHyaynWfKWjoKuXXx1tbI8AhsYrdYUdsvdnvKbJHy7ES5vN"
        "/pub?output=csv&gid=")
TABS = {2023: "0", 2024: "252764206", 2025: "1432965500", 2026: "857113680"}
MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio",
        "agosto", "settembre", "ottobre", "novembre", "dicembre"]

ROOT = Path(__file__).resolve().parent.parent


def num(s: str) -> float:
    """Numero in formato italiano: '1.130' -> 1130, '16,28' -> 16.28."""
    s = s.strip().replace(".", "").replace(",", ".")
    return float(s)


def fetch(gid: str) -> list[list[str]]:
    with urllib.request.urlopen(BASE + gid, timeout=30) as r:
        text = r.read().decode("utf-8")
    return list(csv.reader(io.StringIO(text)))


def main() -> int:
    readings = []          # dict per lettura
    totals = {}            # (anno, nome) -> kWh dalle righe di totale
    plant_order = []

    for year, gid in TABS.items():
        for row in fetch(gid):
            if len(row) < 8 or not row[0].strip().isdigit():
                continue
            anno, mese, chi = row[0].strip(), row[1].strip().lower(), row[2].strip()
            if not chi or chi.lower().startswith("totale"):
                continue
            if not mese:
                # riga di totale annuo: la usiamo solo per il controllo
                totals[(year, chi)] = num(row[4]) * 1000
                continue
            if mese not in MESI:
                print(f"! mese sconosciuto: {row}", file=sys.stderr)
                continue
            if not row[4].strip() or not row[7].strip():
                continue  # mese non ancora compilato
            if chi not in plant_order:
                plant_order.append(chi)
            readings.append({
                "plant": chi,
                "year": int(anno),
                "month": MESI.index(mese) + 1,
                "kwh": round(num(row[4]) * 1000, 1),
                "kwp": num(row[3]),
                "days": int(num(row[7])),
            })

    # controllo totali
    sums = defaultdict(float)
    for r in readings:
        sums[(r["year"], r["plant"])] += r["kwh"]
    ok = True
    for key, tot in sorted(totals.items()):
        got = sums.get(key, 0)
        flag = "ok" if abs(got - tot) < 1 else "DIVERSO"
        if flag != "ok":
            ok = False
        print(f"{key[0]} {key[1]:<14} sheet={tot:>8.0f}  importato={got:>8.0f}  {flag}")
    print(f"{len(readings)} letture, {len(plant_order)} impianti")

    plants = [{"id": i + 1, "name": n} for i, n in enumerate(plant_order)]
    pid = {p["name"]: p["id"] for p in plants}

    pins_path = ROOT / "data" / "dev-pins.json"
    pins = json.loads(pins_path.read_text()) if pins_path.exists() else {}
    for p in plants:
        pins.setdefault(str(p["id"]), f"{secrets.randbelow(10000):04d}")

    seed = {
        "plants": plants,
        "readings": [
            {"plant_id": pid[r["plant"]], **{k: r[k] for k in ("year", "month", "kwh", "kwp", "days")}}
            for r in readings
        ],
    }
    (ROOT / "data" / "seed.json").write_text(json.dumps(seed, indent=1, ensure_ascii=False))
    pins_path.write_text(json.dumps(pins, indent=1))

    def q(s: str) -> str:
        return "'" + s.replace("'", "''") + "'"

    sql = ["-- Generato da scripts/import_sheet.py. Eseguire DOPO schema.sql.",
           "-- Gli impianti nascono con un PIN casuale sconosciuto: i PIN reali sono in pins.sql (non versionato).",
           "begin;"]
    for p in plants:
        sql.append(f"insert into plants (id, name, pin_hash) values ({p['id']}, {q(p['name'])}, "
                   f"extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')));")
    sql.append("select setval('plants_id_seq', (select max(id) from plants));")
    sql.append("insert into readings (plant_id, year, month, kwh, kwp, days) values")
    sql.append(",\n".join(
        f"  ({r['plant_id']}, {r['year']}, {r['month']}, {r['kwh']:g}, {r['kwp']:g}, {r['days']})"
        for r in seed["readings"]) + ";")
    sql.append("commit;")
    (ROOT / "supabase" / "seed.sql").write_text("\n".join(sql) + "\n")

    # PIN reali per la produzione: 6 cifre, generati una sola volta e mai versionati
    real_path = ROOT / "supabase" / "pins.sql"
    if not real_path.exists():
        lines = ["-- PIN reali (NON committare). Eseguire su Supabase dopo seed.sql, poi distribuire e cancellare questo file.", "begin;"]
        for pl in plants:
            pin = f"{secrets.randbelow(10**6):06d}"
            lines.append(f"update plants set pin_hash = extensions.crypt('{pin}', extensions.gen_salt('bf')) where id = {pl['id']};  -- {pl['name']}: {pin}")
        lines.append("commit;")
        real_path.write_text("\n".join(lines) + "\n")
        print("Generato supabase/pins.sql con i PIN reali")

    print("Scritti data/seed.json, data/dev-pins.json, supabase/seed.sql")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
