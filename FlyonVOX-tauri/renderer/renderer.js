// Command Deck renderer — main window with in-place views
// (Dictation / Downloads / Settings)

const toggleBtn = document.getElementById('toggle-btn');
const statusText = document.getElementById('status-text');
const output = document.getElementById('output');
const recIndicator = document.getElementById('rec-indicator');
const clearBtn = document.getElementById('clear-btn');
const copyBtn = document.getElementById('copy-btn');

const selectTrigger = document.getElementById('select-trigger');
const selectValue = document.getElementById('select-value');
const selectDropdown = document.getElementById('select-dropdown');
const selectInner = document.getElementById('select-dropdown-inner');

const deviceVal = document.getElementById('device-val');
const precisionVal = document.getElementById('precision-val');
const hotkeyVal = document.getElementById('hotkey-val');
const sessionMeta = document.getElementById('session-meta');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingStatus = document.getElementById('loading-status');
const toastEl = document.getElementById('toast');

// Views / rail
const railBtns = document.querySelectorAll('.rail-btn');
const views = {
  dictation: document.getElementById('view-dictation'),
  downloads: document.getElementById('view-downloads'),
  settings: document.getElementById('view-settings'),
};

// Settings view
const themeGrid = document.getElementById('theme-grid');
const deviceSeg = document.getElementById('device-seg');
const precisionSeg = document.getElementById('precision-seg');
const hotkeyInput = document.getElementById('hotkey-input');
const hotkeyNote = document.getElementById('hotkey-note');
const preserveToggle = document.getElementById('preserve-toggle');
const overlayToggle = document.getElementById('overlay-toggle');
const startminToggle = document.getElementById('startmin-toggle');
const gradToggle = document.getElementById('grad-toggle');

// Downloads view
const refreshBtn = document.getElementById('refresh-btn');
const modelList = document.getElementById('model-list');
const progressWrapper = document.getElementById('progress-wrapper');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');

// Onboarding (first-use wizard)
const obBackdrop = document.getElementById('onboarding');
const obSteps = document.querySelectorAll('.ob-step');
const obPanes = [
  document.getElementById('ob-pane-model'),
  document.getElementById('ob-pane-behavior'),
  document.getElementById('ob-pane-finish'),
];
const obModelList = document.getElementById('ob-model-list');
const obModelNote = document.getElementById('ob-model-note');
const obOverlayToggle = document.getElementById('ob-overlay-toggle');
const obClipboardToggle = document.getElementById('ob-clipboard-toggle');
const obStartminToggle = document.getElementById('ob-startmin-toggle');
const obHotkeyInput = document.getElementById('ob-hotkey-input');
const obHotkeyNote = document.getElementById('ob-hotkey-note');
const obSummary = document.getElementById('ob-summary');
const obProgressWrap = document.getElementById('ob-progress-wrap');
const obProgressFill = document.getElementById('ob-progress-fill');
const obProgressLabel = document.getElementById('ob-progress-label');
const obBackBtn = document.getElementById('ob-back');
const obNextBtn = document.getElementById('ob-next');

// ---- Models ---- //

// One unified list - the ".en" variants are English-only, the rest auto-detect.
const MODELS_WHISPER = [
  { value: 'tiny.en', label: 'tiny.en', params: '39M', size: '75MB', langs: 'English' },
  { value: 'base.en', label: 'base.en', params: '74M', size: '142MB', langs: 'English' },
  { value: 'small.en', label: 'small.en', params: '244M', size: '466MB', langs: 'English' },
  { value: 'medium.en', label: 'medium.en', params: '769M', size: '1.5GB', langs: 'English' },
  { value: 'tiny', label: 'tiny', params: '39M', size: '75MB', langs: 'Multilingual' },
  { value: 'base', label: 'base', params: '74M', size: '142MB', langs: 'Multilingual' },
  { value: 'small', label: 'small', params: '244M', size: '466MB', langs: 'Multilingual' },
  { value: 'medium', label: 'medium', params: '769M', size: '1.5GB', langs: 'Multilingual' },
  { value: 'large-v2', label: 'large-v2', params: '1.55B', size: '2.9GB', langs: 'Multilingual' },
  { value: 'large-v3', label: 'large-v3', params: '1.55B', size: '2.9GB', langs: 'Multilingual' },
  { value: 'large-v3-turbo', label: 'large-v3-turbo', params: '809M', size: '1.6GB', langs: 'Multilingual' },
];

