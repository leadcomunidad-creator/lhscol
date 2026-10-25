(() => {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch((error) => console.error('[LHSCOL PWA] Service worker no pudo registrarse:', error));
  });
})();
