-- Statistiche visite. Eseguire nel SQL editor dopo schema.sql (è idempotente).
-- Cosa si registra: pagina, id anonimo casuale del browser (localStorage),
-- dominio di provenienza, tipo di dispositivo. Niente IP, niente cookie.
-- La tabella non è leggibile da anon: si scrive con log_visit() e si leggono
-- solo aggregati con visit_stats().

create table if not exists visits (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  page      text not null,
  visitor   text not null,
  referrer  text,
  device    text not null
);
create index if not exists visits_at_idx on visits (at);
create index if not exists visits_visitor_idx on visits (visitor, at);

alter table visits enable row level security;
revoke all on visits from anon, authenticated;
revoke all on sequence visits_id_seq from anon, authenticated;

create or replace function log_visit(p_page text, p_visitor text, p_referrer text, p_device text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_page is null or p_page not in ('dashboard', 'dati', 'inserisci', 'statistiche') then return; end if;
  if p_visitor is null or p_visitor !~ '^[a-z0-9]{12,32}$' then return; end if;
  if p_device is null or p_device not in ('mobile', 'tablet', 'desktop') then p_device := 'desktop'; end if;
  p_referrer := nullif(left(lower(coalesce(p_referrer, '')), 100), '');
  if p_referrer !~ '^[a-z0-9.-]+$' then p_referrer := null; end if;
  -- ricarica della stessa pagina entro 30 secondi: non è una nuova visita
  if exists (select 1 from visits
             where visitor = p_visitor and page = p_page and at > now() - interval '30 seconds') then
    return;
  end if;
  -- freno agli abusi: oltre 2000 visite in un'ora si smette di registrare
  if (select count(*) from visits where at > now() - interval '1 hour') >= 2000 then return; end if;
  insert into visits (page, visitor, referrer, device) values (p_page, p_visitor, p_referrer, p_device);
end $$;

-- Aggregati sugli ultimi p_days giorni (oggi compreso), con giorni e ore in ora italiana.
create or replace function visit_stats(p_days int)
returns json language sql stable security definer set search_path = public as $$
  with p as (
    select greatest(1, least(coalesce(p_days, 30), 730)) as d,
           (now() at time zone 'Europe/Rome')::date as today
  ), b as (
    select d, today, ((today - (d - 1))::timestamp at time zone 'Europe/Rome') as since from p
  ), v as (
    select (at at time zone 'Europe/Rome') as lt, page, visitor, referrer, device
    from visits, b where at >= b.since
  ), fs as (
    select visitor, min(at) as first_at from visits group by visitor
  )
  select json_build_object(
    'days',         (select d from b),
    'today',        (select today from b),
    'first_visit',  (select min(at) from visits),
    'total_all',    (select count(*) from visits),
    'visitors_all', (select count(*) from fs),
    'visits',       (select count(*) from v),
    'visitors',     (select count(distinct visitor) from v),
    'new_visitors', (select count(*) from fs, b where fs.first_at >= b.since),
    'today_visits', (select count(*) from v, b where v.lt::date = b.today),
    'daily', (select coalesce(json_agg(x order by x.day), '[]') from (
        select g::date as day, count(v.page) as visits, count(distinct v.visitor) as visitors
        from b cross join generate_series(b.today - (b.d - 1), b.today, interval '1 day') g
        left join v on v.lt::date = g::date
        group by g) x),
    'weekly', (select coalesce(json_agg(x order by x.week), '[]') from (
        select date_trunc('week', g)::date as week, count(v.page) as visits, count(distinct v.visitor) as visitors
        from b cross join generate_series(b.today - (b.d - 1), b.today, interval '1 day') g
        left join v on v.lt::date = g::date
        group by 1) x),
    'pages', (select coalesce(json_agg(x order by x.visits desc), '[]') from (
        select page, count(*) as visits, count(distinct visitor) as visitors from v group by page) x),
    'devices', (select coalesce(json_agg(x order by x.visits desc), '[]') from (
        select device, count(*) as visits, count(distinct visitor) as visitors from v group by device) x),
    'referrers', (select coalesce(json_agg(x order by x.visits desc), '[]') from (
        select referrer, count(*) as visits from v where referrer is not null
        group by referrer order by count(*) desc limit 10) x),
    'hours', (select json_agg(coalesce(c, 0) order by h) from generate_series(0, 23) h
        left join (select extract(hour from lt)::int as hh, count(*) as c from v group by 1) x on x.hh = h),
    'weekdays', (select json_agg(coalesce(c, 0) order by w) from generate_series(1, 7) w
        left join (select extract(isodow from lt)::int as ww, count(*) as c from v group by 1) x on x.ww = w)
  );
$$;

revoke all on function log_visit(text, text, text, text) from public;
revoke all on function visit_stats(int) from public;
grant execute on function log_visit(text, text, text, text) to anon, authenticated;
grant execute on function visit_stats(int) to anon, authenticated;

-- Per azzerare le statistiche:  truncate visits;