const ENGINES = [
  { id: 'whisper', name: 'OpenAI Whisper', models: MODELS_WHISPER },
  {
    id: 'parakeet',
    name: 'NVIDIA Parakeet',
    note: 'Coming soon. NVIDIA Parakeet support is still being tested.',
    comingSoon: true,
    models: [
      { value: 'parakeet-tdt-0.6b-v2', label: 'parakeet-tdt-0.6b-v2', params: '0.6B', size: '460MB', langs: 'English' },
      { value: 'parakeet-tdt-0.6b-v3', label: 'parakeet-tdt-0.6b-v3', params: '0.6B', size: '465MB', langs: '25 languages' },
    ],
  },
  {
    id: 'canary',
    name: 'NVIDIA Canary',
    note: 'Coming soon. NVIDIA Canary support is still being tested.',
    comingSoon: true,
    models: [
      { value: 'canary-180m-flash', label: 'canary-180m-flash', params: '180M', size: '147MB', langs: 'en/de/fr/es' },
    ],
  },
];

const ALL_ENGINE_MODELS = ENGINES.flatMap((e) =>
  e.models.map((m) => ({ ...m, engine: e.id }))
);

let isRecording = false;
let isModelLoading = false;
let isTranscribing = false;
let dropdownOpen = false;
let downloadedModels = {};
let loadedModel = null;
let activeHotkey = 'Ctrl+Alt+R';
let currentDevice = 'cuda';
let currentCompute = 'int8';
let openFolders = { whisper: true, parakeet: false, canary: false };
let dlButtons = {};
let recStartTs = null;
let metaTimer = null;
let toastTimer = null;

// ---- Helpers ---- //

function send(action, data = {}) {
  window.electronAPI.sendToPython({ action, ...data });
}

