(() => {
  'use strict';
  const { escape: esc, money, date, toast, errorMessage, rpc, statuses, services, active, transitions } = SS;
  const $ = (id) => document.getElementById(id);
  let client, profile, orders = [], drivers = [], page = 0, loading, action, actionBusy = false;
  let disposeOrders, disposeLocations, map, markers = [];
  let watchId = null, gpsStarting = false, gpsSaving = false, lastSent = 0, lastPoint, gpsGeneration = 0;
  const pageSize = 20;
  function inlineError(id, error) { $(id).textContent = error ? errorMessage(error) : ''; $(id).hidden = !error; }
  function initMap() {
    if (map || !window.L) return;
    map = L.map('map').setView([34.2615, -5.9268], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(map);
    map.invalidateSize();
  }
  async function loadLocations() {
    if (!profile || document.hidden) return;
    const result = await client.from('driver_locations').select('driver_id,latitude,longitude,accuracy,updated_at,is_sharing');
    if (result.error) throw result.error;
    initMap(); if (!map) return;
    markers.forEach((marker) => map.removeLayer(marker)); markers = [];
    result.data.filter((point) => point.is_sharing && Date.now() - new Date(point.updated_at).getTime() < 120000).forEach((point) => {
      const name = point.driver_id === profile.id ? 'Ma position' : drivers.find((driver) => driver.id === point.driver_id)?.full_name || 'Livreur';
      const text = document.createElement('span'); text.textContent = name + ' · ' + date(point.updated_at) + ' · ±' + Math.round(point.accuracy || 0) + ' m';
      markers.push(L.marker([point.latitude, point.longitude]).addTo(map).bindPopup(text));
    });
  }
  async function loadOrders() {
    if (!profile || document.hidden || actionBusy) return;
    if (loading) return loading;
    loading = (async () => {
      inlineError('dashboardError', null);
      let query = client.from('orders').select('*', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(page * pageSize, (page + 1) * pageSize - 1);
      if (profile.role === 'driver') query = query.eq('driver_id', profile.id);
      const filter = $('statusFilter').value;
      if (filter === 'active') query = query.in('status', ['pending', ...active]);
      else if (filter !== 'all') query = query.eq('status', filter);
      const [result, summaryResult] = await Promise.all([query, client.rpc('team_daily_summary')]);
      if (result.error) throw result.error; if (summaryResult.error) throw summaryResult.error;
      orders = result.data;
      const summary = summaryResult.data;
      $('pendingCount').textContent = summary.pending; $('activeCount').textContent = summary.active;
      $('doneCount').textContent = summary.delivered_today;
      $('purchasesToday').textContent = money(summary.purchases_today); $('feesToday').textContent = money(summary.fees_today); $('cashToday').textContent = money(summary.cash_today);
      $('previousPage').disabled = page === 0; $('nextPage').disabled = (page + 1) * pageSize >= result.count;
      $('pageLabel').textContent = 'Page ' + (page + 1) + ' · ' + result.count + ' commande(s)';
      if (profile.role === 'admin') {
        const staff = await client.from('profiles').select('id,full_name,phone').eq('role', 'driver').order('full_name');
        if (staff.error) throw staff.error;
        drivers = staff.data;
        $('driversList').innerHTML = drivers.length ? drivers.map((driver) =>
          '<div class="driver-row"><span><b>' + esc(driver.full_name) + '</b> · ' + esc(driver.phone || 'Téléphone à renseigner') +
          '</span><button data-edit-driver="' + driver.id + '">Modifier</button></div>').join('') : '<p>Aucun compte livreur disponible.</p>';
      }
      $('orders').innerHTML = orders.length ? orders.map(renderOrder).join('') : '<div class="panel empty">Aucune commande pour ce filtre.</div>';
      const hasActive = Number(summary.active) > 0;
      if (profile.role === 'driver') {
        if (!hasActive && (watchId !== null || gpsStarting)) await stopGPS();
        $('shareLocation').disabled = !hasActive && watchId === null;
      }
    })().catch((error) => inlineError('dashboardError', error)).finally(() => { loading = undefined; });
    return loading;
  }
  function renderOrder(order) {
    const terminal = ['delivered', 'cancelled'].includes(order.status);
    const driver = drivers.find((item) => item.id === order.driver_id);
    const data = order.service_data || {};
    const specific = order.service === 'billets' ? [data.departure, '→', data.destination, data.travel_date, data.passengers && data.passengers + ' voyageur(s)'].filter(Boolean).join(' ') : data.shop;
    const next = (transitions[order.status] || []).filter((status) => status !== 'accepted' || order.driver_id);
    return '<article class="order order-card"><div><div class="order-heading"><h3>#' + esc(order.id.slice(0, 8).toUpperCase()) + ' · ' + esc(services[order.service]) +
      '</h3><span class="status-badge">' + esc(statuses[order.status]) + '</span></div><p class="order-details">' + esc(order.details) + '</p>' +
      (specific ? '<p>' + esc(specific) + '</p>' : '') + '<p><b>' + esc(order.customer_name || 'Ancien client') + '</b> · ' +
      (order.customer_phone ? '<a href="tel:' + esc(order.customer_phone) + '">' + esc(order.customer_phone) + '</a>' : 'Téléphone non renseigné') +
      '</p><p>📍 ' + esc(order.quarter) + ' · ' + esc(order.delivery_address) + (order.landmark ? ' · ' + esc(order.landmark) : '') + '</p>' +
      '<p>Budget : ' + money(order.budget) + ' · Achats : ' + money(order.purchase_amount) + ' · Livraison : 10 DH</p>' +
      (order.cash_received == null ? '' : '<p>Encaissé : ' + money(order.cash_received) + '</p>') +
      '<small>' + esc(date(order.created_at)) + (profile.role === 'admin' ? ' · ' + esc(driver?.full_name || 'À attribuer') : '') + '</small></div>' +
      '<div class="order-actions">' +
      (!terminal && profile.role === 'admin' ? '<button data-action="assign" data-id="' + order.id + '">Attribuer / réattribuer</button>' : '') +
      (!terminal ? '<button data-action="purchase" data-id="' + order.id + '">Montant des achats</button>' : '') +
      next.map((status) => '<button class="primary" data-action="status" data-status="' + status + '" data-id="' + order.id + '">' + esc(statuses[status]) + '</button>').join('') +
      (!terminal && profile.role === 'admin' ? '<button data-action="status" data-status="cancelled" data-id="' + order.id + '">Annuler</button>' : '') + '</div></article>';
  }
  function openAction(type, order, status, driver) {
    action = { type, order, status, driver }; inlineError('actionError', null);
    $('actionDescription').textContent = order ? '#' + order.id.slice(0, 8).toUpperCase() + ' · ' + services[order.service] : '';
    let fields = '';
    if (type === 'assign') {
      $('actionTitle').textContent = 'Attribuer un livreur';
      fields = '<label for="assignedDriver">Livreur</label><select id="assignedDriver" required><option value="">Choisir…</option>' +
        drivers.map((item) => '<option value="' + item.id + '" ' + (item.id === order.driver_id ? 'selected' : '') + '>' + esc(item.full_name) + '</option>').join('') + '</select>';
    } else if (type === 'profile') {
      $('actionTitle').textContent = 'Coordonnées du livreur';
      fields = '<label for="driverFullName">Nom</label><input id="driverFullName" required minlength="2" maxlength="100" value="' + esc(driver.full_name) + '">' +
        '<label for="driverPhone">Téléphone marocain</label><input id="driverPhone" type="tel" required value="' + esc(driver.phone) + '">';
    } else {
      $('actionTitle').textContent = type === 'purchase' ? 'Enregistrer les achats' : statuses[status];
      if (type === 'purchase' || status === 'delivered') {
        fields = '<label for="purchaseAmount">Montant réel des achats (DH)</label><input id="purchaseAmount" type="number" min="0" max="' + (order.budget ?? 100000) + '" step="0.01" required value="' + (order.purchase_amount ?? '') + '">';
        if (status === 'delivered') {
          fields += '<p id="amountDue">Achats + 10 DH de livraison</p><label for="cashReceived">Montant encaissé, après monnaie rendue (DH)</label><input id="cashReceived" type="number" min="10" max="100010" step="0.01" required value="' + (order.purchase_amount == null ? '' : Number(order.purchase_amount) + 10) + '">';
        }
      } else fields = '<p>Confirmer le passage à « ' + esc(statuses[status]) + ' » ?</p>';
    }
    $('actionFields').innerHTML = fields;
    if (status === 'delivered') {
      $('purchaseAmount').addEventListener('input', () => { $('amountDue').textContent = 'Total à encaisser : ' + money(Number($('purchaseAmount').value) + 10); });
    }
    $('actionDialog').showModal();
  }
  $('actionForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (actionBusy || !$('actionForm').reportValidity()) return;
    actionBusy = true; $('saveAction').disabled = true; $('closeAction').disabled = true;
    try {
      const current = action;
      if (current.type === 'assign') await rpc(client, 'assign_order', { p_order_id: current.order.id, p_driver_id: $('assignedDriver').value });
      else if (current.type === 'profile') await rpc(client, 'update_driver_profile', { p_driver_id: current.driver.id, p_name: $('driverFullName').value.trim(), p_phone: $('driverPhone').value.trim() });
      else await rpc(client, 'staff_update_order', {
        p_order_id: current.order.id, p_status: current.type === 'purchase' ? current.order.status : current.status,
        p_purchase_amount: $('purchaseAmount') ? Number($('purchaseAmount').value) : null,
        p_cash_received: $('cashReceived') ? Number($('cashReceived').value) : null
      });
      $('actionDialog').close(); toast('Modification enregistrée.');
      actionBusy = false; await loadOrders(); await loadLocations();
    } catch (error) { inlineError('actionError', error); }
    finally { actionBusy = false; $('saveAction').disabled = false; $('closeAction').disabled = false; }
  });
  $('closeAction').addEventListener('click', () => { if (!actionBusy) $('actionDialog').close(); });
  $('actionDialog').addEventListener('cancel', (event) => { if (actionBusy) event.preventDefault(); });
  $('orders').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const order = orders.find((item) => item.id === button.dataset.id);
    if (order) openAction(button.dataset.action, order, button.dataset.status);
  });
  $('driversList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-driver]');
    if (button) openAction('profile', null, null, drivers.find((driver) => driver.id === button.dataset.editDriver));
  });

  async function stopGPS() {
    gpsGeneration++; gpsStarting = false;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null; lastSent = 0; lastPoint = undefined;
    $('shareLocation').textContent = 'Partager ma position'; $('shareLocation').disabled = true;
    $('gpsMessage').textContent = 'Partage arrêté.';
    // Attendre la dernière écriture en cours pour qu'elle ne réactive pas le partage.
    while (gpsSaving) await new Promise((resolve) => setTimeout(resolve, 50));
    if (client && profile?.role === 'driver') {
      try { await rpc(client, 'stop_driver_location'); await loadLocations(); }
      catch (error) { $('gpsMessage').textContent = 'Partage local arrêté. Le signal distant expire sous 2 minutes. ' + errorMessage(error); }
    }
    $('shareLocation').disabled = false;
  }
  async function startGPS() {
    if (watchId !== null || gpsStarting) return stopGPS();
    if (!window.isSecureContext || !navigator.geolocation) { $('gpsMessage').textContent = 'La localisation nécessite HTTPS ou localhost et un navigateur compatible.'; return; }
    gpsStarting = true; const generation = ++gpsGeneration;
    $('shareLocation').textContent = 'Arrêter le partage'; $('gpsMessage').textContent = 'Autorisez la localisation lorsque le navigateur vous le propose.';
    watchId = navigator.geolocation.watchPosition(async ({ coords }) => {
      gpsStarting = false;
      if (generation !== gpsGeneration || gpsSaving || document.hidden || Date.now() - lastSent < 15000) return;
      // Éviter les écritures pour des positions identiques, mais envoyer un signal toutes les 60 s.
      if (lastPoint && Math.abs(lastPoint[0] - coords.latitude) + Math.abs(lastPoint[1] - coords.longitude) < 0.0001 && Date.now() - lastSent < 60000) return;
      gpsSaving = true;
      try {
        await rpc(client, 'publish_driver_location', { p_latitude: coords.latitude, p_longitude: coords.longitude, p_accuracy: coords.accuracy });
        lastSent = Date.now(); lastPoint = [coords.latitude, coords.longitude];
        if (generation === gpsGeneration) { $('gpsMessage').textContent = 'Position partagée à ' + date(new Date()) + ' · précision ±' + Math.round(coords.accuracy) + ' m'; await loadLocations(); }
      } catch (error) {
        $('gpsMessage').textContent = errorMessage(error);
        if (generation === gpsGeneration) { gpsGeneration++; navigator.geolocation.clearWatch(watchId); watchId = null; $('shareLocation').textContent = 'Réessayer'; }
      } finally { gpsSaving = false; }
    }, (error) => {
      if (generation !== gpsGeneration) return;
      const messages = { 1: 'Localisation refusée. Autorisez-la dans les réglages du site.', 2: 'Position indisponible. Vérifiez les paramètres de localisation de votre appareil.', 3: 'Localisation trop lente. Réessayez.' };
      $('gpsMessage').textContent = messages[error.code] || 'Localisation indisponible.';
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null; gpsStarting = false; gpsGeneration++; $('shareLocation').textContent = 'Réessayer';
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
  }
  async function showApp(session) {
    const result = await client.from('profiles').select('id,full_name,role').eq('id', session.user.id).single();
    if (result.error) throw result.error;
    if (!['admin', 'driver'].includes(result.data.role) || session.user.is_anonymous) throw new Error('Ce compte n’a pas accès à l’espace équipe.');
    profile = result.data; $('loginPanel').hidden = true; $('appPanel').hidden = false; $('logout').hidden = false;
    $('connection').textContent = profile.role === 'admin' ? 'Administrateur' : 'Livreur';
    $('roleLabel').textContent = $('connection').textContent; $('teamName').textContent = profile.full_name;
    $('driversPanel').hidden = profile.role !== 'admin'; $('gpsPanel').hidden = profile.role !== 'driver';
    await loadOrders(); await loadLocations();
    disposeOrders?.(); disposeLocations?.();
    disposeOrders = SS.live(client, 'team-orders-' + profile.id, [{ table: 'orders', ...(profile.role === 'driver' ? { filter: 'driver_id=eq.' + profile.id } : {}) }], loadOrders);
    disposeLocations = SS.live(client, 'team-locations-' + profile.id, [{ table: 'driver_locations', ...(profile.role === 'driver' ? { filter: 'driver_id=eq.' + profile.id } : {}) }], loadLocations);
  }
  $('loginPanel').addEventListener('submit', async (event) => {
    event.preventDefault(); $('login').disabled = true; $('loginError').textContent = '';
    try {
      if (!client) client = SS.requireClient();
      const result = await client.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
      if (result.error) throw new Error('Connexion impossible : vérifiez votre email et votre mot de passe.');
      await showApp(result.data.session); $('password').value = '';
    } catch (error) { $('loginError').textContent = errorMessage(error); }
    finally { $('login').disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    try { await stopGPS(); disposeOrders?.(); disposeLocations?.(); const result = await client.auth.signOut(); if (result.error) throw result.error; location.reload(); }
    catch (error) { toast(errorMessage(error)); }
  });
  $('shareLocation').addEventListener('click', () => { startGPS().catch((error) => { $('gpsMessage').textContent = errorMessage(error); }); });
  $('refresh').addEventListener('click', () => { loadOrders(); loadLocations().catch((error) => toast(errorMessage(error))); });
  $('statusFilter').addEventListener('change', () => { page = 0; loadOrders(); });
  $('previousPage').addEventListener('click', () => { page = Math.max(0, page - 1); loadOrders(); });
  $('nextPage').addEventListener('click', () => { page++; loadOrders(); });
  window.addEventListener('pagehide', () => {
    gpsGeneration++; if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null; disposeOrders?.(); disposeLocations?.();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !profile) return;
    gpsStarting = false; $('shareLocation').textContent = 'Partager ma position';
    client.auth.getSession().then((result) => {
      if (result.error) throw result.error;
      if (!result.data.session) { profile = null; $('appPanel').hidden = true; $('loginPanel').hidden = false; $('logout').hidden = true; return; }
      return showApp(result.data.session);
    }).catch((error) => toast(errorMessage(error)));
  });
  (async () => {
    try { client = SS.requireClient(); const result = await client.auth.getSession(); if (result.error) throw result.error; if (result.data.session) await showApp(result.data.session); }
    catch (error) { $('loginError').textContent = errorMessage(error); }
  })();
})();
