// Overlay bubble logic - reacts to backend status broadcasts.

const body = document.body;
const bubble = document.getElementById('bubble');
const bar = document.getElementById('bar');
const bars = Array.from(document.querySelectorAll('.bars span'));
const BASE_HEIGHTS = [10, 16, 24, 32, 24, 16, 10];

let state = 'idle';
let level = 0;
let enabled = false;

function setState(next) {
  if (state === next) return;
  state = next;
  // Grow the window BEFORE the bar animates in so nothing clips
  resizeWindow();
  body.className = `state-${next}`;
  applyVisibility();
}

async function applyVisibility() {
  try {
    const win = getWin();
    if (state === 'idle' || !enabled) {
      await win.hide(); // invisible unless the feature is on AND something is happening
    } else {
      await win.show();
    }
  } catch (e) {
    console.error('visibility failed', e);
  }
}

let dbgTimer = null;
function dbg(text) {
  let el = document.getElementById('ovl-dbg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ovl-dbg';
    el.style.cssText =
      'position:fixed;left:4px;bottom:2px;font-size:9px;color:#ff6b57;font-family:monospace;z-index:99;max-width:250px;word-break:break-all';
    document.body.appendChild(el);
  }
  el.textContent = text || '';
  if (dbgTimer) clearTimeout(dbgTimer);
  if (text) dbgTimer = setTimeout(() => (el.textContent = ''), 5000);
}

function getWin() {
  const t = window.__TAURI__;
  if (t.webviewWindow && typeof t.webviewWindow.getCurrentWebviewWindow === 'function') {
    return t.webviewWindow.getCurrentWebviewWindow();
  }
  if (t.window && typeof t.window.getCurrentWindow === 'function') {
    return t.window.getCurrentWindow();
  }
  if (t.window && typeof t.window.getCurrent === 'function') {
    return t.window.getCurrent();
  }
  throw new Error('no window API found');
}

async function resizeWindow() {
  const target = state === 'recording' ? [230, 62] : [62, 62];
  try {
    const win = getWin();
    const { LogicalSize, PhysicalSize } = window.__TAURI__.dpi;

    const setSizeWithFallback = async () => {
      const dpr = window.devicePixelRatio || 1;
      try {
        await win.setSize(new LogicalSize(target[0], target[1]));
      } catch (e1) {
        dbg('logical failed: ' + e1);
        await win.setSize(
          new PhysicalSize(Math.round(target[0] * dpr), Math.round(target[1] * dpr))
        );
      }
    };

    await setSizeWithFallback();

    // Verify the webview actually grew; retry with physical pixels if not
    await new Promise((r) => setTimeout(r, 40));
    if (Math.abs(window.innerWidth - target[0]) > 24) {
      dbg(`retry: got ${window.innerWidth}, want ${target[0]}`);
      const dpr = window.devicePixelRatio || 1;
      await win.setSize(
        new PhysicalSize(Math.round(target[0] * dpr), Math.round(target[1] * dpr))
      );
      await new Promise((r) => setTimeout(r, 40));
      if (Math.abs(window.innerWidth - target[0]) > 24) {
        dbg(`still ${window.innerWidth} vs ${target[0]}`);
      }
    }
  } catch (e) {
    dbg('resize err: ' + e);
    console.error('resize failed', e);
  }
}

// ---- Click vs drag ----
// Short press without movement = toggle record.
// Press + move beyond threshold = start dragging the window.

let press = null;

function initGestures(el) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    press = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
}

initGestures(bubble);
initGestures(bar);

window.addEventListener('mousemove', (e) => {
  if (!press) return;
  const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  if (dist > 5) {
    press = null;
    try {
      getWin().startDragging();
    } catch (err) {
      console.error('drag failed', err);
    }
  }
});

window.addEventListener('mouseup', () => {
  if (press && Date.now() - press.t < 400) {
    // It was a click, not a drag
    window.electronAPI.sendToPython({ action: 'toggle' });
  }
  press = null;
});

// Animate volume bars from mic_level events
setInterval(() => {
  if (state !== 'recording') return;
  const jitter = 0.65 + Math.random() * 0.35;
  const target = Math.max(0.08, level) * jitter;
  bars.forEach((b, i) => {
    const base = BASE_HEIGHTS[i] / 32;
    b.style.height = `${Math.max(6, Math.min(36, target * 36 * base + 6))}px`;
  });
}, 90);

window.electronAPI.onPythonMessage((msg) => {
  switch (msg.type) {
    case 'config_updated':
    case 'ready':
      if (msg.config && msg.config.theme !== undefined && window.WhisperTheme) {
        WhisperTheme.apply(msg.config.theme);
      }
      document.body.classList.toggle(
        'grad-outline',
        !!(msg.config && msg.config.gradient_outline)
      );
      // The master switch: when off, the bubble must never appear
      enabled = !!(msg.config && msg.config.overlay_enabled);
      if (!enabled) {
        state = 'idle';
        body.className = 'state-idle';
      }
      applyVisibility();
      break;

    case 'status':
      if (!enabled) break; // feature disabled -> ignore triggers entirely
      if (msg.recording === true || msg.text === 'Recording...') {
        setState('recording');
      } else if (msg.text === 'Transcribing...') {
        setState('transcribing');
      } else if (msg.text === 'Ready' || msg.text === 'Idle') {
        setState('idle');
      }
      break;

    case 'mic_level':
      level = msg.value || 0;
      break;

    case 'model_loading':
      setState('idle');
      break;
  }
});

// Start hidden - only appears when a trigger fires
setTimeout(() => {
  resizeWindow();
  applyVisibility();
}, 150);

// Ask for current config - recreated windows miss earlier broadcasts,
// so without this the bubble stays disabled forever after a re-enable
window.electronAPI.sendToPython({ action: 'get_state' });