function toast(text, cls = '') {
  if (!text) return;
  toastEl.textContent = text;
  toastEl.className = `toast show ${cls}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 6000);
}

function renderHotkeyDisplay(hotkey) {
  if (!hotkey) return;
  activeHotkey = hotkey;
  if (hotkeyVal) hotkeyVal.textContent = hotkey;
}

const KEY_CODE_NAMES = {
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
};

function formatHotkey(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta' ? null : (e.key === ' ' ? 'Space' : e.key);
  if (key) {
    const name = KEY_CODE_NAMES[key] || (key.length === 1 ? key.toUpperCase() : key);
    parts.push(name);
  }
  return parts.length >= 2 ? parts.join('+') : null;
}

function hideLoadingOverlay() {
  if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
    loadingOverlay.classList.add('fade-out');
    setTimeout(() => loadingOverlay.classList.add('hidden'), 400);
  }
}

function setModelLoading(isLoading, modelName = '') {
  isModelLoading = isLoading;
  if (isLoading) {
    toggleBtn.disabled = true;
    const label = modelName ? `Loading ${modelName}...` : 'Loading Model...';
    toggleBtn.querySelector('.btn-text').textContent = label;
    statusText.textContent = label;
    statusText.classList.remove('err');
    recIndicator.className = 'indicator loading';
  } else {
    toggleBtn.disabled = false;
    toggleBtn.classList.remove('loading-model');
    toggleBtn.querySelector('.btn-text').textContent = 'Record';
    statusText.textContent = 'Ready';
    statusText.classList.remove('err');
    recIndicator.className = 'indicator idle';
  }
}

function setTranscribing(on) {
  isTranscribing = on;
  toggleBtn.disabled = on || isModelLoading;
  if (on) {
    recIndicator.className = 'indicator loading';
    statusText.classList.remove('err');
  } else if (!isRecording) {
    recIndicator.className = 'indicator idle';
  }
}

// ---- View switching ---- //

function activateView(name) {
  railBtns.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  Object.entries(views).forEach(([n, el]) => {
    if (el) el.classList.toggle('hidden', n !== name);
  });
}

railBtns.forEach((btn) => {
  btn.addEventListener('click', () => activateView(btn.dataset.view));
});

// ---- Session meta (words + duration) ---- //

function updateSessionMeta() {
  const text = output.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  let secs = 0;
  if (recStartTs) secs = Math.floor((Date.now() - recStartTs) / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  sessionMeta.textContent = `${words} words \u00b7 ${mm}:${ss}`;
}

output.addEventListener('input', updateSessionMeta);

// ---- Model dropdown (Dictation) ---- //

function getDropdownGroups() {
  return ENGINES.map((e) => ({ name: e.name, models: e.models }));
}

function findEngineModel(value) {
  return ALL_ENGINE_MODELS.find((m) => m.value === value);
}

function langBadge(m) {
  if (!m.langs) return '';
  const short = m.langs === 'English' ? 'EN' : (m.langs === 'Multilingual' ? 'Multi' : m.langs);
  return ` <span class="lang-tag">${short}</span>`;
}

function buildDropdown() {
  const groups = getDropdownGroups();

  selectInner.innerHTML = '';

  let currentVal = selectTrigger.dataset.currentValue || '';
  if (!findEngineModel(currentVal)) {
    const firstDownloaded = ALL_ENGINE_MODELS.find((m) => !m.comingSoon && downloadedModels[m.value]);
    currentVal = firstDownloaded ? firstDownloaded.value : 'tiny.en';
  }

  const header = document.createElement('div');
  header.className = 'select-row header';
  header.innerHTML = '<span>Model</span><span class="col-params">Params</span><span class="col-size">Size</span>';
  selectInner.appendChild(header);

  groups.forEach((group) => {
    const gh = document.createElement('div');
    gh.className = 'select-row header';
    gh.innerHTML = `<span>${group.name}</span>`;
    selectInner.appendChild(gh);

    group.models.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'select-row' + (m.comingSoon ? ' coming-soon' : '');
      if (m.value === currentVal) row.classList.add('selected');
      row.dataset.value = m.value;

      const check = downloadedModels[m.value] && !m.comingSoon ? '&#10003; ' : '';
      const availability = m.comingSoon ? '<span class="soon-tag">Coming soon</span>' : '';
      row.innerHTML = `<span class="col-name">${check}${m.label}${langBadge(m)} ${availability}</span><span class="col-params">${m.params}</span><span class="col-size">${m.size}</span>`;

      if (!m.comingSoon) row.addEventListener('click', () => selectOption(m.value));
      selectInner.appendChild(row);
    });
  });

  selectValue.textContent = currentVal;
  selectTrigger.dataset.currentValue = currentVal;
}

function selectOption(value) {
  const model = findEngineModel(value);
  if (!model) return;

  if (model.comingSoon) {
    toast(`${model.label} is coming soon - Whisper models are available now.`);
    return;
  }

  const prevValue = selectTrigger.dataset.currentValue;
  selectValue.textContent = model.label;
  selectTrigger.dataset.currentValue = value;
  closeDropdown();

  document.querySelectorAll('.select-row').forEach((r) => {
    r.classList.toggle('selected', r.dataset.value === value);
  });

  // Only skip when the backend genuinely has this exact model already
  if (value === prevValue && value === loadedModel) return;
  if (!downloadedModels[value]) {
    toast(`Download ${model.label} in the Downloads tab first`);
    return;
  }

  setModelLoading(true, model.label);
  send('change_model', { model: value });
}

function openDropdown() {
  dropdownOpen = true;
  selectDropdown.classList.add('open');
  selectTrigger.classList.add('open');
}

function closeDropdown() {
  dropdownOpen = false;
  selectDropdown.classList.remove('open');
  selectTrigger.classList.remove('open');
}

selectTrigger.addEventListener('click', () => (dropdownOpen ? closeDropdown() : openDropdown()));

document.addEventListener('click', (e) => {
  if (dropdownOpen && !e.target.closest('.custom-select')) closeDropdown();
});

buildDropdown();

// ---- Status bar chips (Dictation) ----//

deviceVal.closest('.chip').addEventListener('click', () => {
  if (isModelLoading) return;
  const next = currentDevice === 'cuda' ? 'cpu' : 'cuda';
  setDeviceUI(next);
  setModelLoading(true, selectValue.textContent);
  send('set_device', { device: next });
});

precisionVal.closest('.chip').addEventListener('click', () => {
  if (isModelLoading) return;
  const next = currentCompute === 'float16' ? 'int8' : 'float16';
  setPrecisionUI(next);
  setModelLoading(true, selectValue.textContent);
  send('set_compute', { compute: next });
});

function setDeviceUI(value) {
  currentDevice = value;
  deviceVal.textContent = value.toUpperCase();
  setSeg(deviceSeg, 'device', value);
}

function setPrecisionUI(value) {
  currentCompute = value;
  precisionVal.textContent = value === 'float16' ? 'FP16' : 'INT8';
  setSeg(precisionSeg, 'compute', value);
}

// ---- Settings view: theme picker ---- //

const THEMES = [
  { id: 'system', name: 'System', swatchBg: '#3a3a3a', swatchAccent: '#cccccc' },
  { id: 'graphite', name: 'Graphite', swatchBg: '#141310', swatchAccent: '#d9a441' },
  { id: 'daylight', name: 'Daylight', swatchBg: '#f2efe7', swatchAccent: '#a87908' },
  { id: 'forest', name: 'Forest', swatchBg: '#101613', swatchAccent: '#7fd962' },
  { id: 'ocean', name: 'Ocean', swatchBg: '#0e1418', swatchAccent: '#38bdd8' },
  { id: 'crimson', name: 'Crimson', swatchBg: '#171010', swatchAccent: '#ff6b57' },
  { id: 'slate', name: 'Slate', swatchBg: '#14171a', swatchAccent: '#88c0d0' },
  { id: 'mono', name: 'Mono', swatchBg: '#111111', swatchAccent: '#ffffff' },
];

function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const activePref = window.WhisperTheme.currentPref();
  THEMES.forEach((t) => {
    const card = document.createElement('button');
    card.className = 'theme-card' + (activePref === t.id ? ' active' : '');
    card.innerHTML = `
      <span class="swatch" style="background:${t.swatchBg};--sw-accent:${t.swatchAccent}"></span>
      <span class="t-name">${t.name}</span>
    `;
    card.addEventListener('click', () => {
      window.WhisperTheme.apply(t.id);
      send('set_theme', { theme: t.id });
      markActiveTheme(t.id);
    });
    themeGrid.appendChild(card);
  });
}

function markActiveTheme(id) {
  document.querySelectorAll('.theme-card').forEach((c) => c.classList.remove('active'));
  const idx = THEMES.findIndex((t) => t.id === id);
  if (idx >= 0) themeGrid.children[idx].classList.add('active');
}

buildThemeGrid();

// ---- Settings view: segmented controls ---- //

function setSeg(seg, attr, value) {
  seg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset[attr] === value);
  });
}

deviceSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-device]');
  if (!btn || btn.classList.contains('active') || isModelLoading) return;
  setDeviceUI(btn.dataset.device);
  setModelLoading(true, selectValue.textContent);
  send('set_device', { device: btn.dataset.device });
});

precisionSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-compute]');
  if (!btn || btn.classList.contains('active') || isModelLoading) return;
  setPrecisionUI(btn.dataset.compute);
  setModelLoading(true, selectValue.textContent);
  send('set_compute', { compute: btn.dataset.compute });
});

// ---- Settings view: behavior toggles ---- //

preserveToggle.addEventListener('change', () => {
  send('set_preserve_clipboard', { enabled: preserveToggle.checked });
});

overlayToggle.addEventListener('change', () => {
  send('set_overlay', { enabled: overlayToggle.checked });
});

startminToggle.addEventListener('change', () => {
  send('set_start_minimized', { enabled: startminToggle.checked });
});

gradToggle.addEventListener('change', () => {
  send('set_gradient_outline', { enabled: gradToggle.checked });
  document.body.classList.toggle('grad-outline', gradToggle.checked);
});

// ---- Sounds (synthesized, gentle - no asset files) ---- //

let audioCtx = null;
function getCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(ctx, freq, startAt, dur, peak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // Soft attack, slow release - no clicks
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.045);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.05);
}

function playSound(kind) {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    const now = ctx.currentTime;

    if (kind === 'start') {
      // Single warm, low note - barely there
      tone(ctx, 494, now, 0.22, 0.05);
      tone(ctx, 659, now + 0.02, 0.2, 0.03);
    } else {
      // Gentle descending "ding-dong" - transcription finished
      tone(ctx, 784, now, 0.35, 0.05);
      tone(ctx, 523, now + 0.14, 0.45, 0.045);
    }
  } catch (e) {
    /* audio is best-effort */
  }
}

// ---- Settings view: hotkey capture ---- //

hotkeyInput.addEventListener('focus', () => {
  hotkeyInput.value = '...';
  hotkeyNote.innerHTML = 'Press the new combination now. <kbd>Esc</kbd> cancels.';
});

hotkeyInput.addEventListener('keydown', (e) => {
  e.preventDefault();
  if (e.key === 'Escape') {
    hotkeyInput.value = activeHotkey;
    hotkeyInput.blur();
    resetHotkeyNote();
    return;
  }
  const hotkey = formatHotkey(e);
  if (hotkey) {
    hotkeyInput.value = hotkey;
    hotkeyInput.blur();
    resetHotkeyNote();
    window.electronAPI.sendToMain('set-hotkey', hotkey);
    toast(`Hotkey set to ${hotkey}`, 'ok');
  }
});

hotkeyInput.addEventListener('blur', () => {
  if (!hotkeyInput.value || hotkeyInput.value === '...') {
    hotkeyInput.value = activeHotkey;
  }
  resetHotkeyNote();
});

function resetHotkeyNote() {
  hotkeyNote.textContent = 'Works system-wide, in any app.';
}

// ---- Downloads view ---- //

function buildDownloadList() {
  modelList.innerHTML = '';

  ENGINES.forEach((engine) => {
    const folder = document.createElement('div');
    folder.className = 'dl-folder';

    const head = document.createElement('button');
    head.className = 'dl-folder-head';
    head.innerHTML = `
      <svg class="dl-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      <span>${engine.name}</span>
      <span class="dl-count">${engine.models.length}</span>
    `;
    head.addEventListener('click', () => {
      openFolders[engine.id] = !openFolders[engine.id];
      folder.classList.toggle('closed', !openFolders[engine.id]);
    });
    folder.appendChild(head);

    const body = document.createElement('div');
    body.className = 'dl-folder-body';
    folder.appendChild(body);

    engine.models.forEach((m) => {
      const item = document.createElement('div');
      item.className = 'dl-item';
      item.id = `dl-${m.value}`;

      const name = document.createElement('span');
      name.className = 'dl-name';
      name.innerHTML = `${m.label}${langBadge(m)}`;
      item.appendChild(name);

      const params = document.createElement('span');
      params.className = 'dl-params';
      params.textContent = m.params;
      item.appendChild(params);

      const size = document.createElement('span');
      size.className = 'dl-size';
      size.textContent = m.size;
      item.appendChild(size);

      const btn = document.createElement('button');
      btn.className = 'dl-btn';
      item.appendChild(btn);
      dlButtons[m.value] = btn;

      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        if (m.comingSoon) return;
        send('download_model', { model: m.value });
        btn.disabled = true;
        btn.textContent = '...';
      });

      body.appendChild(item);
    });

    folder.classList.toggle('closed', !openFolders[engine.id]);
    modelList.appendChild(folder);
  });
}

function updateDownloadList(models) {
  ALL_ENGINE_MODELS.forEach((m) => {
    const item = document.getElementById(`dl-${m.value}`);
    const nameEl = item?.querySelector('.dl-name');
    const paramsEl = item?.querySelector('.dl-params');
    const sizeEl = item?.querySelector('.dl-size');
    const btn = dlButtons[m.value];
    if (!nameEl || !btn) return;

    paramsEl.textContent = m.params;
    sizeEl.textContent = m.size;

    if (m.comingSoon) {
      nameEl.innerHTML = `${m.label}${langBadge(m)} <span class="soon-tag">Coming soon</span>`;
      btn.className = 'dl-btn soon';
      btn.textContent = 'Coming soon';
      btn.disabled = true;
    } else if (models[m.value]) {
      nameEl.innerHTML = `<span class="checkmark">&#10003;</span> ${m.label}${langBadge(m)}`;
      btn.className = 'dl-btn downloaded';
      btn.textContent = 'Downloaded';
      btn.disabled = true;
    } else {
      nameEl.innerHTML = `${m.label}${langBadge(m)}`;
      btn.className = 'dl-btn';
      btn.textContent = 'Download';
      btn.disabled = false;
    }
  });
}

