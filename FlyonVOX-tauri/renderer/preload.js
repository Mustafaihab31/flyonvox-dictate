// Tauri port of preload.js.
// Exposes the exact same `window.electronAPI` surface the renderer expects,
// backed by Tauri's global IPC API (withGlobalTauri) instead of Electron.
(function () {
  if (!window.__TAURI__) {
    console.error('Tauri API not available - did you enable withGlobalTauri?');
    window.electronAPI = {
      onPythonMessage: () => () => {},
      sendToPython: () => {},
      sendToMain: () => {},
      toggleDevtools: () => {},
    };
    return;
  }

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.electronAPI = {
    onPythonMessage: (callback) => {
      const unlistenPromise = listen('python-message', (event) => callback(event.payload));
      return () => {
        unlistenPromise.then((unlisten) => unlisten());
      };
    },
    sendToPython: (msg) => {
      invoke('send_to_python_cmd', { msg });
    },
    sendToMain: (channel, data) => {
      if (channel === 'set-hotkey') {
        invoke('set_hotkey', { hotkey: data });
      }
    },
    toggleDevtools: () => {
      invoke('toggle_devtools');
    },
  };
})();
