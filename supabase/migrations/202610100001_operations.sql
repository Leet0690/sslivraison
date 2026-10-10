-- SSlivraison : installation ou mise à jour, sans suppression des commandes.
-- Exécuter ce fichier entièrement dans Supabase > SQL Editor.
begin;
do $$ begin create type public.order_status as enum ('pending','accepted','shopping','on_the_way','delivered','cancelled'); exception when duplicate_object then null; end $$;
do $$ begin create type public.service_type as enum ('courses','pharmacie','snack','billets','autre'); exception when duplicate_object then null; end $$;
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null, phone text,
  role text not null default 'customer' check (role in ('customer','driver','admin')),
  created_at timestamptz not null default now()
);
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  driver_id uuid references public.profiles(id),
  service public.service_type not null, details text not null,
  delivery_address text not null,
  status public.order_status not null default 'pending',
  delivery_fee numeric(6,2) not null default 10,
  latitude double precision, longitude double precision,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.orders add column if not exists customer_name text;
alter table public.orders add column if not exists customer_phone text;
alter table public.orders add column if not exists quarter text;
alter table public.orders add column if not exists landmark text;
alter table public.orders add column if not exists budget numeric(10,2);
alter table public.orders add column if not exists service_data jsonb not null default '{}';
alter table public.orders add column if not exists purchase_amount numeric(10,2);
alter table public.orders add column if not exists cash_received numeric(10,2);
alter table public.orders add column if not exists delivered_at timestamptz;
alter table public.orders add column if not exists request_key uuid;
create unique index if not exists orders_request_key on public.orders(customer_id,request_key);
create index if not exists orders_customer_created on public.orders(customer_id,created_at desc);
create index if not exists orders_driver_status on public.orders(driver_id,status,created_at desc);
create index if not exists orders_delivered on public.orders(delivered_at) where status = 'delivered';
alter table public.orders drop constraint if exists orders_fixed_fee;
alter table public.orders add constraint orders_fixed_fee check (delivery_fee = 10) not valid;
alter table public.orders drop constraint if exists orders_amounts;
alter table public.orders add constraint orders_amounts check (
  (budget is null or budget >= 0) and (purchase_amount is null or purchase_amount >= 0)
  and (cash_received is null or cash_received >= 0)
) not valid;
create table if not exists public.driver_locations (
  driver_id uuid primary key references public.profiles(id) on delete cascade,
  latitude double precision not null, longitude double precision not null,
  updated_at timestamptz not null default now()
);
alter table public.driver_locations add column if not exists accuracy double precision;
alter table public.driver_locations add column if not exists is_sharing boolean not null default false;
create table if not exists public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null, status public.order_status not null,
  message text not null, created_at timestamptz not null default now()
);
create index if not exists events_order_date on public.order_events(order_id,created_at);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,full_name,role)
  values(new.id,coalesce(nullif(new.raw_user_meta_data->>'full_name',''),'Client SSlivraison'),'customer')
  on conflict(id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
-- Réparer aussi les comptes créés avant l'installation du trigger.
insert into public.profiles(id,full_name,role)
select id,coalesce(nullif(raw_user_meta_data->>'full_name',''),'Client SSlivraison'),'customer' from auth.users
on conflict(id) do nothing;

create or replace function public.current_app_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = (select auth.uid());
$$;
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_app_role() = 'admin',false);
$$;