buildDownloadList();

refreshBtn.addEventListener('click', () => {
  send('check_downloaded');
  send('get_state');
  toast('Refreshing...');
});

// ---- Actions (Dictation) ---- //

toggleBtn.addEventListener('click', () => {
  if (isModelLoading || isTranscribing) return;
  if (!isRecording) output.value = '';
  send('toggle');
});

clearBtn.addEventListener('click', () => {
  output.value = '';
  updateSessionMeta();
});

copyBtn.addEventListener('click', async () => {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.textContent = original;
      copyBtn.classList.remove('copied');
    }, 1500);
  } catch (e) {
    console.error('Failed to copy', e);
  }
});

// ---- Renderer-level shortcut fallback ---- //

document.addEventListener('keydown', (e) => {
  const hotkey = formatHotkey(e);
  if (hotkey && (hotkey === activeHotkey || hotkey === 'Ctrl+Shift+R')) {
    e.preventDefault();
    if ((isModelLoading || isTranscribing) && !isRecording) return; // locked while loading/transcribing
    if (!isRecording) {
      output.value = '';
      updateSessionMeta();
      activateView('dictation');
    }
    send('toggle');
  }
});

// ---- Onboarding (first-use wizard) ---- //

const OB_STEP_NAMES = ['Model', 'Behavior', 'Finish'];
let obStep = 1;
let obSelected = 'tiny.en';
let obFinishing = false;
let obActive = false;

