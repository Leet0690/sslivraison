import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('Migration, permissions et parcours de livraison PostgreSQL', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const ids = {
    customer: '11111111-1111-4111-8111-111111111111',
    other: '22222222-2222-4222-8222-222222222222',
    admin: '33333333-3333-4333-8333-333333333333',
    driver: '44444444-4444-4444-8444-444444444444',
    otherDriver: '55555555-5555-4555-8555-555555555555'
  };
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
  `);
  const sql = await readFile(new URL('../supabase.sql', import.meta.url), 'utf8');
  assert.equal(sql, await readFile(new URL('../supabase/migrations/202610100001_operations.sql', import.meta.url), 'utf8'));
  await db.exec(sql);
  for (const id of Object.values(ids)) await db.query('insert into auth.users(id) values($1)', [id]);
  await db.query("update public.profiles set role='admin' where id=$1", [ids.admin]);
  await db.query("update public.profiles set role='driver' where id=any($1::uuid[])", [[ids.driver, ids.otherDriver]]);
  const as = async (id) => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
    await db.exec('set role authenticated');
  };
  const create = async (key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') => {
    return (await db.query(`select * from public.create_order(
      'courses','Pommes et lait','Rue de test 12','Client Test','0612345678','Centre','Près du marché',
      100,'{}'::jsonb,$1::uuid)`, [key])).rows[0];
  };
  let order;
  await t.test('client : tarif imposé, statut initial et protection contre le double envoi', async () => {
    await as(ids.customer); order = await create();
    assert.equal(Number(order.delivery_fee), 10); assert.equal(order.status, 'pending'); assert.equal(order.driver_id, null);
    assert.equal((await create()).id, order.id);
    assert.equal((await db.query('select count(*) as n from public.orders')).rows[0].n, 1);
    await assert.rejects(db.query("update public.orders set delivery_fee=1 where id=$1", [order.id]), /permission denied/i);
    await assert.rejects(db.query("insert into public.orders(customer_id,service,details,delivery_address,status) values($1,'courses','Test','Rue test','delivered')", [ids.customer]), /permission denied/i);
  });
  await t.test('un client ne peut ni lire un autre client ni gérer les livreurs', async () => {
    await as(ids.other);
    assert.equal((await db.query('select * from public.orders')).rows.length, 0);
    assert.equal((await db.query('select * from public.order_events')).rows.length, 0);
    await assert.rejects(db.query('select public.assign_order($1,$2)', [order.id, ids.driver]), /administrateur/i);
    await assert.rejects(db.query('select public.cancel_customer_order($1)', [order.id]), /inaccessible/i);
    await assert.rejects(db.query('select public.publish_driver_location(34,-5,10)'), /livraison active/i);
  });
  await t.test('un livreur ne peut pas modifier une commande non attribuée', async () => {
    await as(ids.driver);
    await assert.rejects(db.query("select public.staff_update_order($1,'pending',5,null)", [order.id]), /inaccessible/i);
  });
  await t.test('administrateur : attribution et coordonnées des livreurs', async () => {
    await as(ids.admin);
    await assert.rejects(db.query('select public.assign_order($1,$2)', [order.id, ids.customer]), /compte livreur/i);
    await db.query("select public.update_driver_profile($1,'Yassine Test','0612345679')", [ids.driver]);
    await db.query('select public.assign_order($1,$2)', [order.id, ids.driver]);
    assert.equal((await db.query('select driver_id from public.orders')).rows[0].driver_id, ids.driver);
  });
  await t.test('étapes contrôlées et budget respecté', async () => {
    await as(ids.driver);
    await assert.rejects(db.query("select public.staff_update_order($1,'delivered',25,35)", [order.id]), /changement de statut/i);
    await db.query("select public.staff_update_order($1,'accepted',null,null)", [order.id]);
    await db.query("select public.staff_update_order($1,'shopping',null,null)", [order.id]);
    await assert.rejects(db.query("select public.staff_update_order($1,'shopping',101,null)", [order.id]), /budget/i);
    await db.query("select public.staff_update_order($1,'on_the_way',25,null)", [order.id]);
  });
  await t.test('position visible uniquement au bon client pendant la livraison', async () => {
    await as(ids.otherDriver);
    await assert.rejects(db.query('select public.publish_driver_location(34.26,-5.92,20)'), /livraison active/i);
    await as(ids.driver);
    await db.query('select public.publish_driver_location(34.26,-5.92,20)');
    await as(ids.customer);
    assert.equal((await db.query('select * from public.driver_locations')).rows.length, 1);
    assert.equal((await db.query('select * from public.get_order_driver($1)', [order.id])).rows[0].phone, '0612345679');
    await as(ids.other);
    assert.equal((await db.query('select * from public.driver_locations')).rows.length, 0);
    assert.equal((await db.query('select * from public.get_order_driver($1)', [order.id])).rows.length, 0);
    await as(ids.driver); await db.query('select public.stop_driver_location()');
    await as(ids.customer); assert.equal((await db.query('select * from public.driver_locations')).rows.length, 0);
    await as(ids.driver); await db.query('select public.publish_driver_location(34.26,-5.92,20)');
    await db.exec('reset role');
    await db.exec("update public.driver_locations set updated_at=now()-interval '3 minutes'");
    await as(ids.customer); assert.equal((await db.query('select * from public.driver_locations')).rows.length, 0);
  });
  await t.test('encaissement cohérent, journal et compteur du jour', async () => {
    await as(ids.driver);
    await assert.rejects(db.query("select public.staff_update_order($1,'delivered',25,10)", [order.id]), /achats.*10 DH/i);
    await db.query("select public.staff_update_order($1,'delivered',25,35)", [order.id]);
    const stored = (await db.query('select * from public.orders')).rows[0];
    assert.equal(Number(stored.cash_received), 35); assert.ok(stored.delivered_at);
    const summary = (await db.query('select public.team_daily_summary() as data')).rows[0].data;
    assert.equal(summary.delivered_today, 1); assert.equal(summary.fees_today, 10); assert.equal(summary.purchases_today, 25); assert.equal(summary.cash_today, 35);
    await assert.rejects(db.query("select public.staff_update_order($1,'accepted',null,null)", [order.id]), /terminée/i);
    await as(ids.customer);
    assert.equal((await db.query('select * from public.driver_locations')).rows.length, 0);
    assert.equal((await db.query('select * from public.order_events')).rows.length, 6);
    await db.exec('reset role');
    await db.query("update public.orders set delivered_at=now()-interval '2 days' where id=$1", [order.id]);
    await as(ids.admin);
    assert.equal((await db.query('select public.team_daily_summary() as data')).rows[0].data.delivered_today, 0);
  });
  await t.test('annulation client seulement avant acceptation', async () => {
    await as(ids.customer);
    const next = await create('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await db.query('select public.cancel_customer_order($1)', [next.id]);
    assert.equal((await db.query('select status from public.orders where id=$1', [next.id])).rows[0].status, 'cancelled');
    await assert.rejects(db.query('select public.cancel_customer_order($1)', [order.id]), /déjà acceptée/i);
  });
  await t.test('migration rejouable sans perdre les commandes ou les rôles', async () => {
    await db.exec('reset role');
    await db.exec(sql);
    await db.exec(sql);
    assert.equal((await db.query('select count(*) as n from public.orders')).rows[0].n, 2);
    assert.equal((await db.query('select role from public.profiles where id=$1', [ids.admin])).rows[0].role, 'admin');
    await as(ids.customer); await assert.rejects(db.query('delete from public.orders'), /permission denied/i);
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.orders'), /permission denied/i);
    await assert.rejects(db.query('select public.team_daily_summary()'), /permission denied/i);
  });
});

test('Mise à jour du schéma historique avec commandes existantes', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create type public.order_status as enum ('pending','accepted','shopping','on_the_way','delivered','cancelled');
    create type public.service_type as enum ('courses','pharmacie','snack','billets','autre');
    create table public.profiles(id uuid primary key references auth.users(id),full_name text not null,phone text,role text not null default 'customer',created_at timestamptz default now());
    create table public.orders(id uuid primary key default gen_random_uuid(),customer_id uuid references public.profiles(id),driver_id uuid references public.profiles(id),
      service public.service_type not null,details text not null,delivery_address text not null,status public.order_status default 'pending',
      delivery_fee numeric(6,2) default 10,latitude double precision,longitude double precision,created_at timestamptz default now(),updated_at timestamptz default now());
    create table public.driver_locations(driver_id uuid primary key references public.profiles(id),latitude double precision not null,longitude double precision not null,updated_at timestamptz default now());
    insert into auth.users(id) values('11111111-1111-4111-8111-111111111111');
    insert into public.profiles(id,full_name) values('11111111-1111-4111-8111-111111111111','Client existant');
    insert into public.orders(customer_id,service,details,delivery_address) values('11111111-1111-4111-8111-111111111111','courses','Ancienne commande','Rue historique');
    grant all on public.orders to anon,authenticated;
    alter table public.orders enable row level security;
    create policy "Customers create orders" on public.orders for insert with check(auth.uid()=customer_id);
    create policy "Customers view own orders" on public.orders for select using(auth.uid()=customer_id);
  `);
  await db.exec(await readFile(new URL('../supabase.sql', import.meta.url), 'utf8'));
  assert.equal((await db.query('select details from public.orders')).rows[0].details, 'Ancienne commande');
  assert.equal((await db.query("select has_table_privilege('authenticated','public.orders','insert') as allowed")).rows[0].allowed, false);
  assert.equal((await db.query('select customer_name,delivered_at from public.orders')).rows[0].delivered_at, null);
  await db.query("insert into auth.users(id,raw_user_meta_data) values('66666666-6666-4666-8666-666666666666',$1)", [{ full_name: 'Compte Test', role: 'admin' }]);
  assert.equal((await db.query("select role from public.profiles where id='66666666-6666-4666-8666-666666666666'")).rows[0].role, 'customer');
});