-- L'API autorise les lectures par RLS ; les écritures passent par les fonctions contrôlées.
alter table public.profiles enable row level security;
alter table public.orders enable row level security;
alter table public.driver_locations enable row level security;
alter table public.order_events enable row level security;
revoke all on public.profiles,public.orders,public.driver_locations,public.order_events from anon,authenticated;
grant select on public.profiles,public.orders,public.driver_locations,public.order_events to authenticated;
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists "Customers view own orders" on public.orders;
drop policy if exists "Customers create orders" on public.orders;
drop policy if exists "Drivers update assigned orders" on public.orders;
drop policy if exists "Admins manage all orders" on public.orders;
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated using (
  customer_id = (select auth.uid()) or (select public.is_admin())
  or (driver_id = (select auth.uid()) and (select public.current_app_role()) = 'driver')
);
drop policy if exists "Drivers manage own location" on public.driver_locations;
drop policy if exists "Admins view driver locations" on public.driver_locations;
drop policy if exists locations_read on public.driver_locations;
create policy locations_read on public.driver_locations for select to authenticated using (
  driver_id = (select auth.uid()) or (select public.is_admin()) or (
    is_sharing and updated_at > now() - interval '2 minutes' and exists (
      select 1 from public.orders o where o.customer_id = (select auth.uid())
      and o.driver_id = driver_locations.driver_id
      and o.status in ('accepted','shopping','on_the_way')
    )
  )
);
drop policy if exists events_read on public.order_events;
create policy events_read on public.order_events for select to authenticated using (
  exists(select 1 from public.orders o where o.id = order_id)
);
create or replace function public.audit_order()
returns trigger language plpgsql security definer set search_path = '' as $$
declare kind text; msg text;
begin
  if TG_OP = 'INSERT' then kind := 'created'; msg := 'Commande reçue';
  elsif new.status is distinct from old.status then kind := 'status'; msg := 'Statut : ' || new.status;
  elsif new.driver_id is distinct from old.driver_id then kind := 'assignment'; msg := 'Livreur attribué ou réattribué';
  elsif new.purchase_amount is distinct from old.purchase_amount then kind := 'purchase'; msg := 'Montant des achats enregistré';
  else return new; end if;
  insert into public.order_events(order_id,actor_id,event_type,status,message)
  values(new.id,auth.uid(),kind,new.status,msg);
  return new;
end $$;
drop trigger if exists audit_order on public.orders;
create trigger audit_order after insert or update on public.orders for each row execute function public.audit_order();