function showOnboarding() {
  if (obActive) return;
  obActive = true;
  obStep = 1;
  obFinishing = false;
  obBackBtn.disabled = true;
  obNextBtn.disabled = false;
  obNextBtn.textContent = 'Next';
  obProgressWrap.classList.add('hidden');
  buildObModels();
  renderObStep();
  obBackdrop.classList.remove('hidden');
}

function finishOnboardingSuccess() {
  if (!obActive) return;
  obActive = false;
  obBackdrop.classList.add('hidden');
  toast("You're all set - hold the hotkey's spirit and just talk!", 'ok');
}

function renderObStep() {
  obPanes.forEach((pane, i) => pane.classList.toggle('hidden', i !== obStep - 1));
  obSteps.forEach((s, i) => {
    s.classList.toggle('active', i === obStep - 1);
    s.classList.toggle('done', i < obStep - 1);
  });
  obBackBtn.disabled = obStep === 1 || obFinishing;
  obNextBtn.textContent = obStep === 3 ? 'Download & Finish' : 'Next';
}

function buildObModels() {
  obModelList.innerHTML = '';
  ENGINES.forEach((engine) => {
    const head = document.createElement('div');
    head.className = 'ob-group';
    head.textContent = engine.name;
    obModelList.appendChild(head);

    engine.models.forEach((m) => {
      const row = document.createElement('button');
      row.className = 'ob-model-row' + (m.value === obSelected ? ' selected' : '') + (m.comingSoon ? ' coming-soon' : '');
      row.disabled = !!m.comingSoon;
      row.dataset.value = m.value;
      const dl = downloadedModels[m.value] && !m.comingSoon ? '<span class="checkmark">&#10003;</span> ' : '';
      const availability = m.comingSoon ? '<span class="soon-tag">Coming soon</span>' : '';
      row.innerHTML = `
        <span class="ob-radio"></span>
        <span class="col-name">${dl}${m.label} ${availability}</span>
        <span class="col-params">${m.params}</span>
        <span class="col-size">${m.size}</span>
      `;
      row.addEventListener('click', () => {
        if (m.comingSoon) {
          toast(`${m.label} is coming soon - choose a Whisper model for setup.`);
          return;
        }
        obSelected = m.value;
        obModelList.querySelectorAll('.ob-model-row').forEach((r) => {
          r.classList.toggle('selected', r.dataset.value === m.value);
        });
        updateObNote();
      });
      obModelList.appendChild(row);
    });

    const note = document.createElement('p');
    note.className = 's-hint ob-engine-note';
    note.textContent = engine.note || '';
    obModelList.appendChild(note);
  });
  updateObNote();
}

