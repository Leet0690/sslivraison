import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { Window } from 'happy-dom';

const customerId = '11111111-1111-4111-8111-111111111111';
const driverId = '44444444-4444-4444-8444-444444444444';
const fixture = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customer_id: customerId, driver_id: driverId,
  service: 'courses', details: '<img src=x onerror=alert(1)> et lait', delivery_address: 'Rue de test 12',
  customer_name: 'Client Test', customer_phone: '0612345678', quarter: 'Centre', landmark: '',
  status: 'accepted', delivery_fee: 10, budget: 100, purchase_amount: null, cash_received: null,
  service_data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await pause(); }
  assert.fail('État attendu non atteint');
}
async function setup(t, page, role, options = {}) {
  const win = new Window({ url: 'http://localhost:4174/' + page, settings: {
    enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true,
    suppressInsecureJavaScriptEnvironmentWarning: true
  } });
  t.after(async () => { await win.happyDOM.abort(); win.close(); });
  win.document.write(await readFile(new URL('../' + page, import.meta.url), 'utf8'));
  Object.defineProperty(win, 'crypto', { value: webcrypto });
  Object.defineProperty(win, 'isSecureContext', { value: true });
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const calls = [], queries = [], storageOptions = [];
  let session = options.session === false ? null : { user: { id: role === 'customer' ? customerId : driverId, is_anonymous: role === 'customer' } };
  let rows = options.rows ?? [structuredClone(fixture)];
  let failed = false;
  const mock = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signInAnonymously: async () => { session = { user: { id: customerId, is_anonymous: true } }; return { data: { session }, error: null }; },
      signInWithPassword: async () => ({ data: { session }, error: null }),
      signOut: async () => ({ error: null })
    },
    from(table) {
      const query = { table, filters: [] }; queries.push(query);
      const result = () => {
        if (table === 'profiles') return { data: query.single ? { id: session.user.id, full_name: 'Équipe Test', role } :
          [{ id: driverId, full_name: 'Livreur Test', phone: '0612345679' }], error: null };
        if (table === 'orders') return { data: rows, count: rows.length, error: null };
        if (table === 'order_events') return { data: [{ event_type: 'created', status: 'pending', message: 'Commande reçue', created_at: fixture.created_at }], error: null };
        if (table === 'driver_locations') return { data: query.single ? null : [], error: null };
        throw new Error('Unexpected table ' + table);
      };
      const chain = {
        select() { return chain; }, eq(column, value) { query.filters.push([column, value]); return chain; },
        in(column, values) { query.filters.push([column, values]); return chain; },
        order() { return chain; }, limit(value) { query.limit = value; return chain; },
        range(from, to) { query.range = [from, to]; return chain; },
        single() { query.single = true; return Promise.resolve(result()); },
        maybeSingle() { query.single = true; return Promise.resolve(result()); },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
      };
      return chain;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'team_daily_summary') return { data: { pending: 0, active: 1, delivered_today: 0, purchases_today: 0, fees_today: 0, cash_today: 0 }, error: null };
      if (name === 'get_order_driver') return { data: [{ id: driverId, full_name: 'Yassine Test', phone: '0612345679' }], error: null };
      if (name === 'create_order') {
        rows = [{ ...fixture, status: 'pending', driver_id: null, ...{ details: args.p_details, service: args.p_service } }];
        if (options.failFirst && !failed) { failed = true; return { data: null, error: { message: 'Failed to fetch' } }; }
        return { data: rows[0], error: null };
      }
      if (name === 'assign_order') { rows[0].driver_id = args.p_driver_id; return { data: rows[0], error: null }; }
      if (name === 'staff_update_order') {
        rows[0].status = args.p_status;
        if (args.p_purchase_amount != null) rows[0].purchase_amount = args.p_purchase_amount;
        if (args.p_cash_received != null) rows[0].cash_received = args.p_cash_received;
        return { data: rows[0], error: null };
      }
      return { data: null, error: null };
    },
    channel() {
      const channel = { on() { return channel; }, subscribe() { return channel; } };
      return channel;
    },
    removeChannel() {}
  };
  win.supabase = { createClient(url, key, options) { storageOptions.push(options); return mock; } };
  win.supabaseConfig = { url: 'https://test.supabase.co', key: 'sb_publishable_test' };
  for (const file of ['shared.js', page === 'index.html' ? 'app.js' : 'dashboard.js']) win.eval(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
  await pause();
  return { win, calls, queries, storageOptions, $: (id) => win.document.getElementById(id) };
}

test('Client : formulaire adapté et confirmation sans double commande après erreur réseau', async (t) => {
  const { win, calls, $ } = await setup(t, 'index.html', 'customer', { session: false, rows: [], failFirst: true });
  win.document.querySelector('[data-service="billets"]').click();
  assert.equal($('trainFields').disabled, false);
  assert.equal($('budget').required, false);
  win.document.querySelector('[data-service="snack"]').click();
  assert.equal($('shop').required, true);
  win.document.querySelector('[data-service="courses"]').click();
  assert.equal($('trainFields').disabled, true); assert.equal($('budget').required, true);
  // Happy DOM calcule le pas décimal avec un modulo flottant (100 % .01).
  // Neutraliser ce défaut du simulateur ; garder le vrai step="0.01" dans le site.
  $('budget').step = 'any';
  for (const [id, value] of Object.entries({ details: 'Pommes et lait', budget: '100', customerName: 'Client Test', phone: '0612345678', quarter: 'Centre', address: 'Rue de test 12' })) $(id).value = value;
  $('orderForm').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal($('confirmDialog').open, true, JSON.stringify([...$('orderForm').querySelectorAll('input,textarea')].filter((input) => !input.checkValidity()).map((input) => ({ id: input.id, disabled: input.disabled, message: input.validationMessage }))) + $('orderError').textContent);
  assert.equal(calls.filter((call) => call.name === 'create_order').length, 0);
  $('confirmOrder').click(); $('confirmOrder').click();
  await until(() => !$('confirmOrder').disabled && !$('confirmError').hidden);
  assert.equal(calls.filter((call) => call.name === 'create_order').length, 1);
  assert.match($('confirmError').textContent, /Connexion/);
  assert.equal($('details').value, 'Pommes et lait');
  $('confirmOrder').click();
  await until(() => !$('confirmDialog').open && !$('trackingContent').hidden);
  const created = calls.filter((call) => call.name === 'create_order');
  assert.equal(created[0].args.p_request_key, created[1].args.p_request_key);
  assert.equal($('trackStatus').textContent, 'En attente');
  assert.equal(win.sessionStorage.getItem('ss-pending-order'), null);
});

