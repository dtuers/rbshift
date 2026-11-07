-- RB SHIFT – databáze a zabezpečení (Supabase)
-- Spusť celý soubor najednou v Supabase: SQL Editor -> New query -> Run.
-- Je bezpečné ho spustit víckrát.

create extension if not exists pgcrypto;

-- ============ TABULKY ============
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,            -- normalizované přihlašovací jméno (klíč v aplikaci)
  name text not null,
  role text not null check (role in ('admin','leader','emp')),
  team text,
  pos text,
  allow int,
  created_at timestamptz not null default now()
);

-- Všechna ostatní data aplikace (žádosti, přesčasy, zrušené směny, předvolby, rozpis...)
create table if not exists public.docs (
  kind text not null check (kind in ('req','offer','cancel','type','cfg','sh','hn')),
  id text not null,
  team text,
  owner uuid references auth.users(id) on delete cascade,
  ukey text,                                -- username vlastníka
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (kind, id)
);

alter table public.docs add column if not exists created_at timestamptz not null default now();

create table if not exists public.qr (
  code text primary key,
  team text not null,
  leader uuid not null references auth.users(id) on delete cascade,
  pos text,
  used boolean not null default false,
  by_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.notif (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  msg text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notif_user_idx on public.notif(user_id, created_at desc);

create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- ============ POMOCNÉ FUNKCE ============
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.my_team() returns text
language sql stable security definer set search_path = public as
$$ select team from public.profiles where id = auth.uid() $$;

create or replace function public.my_username() returns text
language sql stable security definer set search_path = public as
$$ select username from public.profiles where id = auth.uid() $$;

-- Vedoucí smí číst žádosti jen těch lidí, kteří se přihlásili na přesčas jeho týmu
create or replace function public.applicant_of_my_offers(u text) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from public.docs d
     where d.kind = 'offer'
       and d.team = (select team from public.profiles where id = auth.uid())
       and jsonb_exists(d.data->'apps', u)
   ) $$;

-- Vedoucí nastaví zbývající dovolenou zaměstnanci svého týmu
create or replace function public.set_allow(uname text, v int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if v < 0 or v > 400 then raise exception 'neplatná hodnota'; end if;
  if my_role() = 'admin' or
     (my_role() = 'leader' and exists (select 1 from profiles p where p.username = uname and p.role = 'emp' and p.team = my_team())) then
    update profiles set allow = v where username = uname;
  else
    raise exception 'nemáte oprávnění';
  end if;
end $$;

revoke all on function public.my_role(), public.my_team(), public.my_username(),
  public.applicant_of_my_offers(text), public.set_allow(text, int) from public, anon;
grant execute on function public.my_role(), public.my_team(), public.my_username(),
  public.applicant_of_my_offers(text), public.set_allow(text, int) to authenticated;

-- ============ ATOMICKÉ PŘIHLÁŠKY NA PŘESČAS ============
-- Aby se při současném přihlášení více lidí žádná přihláška neztratila.
create or replace function public.offer_apply(oid text, app jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u text := my_username(); m int;
begin
  if my_role() <> 'emp' then raise exception 'Jen zaměstnanec se může přihlásit'; end if;
  m := (app->>'min')::int;
  if m is null or m <= 0 or m > 7*1440 then raise exception 'Neplatná délka'; end if;
  perform 1 from docs where kind = 'offer' and id = oid and team is distinct from my_team() for update;
  if not found then raise exception 'Nabídka není dostupná'; end if;
  update docs set data = jsonb_set(data, array['apps', u],
      jsonb_build_object('a', app->>'a', 'b', app->>'b', 'ad', app->>'ad', 'bd', app->>'bd', 'min', m, 'st', 'pend'), true)
   where kind = 'offer' and id = oid;
end $$;

create or replace function public.offer_unapply(oid text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := my_username();
begin
  if my_role() <> 'emp' then raise exception 'Jen zaměstnanec'; end if;
  update docs set data = jsonb_set(data, '{apps}', (data->'apps') - u)
   where kind = 'offer' and id = oid and team is distinct from my_team()
     and data->'apps'->u->>'st' = 'pend';
end $$;

create or replace function public.offer_decide(oid text, uname text, s text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'leader' then raise exception 'Jen vedoucí'; end if;
  if s not in ('ok','no') then raise exception 'Neplatný stav'; end if;
  update docs set data = jsonb_set(data, array['apps', uname, 'st'], to_jsonb(s))
   where kind = 'offer' and id = oid and team = my_team() and jsonb_exists(data->'apps', uname);
  if not found then raise exception 'Přihláška nenalezena'; end if;
end $$;

revoke all on function public.offer_apply(text, jsonb), public.offer_unapply(text), public.offer_decide(text, text, text) from public, anon;
grant execute on function public.offer_apply(text, jsonb), public.offer_unapply(text), public.offer_decide(text, text, text) to authenticated;

-- ============ OCHRANA DAT (trigger) ============
-- Chrání před úpravou cizích údajů a před tím, aby si zaměstnanec sám schválil dovolenou či přesčas.
create or replace function public.guard_docs() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := my_role(); u text := my_username();
begin
  if auth.uid() is null or r = 'admin' then return new; end if;   -- admin a server (service role)
  if tg_op = 'UPDATE' then
    if new.kind <> old.kind or new.id <> old.id
       or new.team is distinct from old.team
       or new.owner is distinct from old.owner
       or new.ukey is distinct from old.ukey then
      raise exception 'Tuto změnu nelze provést';
    end if;
  end if;
  if new.kind = 'req' then
    if r = 'emp' and new.data->>'type' = 'dov' and coalesce(new.data->>'st','') <> 'pend' then
      raise exception 'Dovolenou schvaluje vedoucí';
    end if;
    if r = 'leader' and tg_op = 'UPDATE' and (new.data - 'st') is distinct from (old.data - 'st') then
      raise exception 'Vedoucí může měnit jen stav žádosti';
    end if;
  end if;
  if new.kind = 'offer' and r = 'emp' and tg_op = 'UPDATE' then
    if (new.data - 'apps') is distinct from (old.data - 'apps') then
      raise exception 'Nabídku může měnit jen vedoucí';
    end if;
    if (new.data->'apps') - u is distinct from (old.data->'apps') - u then
      raise exception 'Nelze měnit cizí přihlášky';
    end if;
    if (new.data->'apps'->u) is distinct from (old.data->'apps'->u)
       and (new.data->'apps'->u) is not null
       and coalesce(new.data->'apps'->u->>'st','') <> 'pend' then
      raise exception 'Přesčas schvaluje vedoucí';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs
  for each row execute function public.guard_docs();

-- ============ RLS (kdo co vidí a smí) ============
alter table public.profiles  enable row level security;
alter table public.docs      enable row level security;
alter table public.qr        enable row level security;
alter table public.notif     enable row level security;
alter table public.push_subs enable row level security;

-- profiles: číst smí každý přihlášený (jméno, tým, pozice), měnit jen server / funkce set_allow
drop policy if exists profiles_sel on public.profiles;
create policy profiles_sel on public.profiles for select to authenticated using (true);

-- docs
drop policy if exists docs_sel on public.docs;
create policy docs_sel on public.docs for select to authenticated using (
  my_role() = 'admin'
  or kind in ('type','cfg','sh','hn')
  or (kind = 'cancel' and team = my_team())
  or (kind = 'req' and (owner = auth.uid()
        or (my_role() = 'leader' and (team = my_team() or applicant_of_my_offers(ukey)))))
  or (kind = 'offer' and (my_role() = 'leader' or (my_role() = 'emp' and team is distinct from my_team())))
);

drop policy if exists docs_ins on public.docs;
create policy docs_ins on public.docs for insert to authenticated with check (
  my_role() = 'admin'
  or (kind = 'req' and owner = auth.uid() and ukey = my_username() and my_role() = 'emp' and team = my_team())
  or (kind in ('offer','cancel') and my_role() = 'leader' and team = my_team())
);

drop policy if exists docs_upd on public.docs;
create policy docs_upd on public.docs for update to authenticated
using (
  my_role() = 'admin'
  or (kind = 'req' and (owner = auth.uid() or (my_role() = 'leader' and team = my_team())))
  or (kind = 'offer' and ((my_role() = 'leader' and team = my_team()) or (my_role() = 'emp' and team is distinct from my_team())))
  or (kind = 'cancel' and my_role() = 'leader' and team = my_team())
)
with check (
  my_role() = 'admin'
  or (kind = 'req' and (owner = auth.uid() or (my_role() = 'leader' and team = my_team())))
  or (kind = 'offer' and ((my_role() = 'leader' and team = my_team()) or (my_role() = 'emp' and team is distinct from my_team())))
  or (kind = 'cancel' and my_role() = 'leader' and team = my_team())
);

drop policy if exists docs_del on public.docs;
create policy docs_del on public.docs for delete to authenticated using (
  my_role() = 'admin'
  or (kind = 'req' and owner = auth.uid())
  or (kind in ('offer','cancel') and my_role() = 'leader' and team = my_team())
);

-- qr kódy: jen vedoucí svého týmu
drop policy if exists qr_sel on public.qr;
create policy qr_sel on public.qr for select to authenticated using (leader = auth.uid());
drop policy if exists qr_ins on public.qr;
create policy qr_ins on public.qr for insert to authenticated
  with check (leader = auth.uid() and my_role() = 'leader' and team = my_team() and used = false);
drop policy if exists qr_del on public.qr;
create policy qr_del on public.qr for delete to authenticated using (leader = auth.uid() and used = false);

-- oznámení: číst, označit a mazat jen své; vytvořit smí každý přihlášený (aplikace tak upozorňuje ostatní)
drop policy if exists notif_sel on public.notif;
create policy notif_sel on public.notif for select to authenticated using (user_id = auth.uid());
drop policy if exists notif_ins on public.notif;
create policy notif_ins on public.notif for insert to authenticated
  with check (auth.uid() is not null and char_length(title) <= 120 and char_length(coalesce(msg,'')) <= 300);
drop policy if exists notif_upd on public.notif;
create policy notif_upd on public.notif for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notif_del on public.notif;
create policy notif_del on public.notif for delete to authenticated using (user_id = auth.uid());

-- push odběry: každý jen své
drop policy if exists ps_all on public.push_subs;
create policy ps_all on public.push_subs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============ ŽIVÁ SYNCHRONIZACE ============
do $$ begin
  begin alter publication supabase_realtime add table public.docs;    exception when others then null; end;
  begin alter publication supabase_realtime add table public.notif;   exception when others then null; end;
  begin alter publication supabase_realtime add table public.profiles; exception when others then null; end;
end $$;

-- ============ PRVNÍ SUPERADMIN ============
-- 1) V Supabase: Authentication -> Users -> Add user -> Create new user
--      e-mail: u61646d696e@rbshift.example.com   heslo: (silné, vlastní, min. 10 znaků)   [zaškrtni Auto Confirm User]
--      (u61646d696e = slovo "admin" zapsané hexadecimálně; aplikace si e-mail z přihlašovacího jména skládá sama)
-- 2) Potom spusť (tento příkaz můžeš spustit samostatně):
--
-- insert into public.profiles (id, username, name, role)
-- select id, 'admin', 'admin', 'admin' from auth.users where email = 'u61646d696e@rbshift.example.com'
-- on conflict (id) do nothing;
