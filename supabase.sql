-- Schéma MVP SSlivraison. À exécuter dans Supabase > SQL Editor.
create extension if not exists "pgcrypto";
do $$ begin create type order_status as enum ('pending','accepted','shopping','on_the_way','delivered','cancelled'); exception when duplicate_object then null; end $$;
do $$ begin create type service_type as enum ('courses','pharmacie','snack','billets','autre'); exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role text not null default 'customer' check (role in ('customer','driver','admin')),
  created_at timestamptz not null default now()
);
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  driver_id uuid references public.profiles(id),
  service service_type not null,
  details text not null,
  delivery_address text not null,
  status order_status not null default 'pending',
  delivery_fee numeric(6,2) not null default 10,
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', 'Client SSlivraison'), 'customer')
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();
alter table public.profiles enable row level security;
alter table public.orders enable row level security;
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
drop policy if exists "Customers view own orders" on public.orders;
create policy "Customers view own orders" on public.orders for select using (auth.uid() = customer_id or auth.uid() = driver_id);
drop policy if exists "Customers create orders" on public.orders;
create policy "Customers create orders" on public.orders for insert with check (auth.uid() = customer_id);
drop policy if exists "Drivers update assigned orders" on public.orders;
create policy "Drivers update assigned orders" on public.orders for update using (auth.uid() = driver_id);
create or replace function public.is_admin()
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;
drop policy if exists "Admins manage all orders" on public.orders;
create policy "Admins manage all orders" on public.orders for all using (public.is_admin()) with check (public.is_admin());
create table if not exists public.driver_locations (driver_id uuid primary key references public.profiles(id) on delete cascade, latitude double precision not null, longitude double precision not null, updated_at timestamptz not null default now());
alter table public.driver_locations enable row level security;
drop policy if exists "Drivers manage own location" on public.driver_locations;
create policy "Drivers manage own location" on public.driver_locations for all using (auth.uid() = driver_id) with check (auth.uid() = driver_id);
drop policy if exists "Admins view driver locations" on public.driver_locations;
create policy "Admins view driver locations" on public.driver_locations for select using (public.is_admin());
