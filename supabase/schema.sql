-- Schema per Supabase. Eseguire nel SQL editor del progetto, poi seed.sql.
-- Modello di sicurezza:
--   * lettura pubblica (anon) di impianti (solo id, nome) e letture;
--   * nessuna scrittura diretta sulle tabelle: solo tramite funzioni RPC
--     security definer che verificano il PIN (hash bcrypt con pgcrypto);
--   * max 5 PIN errati per impianto ogni 15 minuti.

create extension if not exists pgcrypto with schema extensions;

create table if not exists plants (
  id          serial primary key,
  name        text not null unique,
  pin_hash    text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists readings (
  plant_id    int not null references plants(id) on delete cascade,
  year        int not null check (year between 2000 and 2100),
  month       int not null check (month between 1 and 12),
  kwh         numeric(10,1) not null check (kwh >= 0),
  kwp         numeric(6,2)  not null check (kwp > 0),
  days        int not null check (days between 1 and 31),
  updated_at  timestamptz not null default now(),
  primary key (plant_id, year, month)
);

create table if not exists pin_failures (
  plant_id int not null references plants(id) on delete cascade,
  at       timestamptz not null default now()
);
create index if not exists pin_failures_idx on pin_failures (plant_id, at);

-- Vista pubblica sugli impianti: niente pin_hash.
create or replace view plants_public with (security_invoker = false) as
  select id, name from plants where active order by id;

alter table plants       enable row level security;
alter table readings     enable row level security;
alter table pin_failures enable row level security;

-- Solo lettura pubblica delle letture. Nessuna policy su plants e pin_failures:
-- per anon/authenticated sono del tutto inaccessibili (la vista e' security definer).
drop policy if exists readings_read on readings;
create policy readings_read on readings for select to anon, authenticated using (true);

revoke all on plants, pin_failures from anon, authenticated;
revoke insert, update, delete on readings from anon, authenticated;
grant select on readings, plants_public to anon, authenticated;

-- ------------------------------------------------------------------
-- Verifica PIN con limite di tentativi: restituisce null se ok, altrimenti
-- il messaggio d'errore. Non solleva eccezioni, cosi' l'insert in pin_failures
-- non viene annullato da un rollback.
create or replace function _verify_pin(p_plant_id int, p_pin text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text;
  v_fail int;
begin
  select pin_hash into v_hash from plants where id = p_plant_id and active;
  if v_hash is null then return 'Impianto inesistente'; end if;

  select count(*) into v_fail from pin_failures
    where plant_id = p_plant_id and at > now() - interval '15 minutes';
  if v_fail >= 5 then return 'Troppi tentativi con PIN errato: riprova tra 15 minuti'; end if;

  if p_pin is null or crypt(p_pin, v_hash) <> v_hash then
    insert into pin_failures (plant_id) values (p_plant_id);
    return 'PIN errato';
  end if;

  delete from pin_failures where plant_id = p_plant_id;
  return null;  -- ok
end $$;

-- Le RPC restituiscono json {ok:true} oppure {error:"..."} invece di sollevare
-- eccezioni, cosi' il tentativo fallito resta registrato.
create or replace function save_reading(
  p_plant_id int, p_pin text, p_year int, p_month int,
  p_kwh numeric, p_kwp numeric, p_days int)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_err text;
begin
  v_err := _verify_pin(p_plant_id, p_pin);
  if v_err is not null then return json_build_object('error', v_err); end if;

  if p_days < 1 or p_days > extract(day from (make_date(p_year, p_month, 1) + interval '1 month - 1 day')) then
    return json_build_object('error', 'Numero di giorni non valido per il mese');
  end if;

  insert into readings (plant_id, year, month, kwh, kwp, days, updated_at)
    values (p_plant_id, p_year, p_month, p_kwh, p_kwp, p_days, now())
  on conflict (plant_id, year, month) do update
    set kwh = excluded.kwh, kwp = excluded.kwp, days = excluded.days, updated_at = now();
  return json_build_object('ok', true);
end $$;

create or replace function delete_reading(p_plant_id int, p_pin text, p_year int, p_month int)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_err text;
begin
  v_err := _verify_pin(p_plant_id, p_pin);
  if v_err is not null then return json_build_object('error', v_err); end if;
  delete from readings where plant_id = p_plant_id and year = p_year and month = p_month;
  return json_build_object('ok', true);
end $$;

create or replace function change_pin(p_plant_id int, p_old_pin text, p_new_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_err text;
begin
  v_err := _verify_pin(p_plant_id, p_old_pin);
  if v_err is not null then return json_build_object('error', v_err); end if;
  if p_new_pin !~ '^\d{4,8}$' then
    return json_build_object('error', 'Il PIN deve avere da 4 a 8 cifre');
  end if;
  update plants set pin_hash = crypt(p_new_pin, gen_salt('bf')) where id = p_plant_id;
  return json_build_object('ok', true);
end $$;

revoke all on function _verify_pin(int, text) from public, anon, authenticated;
grant execute on function save_reading(int, text, int, int, numeric, numeric, int) to anon;
grant execute on function delete_reading(int, text, int, int) to anon;
grant execute on function change_pin(int, text, text) to anon;

-- ------------------------------------------------------------------
-- Amministrazione (da SQL editor):
--   nuovo impianto:  insert into plants (name, pin_hash) values ('Nome', extensions.crypt('123456', extensions.gen_salt('bf')));
--   reset PIN:       update plants set pin_hash = extensions.crypt('654321', extensions.gen_salt('bf')) where name = 'Nome';
--   sblocco:         delete from pin_failures where plant_id = (select id from plants where name = 'Nome');
