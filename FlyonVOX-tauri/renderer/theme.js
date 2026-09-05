// Theme handling shared by every window.
// Preference is cached in localStorage for instant paint, then corrected
// by the authoritative value from config.json (python backend).
(function () {
  const DARK = ['graphite', 'forest', 'ocean', 'crimson', 'slate', 'mono'];

  function resolve(pref) {
    if (pref === 'system') {
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'graphite' : 'daylight';
    }
    return DARK.includes(pref) || pref === 'daylight' ? pref : 'graphite';
  }

  function apply(pref) {
    const id = resolve(pref);
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem('whisper-theme-pref', pref || 'system'); } catch (e) {}
  }

  function currentPref() {
    try { return localStorage.getItem('whisper-theme-pref') || 'system'; } catch (e) { return 'system'; }
  }

  // Instant paint from cache
  apply(currentPref());

  // Follow OS changes while in system mode
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentPref() === 'system') apply('system');
  });

  window.WhisperTheme = { apply, resolve, currentPref };
})();
