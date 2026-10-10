(() => {
  'use strict';
  const { escape: esc, money, date, toast, errorMessage, rpc, services, statuses, active } = SS;
  const $ = (id) => document.getElementById(id);
  let client, user, service = 'courses', orders = [], selectedId, prepared;
  let count = 20, busy = false, loading, map, marker, accuracyCircle;
  let disposeOrders, disposeLocation, liveDriverId;
  const form = $('orderForm');
  const errorBox = (id, error) => { $(id).textContent = error ? errorMessage(error) : ''; $(id).hidden = !error; };

  function selectService(value) {
    service = value;
    document.querySelectorAll('[data-service]').forEach((button) => {
      const selected = button.dataset.service === value;
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    });
    $('shopFields').hidden = !['snack', 'pharmacie'].includes(value);
    $('shop').disabled = $('shopFields').hidden; $('shop').required = value === 'snack';
    $('trainFields').hidden = value !== 'billets'; $('trainFields').disabled = value !== 'billets';
    $('trainFields').querySelectorAll('input').forEach((input) => { input.disabled = value !== 'billets'; });
    $('budget').required = value === 'courses';
    const labels = { courses: 'Liste des achats', snack: 'Articles et quantités', pharmacie: 'Votre demande à la pharmacie', billets: 'Horaires souhaités et précisions' };
    $('detailsLabel').textContent = labels[value];
    $('details').placeholder = value === 'billets' ? 'Ex. : départ vers 10 h, deuxième classe…' : 'Décrivez votre demande…';
  }
  function collectOrder() {
    const phone = $('phone').value.replace(/[\s-]/g, '');
    if (!/^(0[5-7]\d{8}|\+212[5-7]\d{8})$/.test(phone)) throw new Error('Indiquez un téléphone marocain valide, par exemple 0612345678.');
    const serviceData = {};
    if (!$('shopFields').hidden) serviceData.shop = $('shop').value.trim();
    if (service === 'billets') Object.assign(serviceData, {
      departure: $('departure').value.trim(), destination: $('destination').value.trim(),
      travel_date: $('travelDate').value, passengers: Number($('passengers').value)
    });
    return {
      p_service: service, p_details: $('details').value.trim(), p_address: $('address').value.trim(),
      p_name: $('customerName').value.trim(), p_phone: phone, p_quarter: $('quarter').value.trim(),
      p_landmark: $('landmark').value.trim(), p_budget: $('budget').value === '' ? null : Number($('budget').value),
      p_service_data: serviceData
    };
  }
  async function requestKey(payload) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
    const fingerprint = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('ss-pending-order') || 'null'); } catch {}
    if (saved?.fingerprint === fingerprint) return saved.key;
    const key = crypto.randomUUID();
    sessionStorage.setItem('ss-pending-order', JSON.stringify({ fingerprint, key }));
    return key;
  }
  async function ensureCustomer() {
    const sessionResult = await client.auth.getSession();
    if (sessionResult.error) throw sessionResult.error;
    let session = sessionResult.data.session;
    if (!session) {
      const result = await client.auth.signInAnonymously();
      if (result.error) throw result.error;
      session = result.data.session;
    }
    if (!session) throw new Error('Impossible de créer votre session. Réessayez.');
    const profile = await client.from('profiles').select('role').eq('id', session.user.id).single();
    if (profile.error) throw profile.error;
    if (profile.data.role !== 'customer') throw new Error('Ce navigateur utilise un ancien compte équipe. Utilisez une fenêtre distincte pour commander comme client.');
    user = session.user;
    return user;
  }
  function attachLiveOrders() {
    if (disposeOrders || !user) return;
    disposeOrders = SS.live(client, 'customer-orders-' + user.id, [{ table: 'orders', filter: 'customer_id=eq.' + user.id }], loadOrders);
  }
  async function loadOrders() {
    if (!client || !user || document.hidden) return;
    if (loading) return loading;
    loading = (async () => {
      const result = await client.from('orders').select('*').eq('customer_id', user.id).order('created_at', { ascending: false }).limit(count);
      if (result.error) throw result.error;
      orders = result.data;
      if (!selectedId || !orders.some((order) => order.id === selectedId)) selectedId = orders[0]?.id;
      $('customerOrders').innerHTML = orders.map((order) => '<button type="button" class="history-order ' + (order.id === selectedId ? 'selected' : '') + '" data-order="' + order.id + '">' +
        '<b>#' + esc(order.id.slice(0, 8).toUpperCase()) + ' · ' + esc(services[order.service]) + '</b><span>' + esc(statuses[order.status]) + ' · ' + esc(date(order.created_at)) + '</span></button>').join('');
      $('moreOrders').hidden = orders.length < count;
      await renderSelected();
    })().catch((error) => toast(errorMessage(error))).finally(() => { loading = undefined; });
    return loading;
  }
  async function renderSelected() {
    const order = orders.find((item) => item.id === selectedId);
    $('trackingEmpty').hidden = !!order; $('trackingContent').hidden = !order;
    if (!order) return;
    $('trackStatus').textContent = statuses[order.status];
    $('trackSub').textContent = services[order.service] + ' · ' + order.delivery_address;
    $('trackId').textContent = '#' + order.id.slice(0, 8).toUpperCase();
    $('trackTotal').textContent = 'Achats : ' + money(order.purchase_amount) + ' · Livraison : 10 DH' +
      (order.purchase_amount == null ? '' : ' · Total : ' + money(Number(order.purchase_amount) + 10));
    const steps = ['pending', 'accepted', 'shopping', 'on_the_way', 'delivered'];
    const index = steps.indexOf(order.status);
    $('trackProgress').innerHTML = steps.map((step, i) => '<li class="' + (i === index ? 'current' : i < index ? 'done' : '') + '">' + esc(statuses[step]) + '</li>').join('');
    $('cancelOrder').hidden = order.status !== 'pending';
    const driverResult = await client.rpc('get_order_driver', { p_order_id: order.id });
    if (selectedId !== order.id) return;
    if (driverResult.error) throw driverResult.error;
    const driver = Array.isArray(driverResult.data) ? driverResult.data[0] : driverResult.data;
    $('driverName').textContent = driver?.full_name || 'En attente d’attribution';
    $('driverAvatar').textContent = driver ? driver.full_name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase() : '—';
    $('driverInfo').textContent = driver ? 'Livreur SSlivraison' : 'L’équipe va prendre en charge votre demande.';
    const phone = (driver?.phone || '').replace(/[\s-]/g, '');
    $('callDriver').hidden = !/^\+?\d{9,15}$/.test(phone);
    if (!$('callDriver').hidden) $('callDriver').href = 'tel:' + phone;
    if (liveDriverId !== (active.includes(order.status) ? order.driver_id : null)) {
      disposeLocation?.(); disposeLocation = undefined;
      liveDriverId = active.includes(order.status) ? order.driver_id : null;
      if (liveDriverId) disposeLocation = SS.live(client, 'location-' + liveDriverId, [{ table: 'driver_locations', filter: 'driver_id=eq.' + liveDriverId }], renderLocation);
    }
    await renderLocation();
    const events = await client.from('order_events').select('event_type,status,message,created_at').eq('order_id', order.id).order('created_at', { ascending: false }).limit(30);
    if (selectedId !== order.id) return;
    if (events.error) throw events.error;
    $('orderEvents').innerHTML = events.data.length ? events.data.map((event) =>
      '<li><span>' + esc(event.event_type === 'status' ? statuses[event.status] : event.message) +
      '</span><small>' + esc(date(event.created_at)) + '</small></li>').join('') : '<li>Commande enregistrée avant l’activation de l’historique.</li>';
  }
  async function renderLocation() {
    const order = orders.find((item) => item.id === selectedId);
    $('customerMap').hidden = true;
    $('locationNote').textContent = '';
    if (!order || !active.includes(order.status) || !order.driver_id) {
      if (order) $('locationNote').textContent = order.status === 'delivered' ? 'Livraison terminée. Le suivi de position est fermé.' : 'La position sera disponible pendant votre livraison si le livreur la partage.';
      return;
    }
    const result = await client.from('driver_locations').select('latitude,longitude,accuracy,updated_at,is_sharing').eq('driver_id', order.driver_id).maybeSingle();
    if (selectedId !== order.id) return;
    if (result.error) throw result.error;
    const position = result.data;
    if (!position?.is_sharing || Date.now() - new Date(position.updated_at).getTime() > 120000) {
      $('locationNote').textContent = 'Aucune position récente disponible. Votre livreur peut avoir sa page fermée ou sa connexion interrompue.';
      return;
    }
    $('customerMap').hidden = false;
    $('locationNote').textContent = 'Dernière position : ' + date(position.updated_at) + (position.accuracy == null ? '' : ' · précision ±' + Math.round(position.accuracy) + ' m');
    if (!window.L) { $('customerMap').hidden = true; $('locationNote').textContent += ' · Carte indisponible, rechargez la page.'; return; }
    if (!map) {
      map = L.map('customerMap');
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(map);
    }
    const point = [position.latitude, position.longitude];
    if (!marker) { marker = L.marker(point).addTo(map); map.setView(point, 15); }
    else marker.setLatLng(point);
    if (accuracyCircle) map.removeLayer(accuracyCircle);
    if (position.accuracy != null) accuracyCircle = L.circle(point, { radius: position.accuracy, weight: 1 }).addTo(map);
    map.invalidateSize();
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault(); if (busy) return;
    errorBox('orderError', null);
    try {
      if (!form.reportValidity()) return;
      prepared = collectOrder();
      $('orderSummary').innerHTML = '<p><b>' + esc(services[prepared.p_service]) + '</b></p><p>' + esc(prepared.p_details) + '</p><p>' +
        esc(prepared.p_name) + ' · ' + esc(prepared.p_phone) + '</p><p>' + esc(prepared.p_quarter) + ' · ' + esc(prepared.p_address) +
        '</p>' + (prepared.p_landmark ? '<p>Repère : ' + esc(prepared.p_landmark) + '</p>' : '') +
        '<p>Budget maximum des achats : ' + money(prepared.p_budget) + '</p>' +
        (prepared.p_service_data.shop ? '<p>Établissement : ' + esc(prepared.p_service_data.shop) + '</p>' : '') +
        (prepared.p_service === 'billets' ? '<p>' + esc(prepared.p_service_data.departure) + ' → ' + esc(prepared.p_service_data.destination) + ' · ' + esc(prepared.p_service_data.travel_date) + ' · ' + prepared.p_service_data.passengers + ' voyageur(s)</p>' : '');
      errorBox('confirmError', null); $('confirmDialog').showModal();
    } catch (error) { errorBox('orderError', error); }
  });
  $('editOrder').addEventListener('click', () => { if (!busy) $('confirmDialog').close(); });
  $('confirmDialog').addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  $('confirmOrder').addEventListener('click', async () => {
    if (busy || !prepared) return;
    busy = true; $('confirmOrder').disabled = true; $('editOrder').disabled = true; $('confirmOrder').textContent = 'Envoi…';
    errorBox('confirmError', null);
    try {
      if (!client) client = SS.requireClient();
      if (!navigator.onLine) throw new Error('Connexion indisponible.');
      await ensureCustomer();
      const key = await requestKey(prepared);
      const order = await rpc(client, 'create_order', { ...prepared, p_request_key: key });
      selectedId = order.id; sessionStorage.removeItem('ss-pending-order');
      $('confirmDialog').close(); $('details').value = ''; prepared = undefined;
      attachLiveOrders(); await loadOrders(); toast('Commande reçue. Vous pouvez maintenant suivre son avancement.');
      $('suivi').scrollIntoView({ behavior: 'smooth' });
    } catch (error) { errorBox('confirmError', error); }
    finally { busy = false; $('confirmOrder').disabled = false; $('editOrder').disabled = false; $('confirmOrder').textContent = 'Envoyer la commande'; }
  });
  document.querySelectorAll('[data-service]').forEach((button) => button.addEventListener('click', () => selectService(button.dataset.service)));
  $('customerOrders').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-order]'); if (!button) return;
    selectedId = button.dataset.order; await loadOrders();
  });
  $('cancelOrder').addEventListener('click', async () => {
    if (!selectedId || !window.confirm('Annuler cette demande de livraison ?')) return;
    $('cancelOrder').disabled = true;
    try { await rpc(client, 'cancel_customer_order', { p_order_id: selectedId }); await loadOrders(); toast('Demande annulée.'); }
    catch (error) { toast(errorMessage(error)); }
    finally { $('cancelOrder').disabled = false; }
  });
  $('refreshOrders').addEventListener('click', loadOrders);
  $('moreOrders').addEventListener('click', () => { count += 20; loadOrders(); });
  $('travelDate').min = SS.today(); selectService(service);
  (async () => {
    try {
      client = SS.requireClient();
      const result = await client.auth.getSession(); if (result.error) throw result.error;
      if (result.data.session) { user = result.data.session.user; attachLiveOrders(); await loadOrders(); }
    } catch (error) { errorBox('orderError', error); }
  })();
  window.addEventListener('pagehide', () => { disposeOrders?.(); disposeLocation?.(); });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !user) return;
    disposeOrders = undefined; disposeLocation = undefined; liveDriverId = undefined;
    attachLiveOrders(); loadOrders();
  });
})();
