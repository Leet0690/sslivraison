const client = window.supabase.createClient(window.supabaseConfig.url, window.supabaseConfig.key);
const statuses = [
  ['pending', 'En attente'], ['accepted', 'Acceptée'], ['shopping', 'En préparation'],
  ['on_the_way', 'En route'], ['delivered', 'Livrée'], ['cancelled', 'Annulée']
];
const serviceLabels = { courses: 'Courses', pharmacie: 'Pharmacie', snack: 'Snack', billets: 'Billets', autre: 'Autre' };
let map;
let marker;
let watchId;

const toast = (message) => {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('show');
  window.setTimeout(() => element.classList.remove('show'), 3500);
};

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

const statusLabel = (status) => statuses.find(([value]) => value === status)?.[1] || status;

function initMap() {
  if (map) return;
  map = L.map('map').setView([34.2615, -5.9268], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);
}

async function loadOrders() {
  const { data, error } = await client.from('orders').select('*').order('created_at', { ascending: false });
  if (error) { toast(`Impossible de charger les commandes : ${error.message}`); return; }

  document.querySelector('#pendingCount').textContent = data.filter((order) => order.status === 'pending').length;
  document.querySelector('#activeCount').textContent = data.filter((order) => ['accepted', 'shopping', 'on_the_way'].includes(order.status)).length;
  document.querySelector('#doneCount').textContent = data.filter((order) => order.status === 'delivered').length;

  const container = document.querySelector('#orders');
  container.innerHTML = data.length ? data.map((order) => `
    <article class="order">
      <div>
        <h3>${escapeHtml(serviceLabels[order.service] || order.service)} · ${order.delivery_fee} DH</h3>
        <p>${escapeHtml(order.details)}</p>
        <p>📍 ${escapeHtml(order.delivery_address)}</p>
        <small>${new Date(order.created_at).toLocaleString('fr-MA')}</small>
      </div>
      <select data-id="${order.id}" aria-label="Statut de la commande">
        ${statuses.map(([value, label]) => `<option value="${value}" ${order.status === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </article>`).join('') : '<div class="panel empty">Aucune commande pour le moment.</div>';

  container.querySelectorAll('select').forEach((select) => select.addEventListener('change', async (event) => {
    const { error: updateError } = await client.from('orders').update({
      status: event.target.value,
      updated_at: new Date().toISOString()
    }).eq('id', event.target.dataset.id);
    if (updateError) toast(`Mise à jour impossible : ${updateError.message}`);
    else { toast('Statut mis à jour.'); await loadOrders(); }
  }));
}

function locationError(error) {
  const messages = {
    1: 'Localisation refusée. Autorisez-la dans les réglages du site.',
    2: 'Position indisponible. Vérifiez le service de localisation de votre ordinateur.',
    3: 'La demande de localisation a expiré. Réessayez.'
  };
  toast(messages[error.code] || 'Impossible de récupérer votre position.');
  const button = document.querySelector('#shareLocation');
  button.disabled = false;
  button.textContent = 'Réessayer';
}

async function shareLocation() {
  if (!navigator.geolocation) { toast('La géolocalisation n’est pas disponible sur cet appareil.'); return; }
  const button = document.querySelector('#shareLocation');
  button.disabled = true;
  button.textContent = 'Localisation…';
  watchId = navigator.geolocation.watchPosition(async ({ coords }) => {
    const { data: { user } } = await client.auth.getUser();
    if (!user) { toast('Session expirée. Reconnectez-vous.'); return; }
    const { error } = await client.from('driver_locations').upsert({
      driver_id: user.id, latitude: coords.latitude, longitude: coords.longitude,
      updated_at: new Date().toISOString()
    });
    if (error) { toast(`Position non enregistrée : ${error.message}`); return; }
    button.textContent = 'Partage actif';
    if (marker) marker.setLatLng([coords.latitude, coords.longitude]);
    else marker = L.marker([coords.latitude, coords.longitude]).addTo(map).bindPopup('Ma position');
    map.setView([coords.latitude, coords.longitude], 15);
  }, locationError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
}

async function showApp() {
  document.querySelector('#loginPanel').hidden = true;
  document.querySelector('#appPanel').hidden = false;
  document.querySelector('#connection').textContent = 'Connecté';
  initMap();
  window.setTimeout(() => map.invalidateSize(), 100);
  await loadOrders();
}

document.querySelector('#login').addEventListener('click', async () => {
  const email = document.querySelector('#email').value.trim();
  const password = document.querySelector('#password').value;
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) { document.querySelector('#loginError').textContent = 'Email ou mot de passe incorrect.'; return; }
  showApp();
});
document.querySelector('#refresh').addEventListener('click', loadOrders);
document.querySelector('#shareLocation').addEventListener('click', shareLocation);
document.querySelector('#logout').addEventListener('click', async () => {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  await client.auth.signOut();
  window.location.reload();
});
client.auth.getSession().then(({ data }) => { if (data.session) showApp(); });
window.setInterval(() => { if (!document.querySelector('#appPanel').hidden) loadOrders(); }, 15000);