function updateObNote() {
  const engine = ENGINES.find((e) => e.models.some((m) => m.value === obSelected));
  const model = engine?.models.find((m) => m.value === obSelected);
  const bits = [];
  if (model?.size) bits.push(`Downloads about ${model.size}`);
  if (downloadedModels[obSelected]) bits.push('Already on this machine - no download needed');
  if (engine?.note) bits.push(engine.note);
  obModelNote.textContent = bits.join(' \u00b7 ');
}

function obSummaryHtml() {
  const model = findEngineModel(obSelected);
  const overlay = obOverlayToggle.checked ? 'On' : 'Off';
  const clip = obClipboardToggle.checked ? 'Preserved' : 'Replaced';
  const min = obStartminToggle.checked ? 'To tray' : 'Window';
  return `
    <div class="ob-row"><span>Engine</span><b>${model?.label ?? obSelected}</b></div>
    <div class="ob-row"><span>Overlay bubble</span><b>${overlay}</b></div>
    <div class="ob-row"><span>Clipboard</span><b>${clip}</b></div>
    <div class="ob-row"><span>Startup</span><b>${min}</b></div>
    <div class="ob-row"><span>Hotkey</span><b>${activeHotkey}</b></div>
  `;
}

function obFinish() {
  obFinishing = true;
  obBackBtn.disabled = true;
  obNextBtn.disabled = true;
  obNextBtn.textContent = 'Setting up...';
  obProgressWrap.classList.remove('hidden');
  obProgressFill.style.width = '0%';
  obProgressLabel.textContent = 'Preparing...';
  send('complete_onboarding', {
    config: {
      model: obSelected,
      preserve_clipboard: !!obClipboardToggle.checked,
      overlay_enabled: !!obOverlayToggle.checked,
      start_minimized: !!obStartminToggle.checked,
      hotkey: activeHotkey,
    },
  });
}

