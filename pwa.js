(() => {
  let prompt;
  const buttons = document.querySelectorAll('[data-install]');
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); prompt = event;
    buttons.forEach((button) => { button.hidden = false; });
  });
  buttons.forEach((button) => button.addEventListener('click', async () => {
    if (prompt) {
      await prompt.prompt(); await prompt.userChoice; prompt = undefined;
      buttons.forEach((item) => { item.hidden = true; });
    } else window.SS?.toast('Sur iPhone : ouvrez le menu Partager de Safari, puis « Sur l’écran d’accueil ».');
  }));
  if (/iphone|ipad/i.test(navigator.userAgent) && !navigator.standalone) buttons.forEach((button) => { button.hidden = false; });
  window.addEventListener('appinstalled', () => buttons.forEach((button) => { button.hidden = true; }));
  window.addEventListener('offline', () => window.SS?.toast('Vous êtes hors ligne. Les commandes et le suivi nécessitent une connexion.'));
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
