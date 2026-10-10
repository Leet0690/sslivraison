(() => {
  'use strict';
  const statuses = { pending: 'En attente', accepted: 'Acceptée', shopping: 'Achats en cours', on_the_way: 'En route', delivered: 'Livrée', cancelled: 'Annulée' };
  const services = { courses: 'Courses', pharmacie: 'Pharmacie', snack: 'Snack', billets: 'Billets', autre: 'Autre' };
  const active = ['accepted', 'shopping', 'on_the_way'];
  const transitions = { pending: ['accepted'], accepted: ['shopping', 'on_the_way'], shopping: ['on_the_way'], on_the_way: ['delivered'], delivered: [], cancelled: [] };
  const money = (value) => value == null ? 'À confirmer' : new Intl.NumberFormat('fr-MA', { maximumFractionDigits: 2 }).format(Number(value)) + ' DH';
  const date = (value) => new Intl.DateTimeFormat('fr-MA', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Casablanca' }).format(new Date(value));
  const today = () => {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Casablanca', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type).value;
    return part('year') + '-' + part('month') + '-' + part('day');
  };
  const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  let toastTimer;
  const toast = (message) => {
    const element = document.querySelector('#toast');
    if (!element) return;
    clearTimeout(toastTimer);
    element.textContent = message;
    element.classList.add('show');
    toastTimer = setTimeout(() => element.classList.remove('show'), 5500);
  };
  const errorMessage = (error) => {
    if (!navigator.onLine) return 'Connexion interrompue. Votre demande n’a pas été confirmée. Réessayez lorsque vous êtes en ligne.';
    if (['PGRST202', 'PGRST204', '42P01', '42703'].includes(error?.code)) return 'Le service est en cours de mise à jour. Réessayez dans quelques instants.';
    if (/Failed to fetch|NetworkError|fetch failed|aborted|timeout/i.test(error?.message || '')) return 'Connexion au service impossible ou trop lente. Réessayez.';
    return error?.message || 'Une erreur est survenue. Réessayez.';
  };
  const requireClient = () => {
    if (!window.supabase?.createClient || !window.supabaseConfig?.url || !window.supabaseConfig?.key) throw new Error('Le service n’a pas pu démarrer. Vérifiez votre connexion et rechargez la page.');
    const team = /dashboard\.html$/.test(location.pathname);
    const timedFetch = async (input, init = {}) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timeout = setTimeout(abort, 20000);
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener('abort', abort, { once: true });
      try { return await fetch(input, { ...init, signal: controller.signal }); }
      finally { clearTimeout(timeout); init.signal?.removeEventListener('abort', abort); }
    };
    return window.supabase.createClient(window.supabaseConfig.url, window.supabaseConfig.key,
      { global: { fetch: timedFetch }, ...(team ? { auth: { storageKey: 'sslivraison-team-auth' } } : {}) });
  };
  const rpc = async (client, name, args) => {
    const result = await client.rpc(name, args);
    if (result.error) throw result.error;
    return Array.isArray(result.data) && result.data.length === 1 ? result.data[0] : result.data;
  };
  // Premier chargement + événements filtrés ; secours toutes les 60 s uniquement si visible.
  const live = (client, name, subscriptions, refresh) => {
    let timer; let disposed = false;
    const schedule = () => {
      if (disposed || document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!disposed && !document.hidden) Promise.resolve(refresh()).catch((error) => toast(errorMessage(error))); }, 250);
    };
    let channel = client.channel(name);
    subscriptions.forEach((spec) => { channel = channel.on('postgres_changes', { event: '*', schema: 'public', ...spec }, schedule); });
    channel.subscribe();
    const interval = setInterval(schedule, 60000);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('online', schedule);
    return () => {
      disposed = true; clearTimeout(timer); clearInterval(interval);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('online', schedule);
      client.removeChannel(channel);
    };
  };
  window.SS = { statuses, services, active, transitions, money, date, today, escape, toast, errorMessage, requireClient, rpc, live };
})();