obNextBtn.addEventListener('click', () => {
  if (obFinishing) return;
  if (obStep === 2) obSummary.innerHTML = obSummaryHtml();
  if (obStep === 3) { obFinish(); return; }
  obStep = Math.min(3, obStep + 1);
  renderObStep();
});

obBackBtn.addEventListener('click', () => {
  if (obFinishing) return;
  obStep = Math.max(1, obStep - 1);
  renderObStep();
});

// Hotkey capture inside the wizard (same behavior as Settings)
obHotkeyInput.addEventListener('focus', () => {
  obHotkeyInput.value = '...';
  obHotkeyNote.innerHTML = 'Press the new combination now. <kbd>Esc</kbd> cancels.';
});

obHotkeyInput.addEventListener('keydown', (e) => {
  e.preventDefault();
  if (e.key === 'Escape') {
    obHotkeyInput.value = activeHotkey;
    obHotkeyInput.blur();
    resetObHotkeyNote();
    return;
  }
  const hotkey = formatHotkey(e);
  if (hotkey) {
    obHotkeyInput.value = hotkey;
    obHotkeyInput.blur();
    resetObHotkeyNote();
    activeHotkey = hotkey;
    window.electronAPI.sendToMain('set-hotkey', hotkey);
    toast(`Hotkey set to ${hotkey}`, 'ok');
  }
});

obHotkeyInput.addEventListener('blur', () => {
  if (!obHotkeyInput.value || obHotkeyInput.value === '...') {
    obHotkeyInput.value = activeHotkey;
  }
  resetObHotkeyNote();
});

function resetObHotkeyNote() {
  obHotkeyNote.textContent = 'Works system-wide, in any app.';
}

// ---- Backend messages ---- //