create or replace function public.create_order(
  p_service public.service_type, p_details text, p_address text,
  p_name text, p_phone text, p_quarter text, p_landmark text,
  p_budget numeric, p_service_data jsonb, p_request_key uuid
) returns public.orders language plpgsql security definer set search_path = '' as $$
declare result public.orders; customer uuid := auth.uid(); contact text;
begin
  if customer is null or public.current_app_role() is distinct from 'customer' then
    raise exception 'Une session client est nécessaire.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext(customer::text));
  select * into result from public.orders where customer_id = customer and request_key = p_request_key;
  if found then return result; end if;
  contact := regexp_replace(coalesce(p_phone,''),'[[:space:]-]','','g');
  if length(trim(coalesce(p_name,''))) not between 2 and 100
    or contact !~ '^(0[5-7][0-9]{8}|\+212[5-7][0-9]{8})$'
    or length(trim(coalesce(p_address,''))) not between 5 and 500
    or length(trim(coalesce(p_details,''))) not between 3 and 2000
    or length(trim(coalesce(p_quarter,''))) not between 2 and 100
    or length(coalesce(p_landmark,'')) > 200 or p_request_key is null then
    raise exception 'Vérifiez le nom, le téléphone marocain, le quartier et les détails.';
  end if;
  if p_budget is not null and (p_budget < 0 or p_budget > 100000) then raise exception 'Budget invalide.'; end if;
  if p_service = 'courses' and p_budget is null then raise exception 'Indiquez le budget maximum des courses.'; end if;
  if p_service_data is null or jsonb_typeof(p_service_data) <> 'object' or octet_length(p_service_data::text) > 4000 then
    raise exception 'Informations du service invalides.'; end if;
  if p_service = 'snack' and length(trim(coalesce(p_service_data->>'shop',''))) < 2 then raise exception 'Indiquez le snack.'; end if;
  if p_service = 'billets' then
    if length(trim(coalesce(p_service_data->>'departure',''))) < 2
      or length(trim(coalesce(p_service_data->>'destination',''))) < 2
      or coalesce(p_service_data->>'travel_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or coalesce(p_service_data->>'passengers','') !~ '^([1-9]|10)$' then
      raise exception 'Vérifiez les informations du trajet.'; end if;
    if (p_service_data->>'travel_date')::date < (now() at time zone 'Africa/Casablanca')::date then
      raise exception 'La date de voyage est passée.'; end if;
  end if;
  if (select count(*) from public.orders where customer_id = customer and created_at > now()-interval '1 minute') >= 3 then
    raise exception 'Trop de demandes. Réessayez dans une minute.'; end if;
  insert into public.orders(customer_id,service,details,delivery_address,customer_name,customer_phone,quarter,landmark,budget,service_data,request_key)
  values(customer,p_service,trim(p_details),trim(p_address),trim(p_name),contact,trim(p_quarter),trim(p_landmark),p_budget,p_service_data,p_request_key)
  returning * into result;
  return result;
end $$;

create or replace function public.assign_order(p_order_id uuid,p_driver_id uuid)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare result public.orders;
begin
  if not public.is_admin() then raise exception 'Réservé à l’administrateur.' using errcode='42501'; end if;
  select * into result from public.orders where id = p_order_id for update;
  if not found then raise exception 'Commande introuvable.'; end if;
  if result.status in ('delivered','cancelled') then raise exception 'Cette commande est terminée.'; end if;
  if p_driver_id is null or not exists(select 1 from public.profiles where id=p_driver_id and role='driver') then
    raise exception 'Choisissez un compte livreur.'; end if;
  update public.orders set driver_id=p_driver_id,updated_at=now() where id=p_order_id returning * into result;
  return result;
end $$;

create or replace function public.staff_update_order(
  p_order_id uuid,p_status public.order_status,
  p_purchase_amount numeric default null,p_cash_received numeric default null
) returns public.orders language plpgsql security definer set search_path = '' as $$
declare result public.orders; staff_role text := public.current_app_role(); amount numeric;
begin
  select * into result from public.orders where id=p_order_id for update;
  if not found or not coalesce(staff_role='admin' or (staff_role='driver' and result.driver_id=auth.uid()),false) then
    raise exception 'Commande inaccessible.' using errcode='42501'; end if;
  if result.status in ('delivered','cancelled') then raise exception 'Cette commande est terminée.'; end if;
  if p_status is null then raise exception 'Statut invalide.'; end if;
  if p_status <> result.status and not (
    (result.status='pending' and p_status='accepted' and result.driver_id is not null)
    or (result.status='accepted' and p_status in ('shopping','on_the_way'))
    or (result.status='shopping' and p_status='on_the_way')
    or (result.status='on_the_way' and p_status='delivered')
    or (p_status='cancelled' and staff_role='admin')
  ) then raise exception 'Ce changement de statut n’est pas autorisé.'; end if;
  amount := coalesce(p_purchase_amount,result.purchase_amount);
  if amount is not null and (amount < 0 or amount > 100000 or (result.budget is not null and amount > result.budget)) then
    raise exception 'Les achats dépassent le budget ou le montant est invalide.'; end if;
  if p_cash_received is not null and p_status <> 'delivered' then raise exception 'Enregistrez l’encaissement à la livraison.'; end if;
  if p_status='delivered' and (amount is null or p_cash_received is null or p_cash_received <> amount+10) then
    raise exception 'Confirmez les achats et la somme encaissée : achats + 10 DH.'; end if;
  update public.orders set status=p_status,purchase_amount=amount,
    cash_received=case when p_status='delivered' then p_cash_received else cash_received end,
    delivered_at=case when p_status='delivered' then now() else delivered_at end,
    updated_at=now() where id=p_order_id returning * into result;
  return result;
end $$;

create or replace function public.cancel_customer_order(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare result public.orders;
begin
  select * into result from public.orders where id=p_order_id and customer_id=auth.uid() for update;
  if not found then raise exception 'Commande inaccessible.' using errcode='42501'; end if;
  if result.status <> 'pending' then raise exception 'Contactez l’équipe pour annuler une commande déjà acceptée.'; end if;
  update public.orders set status='cancelled',updated_at=now() where id=p_order_id returning * into result;
  return result;
end $$;

create or replace function public.get_order_driver(p_order_id uuid)
returns table(id uuid,full_name text,phone text)
language sql stable security definer set search_path = '' as $$
  select p.id,p.full_name,p.phone from public.orders o join public.profiles p on p.id=o.driver_id
  where o.id=p_order_id and (o.customer_id=auth.uid() or o.driver_id=auth.uid() or public.is_admin());
$$;
create or replace function public.team_daily_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; team_role text := public.current_app_role();
begin
  if team_role is null or team_role not in ('driver','admin') then raise exception 'Accès équipe requis.' using errcode='42501'; end if;
  select jsonb_build_object(
    'pending',count(*) filter(where status='pending'),
    'active',count(*) filter(where status in ('accepted','shopping','on_the_way')),
    'delivered_today',count(*) filter(where status='delivered' and (delivered_at at time zone 'Africa/Casablanca')::date=(now() at time zone 'Africa/Casablanca')::date),
    'purchases_today',coalesce(sum(purchase_amount) filter(where status='delivered' and (delivered_at at time zone 'Africa/Casablanca')::date=(now() at time zone 'Africa/Casablanca')::date),0),
    'fees_today',coalesce(sum(delivery_fee) filter(where status='delivered' and (delivered_at at time zone 'Africa/Casablanca')::date=(now() at time zone 'Africa/Casablanca')::date),0),
    'cash_today',coalesce(sum(cash_received) filter(where status='delivered' and (delivered_at at time zone 'Africa/Casablanca')::date=(now() at time zone 'Africa/Casablanca')::date),0)
  ) into result from public.orders where team_role='admin' or driver_id=auth.uid();
  return result;
end $$;

create or replace function public.publish_driver_location(p_latitude double precision,p_longitude double precision,p_accuracy double precision)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.current_app_role() is distinct from 'driver' or not exists(
    select 1 from public.orders where driver_id=auth.uid() and status in ('accepted','shopping','on_the_way')
  ) then raise exception 'Le GPS nécessite une livraison active attribuée.' using errcode='42501'; end if;
  if p_latitude is null or p_longitude is null or not (p_latitude between -90 and 90)
    or not (p_longitude between -180 and 180) or p_accuracy is null or not (p_accuracy >= 0 and p_accuracy < 100000) then
    raise exception 'Coordonnées invalides.'; end if;
  insert into public.driver_locations(driver_id,latitude,longitude,accuracy,is_sharing,updated_at)
  values(auth.uid(),p_latitude,p_longitude,p_accuracy,true,now())
  on conflict(driver_id) do update set latitude=excluded.latitude,longitude=excluded.longitude,
    accuracy=excluded.accuracy,is_sharing=true,updated_at=now();
end $$;
create or replace function public.stop_driver_location()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.current_app_role() is distinct from 'driver' then raise exception 'Compte livreur requis.' using errcode='42501'; end if;
  update public.driver_locations set is_sharing=false,updated_at=now() where driver_id=auth.uid();
end $$;

create or replace function public.update_driver_profile(p_driver_id uuid,p_name text,p_phone text)
returns void language plpgsql security definer set search_path = '' as $$
declare contact text := regexp_replace(coalesce(p_phone,''),'[[:space:]-]','','g');
begin
  if not public.is_admin() then raise exception 'Réservé à l’administrateur.' using errcode='42501'; end if;
  if length(trim(coalesce(p_name,''))) not between 2 and 100 or contact !~ '^(0[5-7][0-9]{8}|\+212[5-7][0-9]{8})$' then
    raise exception 'Vérifiez le nom et le téléphone marocain.'; end if;
  update public.profiles set full_name=trim(p_name),phone=contact where id=p_driver_id and role='driver';
  if not found then raise exception 'Compte livreur introuvable.'; end if;
end $$;

revoke all on function public.handle_new_user(),public.audit_order() from public,anon,authenticated;
revoke all on function public.current_app_role(),public.is_admin(),
  public.create_order(public.service_type,text,text,text,text,text,text,numeric,jsonb,uuid),
  public.assign_order(uuid,uuid),public.staff_update_order(uuid,public.order_status,numeric,numeric),
  public.cancel_customer_order(uuid),public.get_order_driver(uuid),public.team_daily_summary(),public.update_driver_profile(uuid,text,text),
  public.publish_driver_location(double precision,double precision,double precision),
  public.stop_driver_location() from public,anon,authenticated;
grant execute on function public.current_app_role(),public.is_admin(),
  public.create_order(public.service_type,text,text,text,text,text,text,numeric,jsonb,uuid),
  public.assign_order(uuid,uuid),public.staff_update_order(uuid,public.order_status,numeric,numeric),
  public.cancel_customer_order(uuid),public.get_order_driver(uuid),public.team_daily_summary(),public.update_driver_profile(uuid,text,text),
  public.publish_driver_location(double precision,double precision,double precision),
  public.stop_driver_location() to authenticated;
-- Ajouter les tables au temps réel si le projet possède cette publication.
do $$
declare relation text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach relation in array array['orders','driver_locations'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=relation) then
        execute format('alter publication supabase_realtime add table public.%I',relation);
      end if;
    end loop;
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