test('Client : suivi réel, contenu échappé et téléphone du livreur', async (t) => {
  const { $, win, queries } = await setup(t, 'index.html', 'customer');
  await until(() => $('driverName').textContent === 'Yassine Test');
  assert.equal($('trackStatus').textContent, 'Acceptée');
  assert.equal($('customerOrders').querySelector('img'), null);
  assert.equal($('callDriver').getAttribute('href'), 'tel:0612345679');
  assert.match($('locationNote').textContent, /Aucune position récente/);
  assert.ok(queries.filter((query) => query.table === 'orders').every((query) => query.filters.some(([key, value]) => key === 'customer_id' && value === customerId)));
  assert.match($('trackSub').textContent, /Rue de test/);
  assert.ok(win.document.querySelector('nav a[href="dashboard.html"]'));
});

test('Livreur : session séparée, accès filtré et GPS réessayable puis arrêtable', async (t) => {
  const { win, $, calls, queries, storageOptions } = await setup(t, 'dashboard.html', 'driver');
  await until(() => !$('appPanel').hidden && $('orders').querySelector('article'));
  assert.equal(storageOptions[0].auth.storageKey, 'sslivraison-team-auth');
  assert.equal($('driversPanel').hidden, true);
  assert.equal($('orders').querySelector('img'), null);
  assert.ok(queries.filter((query) => query.table === 'orders').every((query) => query.filters.some(([key, value]) => key === 'driver_id' && value === driverId)));
  let position, error;
  const cleared = [];
  Object.defineProperty(win.navigator, 'geolocation', { value: {
    watchPosition(success, failure) { position = success; error = failure; return 0; },
    clearWatch(id) { cleared.push(id); }
  } });
  $('shareLocation').click(); error({ code: 1 });
  assert.match($('gpsMessage').textContent, /refusée/);
  assert.equal($('shareLocation').textContent, 'Réessayer');
  assert.ok(cleared.includes(0));
  $('shareLocation').click();
  await position({ coords: { latitude: 34.26, longitude: -5.92, accuracy: 15 } });
  assert.equal(calls.filter((call) => call.name === 'publish_driver_location').length, 1);
  await position({ coords: { latitude: 34.2601, longitude: -5.9201, accuracy: 15 } });
  assert.equal(calls.filter((call) => call.name === 'publish_driver_location').length, 1, 'Envois GPS limités');
  $('shareLocation').click();
  await until(() => calls.some((call) => call.name === 'stop_driver_location'));
  assert.equal($('shareLocation').textContent, 'Partager ma position');
});

test('Administrateur : attribution, formulaire de clôture et montant encaissé', async (t) => {
  const row = { ...structuredClone(fixture), status: 'on_the_way' };
  const { win, $, calls } = await setup(t, 'dashboard.html', 'admin', { rows: [row] });
  await until(() => $('orders').querySelector('[data-action="assign"]'));
  assert.equal($('driversPanel').hidden, false);
  assert.equal($('gpsPanel').hidden, true);
  $('orders').querySelector('[data-action="assign"]').click();
  assert.equal($('actionDialog').open, true);
  assert.equal($('assignedDriver').value, driverId);
  $('actionForm').dispatchEvent(new win.Event('submit', { cancelable: true }));
  await until(() => !$('actionDialog').open && !$('saveAction').disabled);
  assert.equal(calls.find((call) => call.name === 'assign_order').args.p_driver_id, driverId);

  $('orders').querySelector('[data-status="delivered"]').click();
  $('purchaseAmount').step = 'any'; $('cashReceived').step = 'any'; // Défaut de pas décimal du simulateur.
  $('purchaseAmount').value = '25'; $('purchaseAmount').dispatchEvent(new win.Event('input'));
  $('cashReceived').value = '35';
  assert.match($('amountDue').textContent, /35/);
  $('actionForm').dispatchEvent(new win.Event('submit', { cancelable: true }));
  await until(() => !$('actionDialog').open && !$('saveAction').disabled);
  const saved = calls.find((call) => call.name === 'staff_update_order');
  assert.equal(saved.args.p_status, 'delivered');
  assert.equal(saved.args.p_purchase_amount, 25);
  assert.equal(saved.args.p_cash_received, 35);
  assert.match($('orders').textContent, /Encaissé : 35 DH/);
  assert.equal($('orders').querySelector('[data-action]'), null);
});

test('Le tableau de bord refuse un compte client', async (t) => {
  const { $ } = await setup(t, 'dashboard.html', 'customer');
  await until(() => $('loginError').textContent.length > 0);
  assert.equal($('appPanel').hidden, true);
  assert.match($('loginError').textContent, /pas accès/);
});