window.electronAPI.onPythonMessage((msg) => {
  switch (msg.type) {
    case 'startup':
      if (loadingStatus) loadingStatus.textContent = msg.text || 'Initializing Faster-Whisper engine...';
      break;

    case 'ready':
    case 'config_updated':
      if (msg.type === 'ready' && msg.first_run) showOnboarding();
      if (msg.config) {
        if (msg.config.hotkey) renderHotkeyDisplay(msg.config.hotkey);
        if (msg.config.device) setDeviceUI(msg.config.device);
        if (msg.config.compute) {
          const effective = msg.config.device === 'cpu' ? 'int8' : msg.config.compute;
          setPrecisionUI(effective);
        }
        if (msg.config.model) {
          selectTrigger.dataset.currentValue = msg.config.model;
          selectValue.textContent = msg.config.model;
        }
        if (msg.config.theme !== undefined && window.WhisperTheme) {
          window.WhisperTheme.apply(msg.config.theme);
          markActiveTheme(msg.config.theme);
        }
        if (msg.config.hotkey && document.activeElement !== hotkeyInput) {
          hotkeyInput.value = msg.config.hotkey;
        }
        preserveToggle.checked = !!msg.config.preserve_clipboard;
        overlayToggle.checked = !!msg.config.overlay_enabled;
        startminToggle.checked = !!msg.config.start_minimized;
        gradToggle.checked = !!msg.config.gradient_outline;
        document.body.classList.toggle('grad-outline', gradToggle.checked);
        document.querySelectorAll('.chip.busy').forEach((c) => c.classList.remove('busy'));
        buildDropdown();
      }
      break;

    case 'model_loading':
      setModelLoading(true, msg.model);
      if (loadingStatus) loadingStatus.textContent = `Loading ${msg.model}...`;
      break;

    case 'model_loaded':
      loadedModel = msg.model;
      selectValue.textContent = msg.model;
      selectTrigger.dataset.currentValue = msg.model;
      document.querySelectorAll('.select-row').forEach((r) => {
        r.classList.toggle('selected', r.dataset.value === msg.model);
      });
      setModelLoading(false);
      hideLoadingOverlay();
      if (obActive) finishOnboardingSuccess();
      break;

    case 'onboarding_stage':
      if (obActive) {
        obProgressWrap.classList.remove('hidden');
        obProgressLabel.textContent = msg.stage === 'download'
          ? `Downloading ${msg.model}...`
          : `Loading ${msg.model}...`;
      }
      break;

    case 'status':
      statusText.textContent = msg.text;
      if (msg.recording !== undefined) setRecording(msg.recording);
      // Keep "Transcribing..." visible - setRecording(false) no longer clobbers it
      if (msg.text === 'Transcribing...') setTranscribing(true);
      else if (msg.text === 'Idle' || msg.text === 'Ready') setTranscribing(false);
      break;

    case 'transcript':
      output.value = msg.text;
      output.scrollTop = output.scrollHeight;
      updateSessionMeta();
      setTranscribing(false);
      statusText.textContent = 'Ready';
      if (msg.text) playSound('done');
      break;

    case 'downloaded_models':
      downloadedModels = msg.models;
      buildDropdown();
      updateDownloadList(msg.models);
      break;

    case 'download_status': {
      const btn = dlButtons[msg.model];
      if (msg.status === 'downloading') {
        progressWrapper.classList.remove('hidden');
        const pct = Math.max(0, Math.min(100, msg.progress || 0));
        progressFill.style.width = pct + '%';
        progressLabel.textContent = `${msg.model} — ${pct}%`;
        if (btn) {
          btn.textContent = `${pct}%`;
          btn.disabled = true;
        }
        if (obActive && obFinishing) {
          obProgressWrap.classList.remove('hidden');
          obProgressFill.style.width = pct + '%';
          obProgressLabel.textContent = `Downloading ${msg.model} — ${pct}%`;
        }
      } else if (msg.status === 'done') {
        progressWrapper.classList.add('hidden');
        progressFill.style.width = '0%';
        toast(`${msg.model} downloaded`, 'ok');
        if (obActive) {
          obProgressFill.style.width = '100%';
          obProgressLabel.textContent = 'Download complete - loading model...';
        }
      } else if (msg.status === 'error') {
        progressWrapper.classList.add('hidden');
        progressFill.style.width = '0%';
        if (btn) {
          btn.textContent = 'Retry';
          btn.disabled = false;
        }
        toast(`Download failed: ${msg.text}`, 'err');
        if (obActive && obFinishing) {
          obFinishing = false;
          obNextBtn.disabled = false;
          obBackBtn.disabled = false;
          obNextBtn.textContent = 'Retry Setup';
          obProgressLabel.textContent = `Download failed: ${msg.text || 'unknown error'}`;
        }
      }
      break;
    }

    case 'shortcut_info':
      renderHotkeyDisplay(msg.shortcut);
      break;

    case 'warning':
      toast(msg.text);
      break;

    case 'error':
      statusText.textContent = msg.text;
      statusText.classList.add('err');
      setTimeout(() => statusText.classList.remove('err'), 8000);
      console.error('Backend error:', msg.text);
      setModelLoading(false);
      setTranscribing(false);
      hideLoadingOverlay();
      if (obActive && obFinishing) {
        obFinishing = false;
        obNextBtn.disabled = false;
        obBackBtn.disabled = false;
        obNextBtn.textContent = 'Retry Setup';
        obProgressLabel.textContent = msg.text;
      }
      break;
  }
});

function setRecording(recording) {
  isRecording = recording;
  if (recording) {
    playSound('start');
    output.value = '';
    updateSessionMeta();
    toggleBtn.classList.add('recording');
    recIndicator.className = 'indicator recording';
    toggleBtn.querySelector('.btn-text').textContent = 'Stop Recording';
    statusText.textContent = 'Recording...';
    statusText.classList.remove('err');
    recStartTs = Date.now();
    if (metaTimer) clearInterval(metaTimer);
    metaTimer = setInterval(updateSessionMeta, 500);
  } else {
    toggleBtn.classList.remove('recording');
    toggleBtn.querySelector('.btn-text').textContent = 'Record';
    // Don't clobber backend statuses like "Transcribing..." - only reset
    // if we're still showing a stale recording state
    if (statusText.textContent.startsWith('Recording')) {
      statusText.textContent = 'Ready';
    }
    recStartTs = null;
    if (metaTimer) clearInterval(metaTimer);
    metaTimer = null;
    updateSessionMeta();
  }
}

// Proactive backend handshake
send('get_state');
send('check_downloaded');
setTimeout(() => send('get_state'), 300);
setTimeout(() => send('get_state'), 1000);
