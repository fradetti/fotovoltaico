# Confronto Fotovoltaico

Sito statico (GitHub Pages) per registrare la produzione mensile di alcuni impianti
fotovoltaici e confrontarne la resa (kWh/kWp).

- `index.html` – dashboard (KPI, resa mensile, classifica, anno su anno, heatmap, tabella)
- `inserisci.html` – inserimento/modifica/cancellazione di un mese, protetto da PIN per impianto
- `js/api.js` – livello dati con due adapter: **locale** (default) e **Supabase**

## Provarlo in locale

```sh
python3 scripts/import_sheet.py      # scarica lo Google Sheet -> data/seed.json, data/dev-pins.json, supabase/seed.sql
python3 -m http.server 8000          # poi apri http://localhost:8000
```

In modalità locale le modifiche restano nel `localStorage` del browser
(link in fondo alla dashboard per ripristinare) e i PIN sono quelli in `data/dev-pins.json`.

## Indice di rendimento

Per ogni mese: resa giornaliera dell'impianto (kWh/kWp/giorno) ÷ mediana del gruppo
nello stesso mese × 100. Elimina l'effetto stagione e dei mesi parziali, quindi
confronta in modo equo anche impianti entrati a metà anno. L'indice annuo è la
media degli indici mensili. I mesi con un solo impianto non hanno indice.

## Passaggio a Supabase (fase 2)

1. Crea un progetto su supabase.com.
2. SQL editor: esegui `supabase/schema.sql`, poi `supabase/seed.sql`.
3. Imposta PIN reali per ogni impianto:
   `update plants set pin_hash = extensions.crypt('NUOVO', extensions.gen_salt('bf')) where name = 'Nome';`
4. In `js/config.js` inserisci Project URL e anon key.

Comandi di amministrazione (nuovo impianto, reset PIN, sblocco) in fondo a `schema.sql`.

## Statistiche visite

`statistiche.html` mostra le visite al sito: totali, visitatori, andamento, pagine, orari, dispositivi, provenienza e chi ha inserito dati.
Il conteggio è anonimo: un id casuale per browser in localStorage, niente cookie, niente IP.
Per attivarlo esegui `supabase/visits.sql` nel SQL editor (si può rieseguire).
Per escludere il proprio browser c'è una casella nella pagina, oppure si apre una pagina qualsiasi con `?notrack` (`?track` per riattivare).
