// This entry is available only inside a native client that implements APK updates.
function installUpdateEntries() {
  const bridge = window.HomerNative;
  if (!bridge || typeof bridge.checkForAppUpdate !== 'function') return;
  for (const section of document.querySelectorAll('[data-homer-update-section]')) section.hidden = false;
  for (const label of document.querySelectorAll('[data-homer-app-version]')) {
    try { label.textContent = bridge.getAppVersion(); } catch { label.textContent = ''; }
  }
  for (const button of document.querySelectorAll('[data-homer-check-update]')) {
    button.hidden = false;
    button.addEventListener('click', () => bridge.checkForAppUpdate());
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installUpdateEntries, { once: true });
else installUpdateEntries();
