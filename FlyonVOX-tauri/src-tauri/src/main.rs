// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

struct AppState {
    python_stdin: Mutex<Option<ChildStdin>>,
    python_child: Mutex<Option<Child>>,
    current_hotkey: Mutex<String>,
}

// ---- Python bridge (port of main.js startPython/sendToPython) ---- //

fn send_to_python_state(state: &AppState, msg: &Value) -> Result<(), String> {
    let mut guard = state.python_stdin.lock().unwrap();
    match guard.as_mut() {
        Some(stdin) => {
            let mut line = msg.to_string();
            line.push('\n');
            stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.flush())
                .map_err(|e| e.to_string())
        }
        None => Err("Python backend is not running".into()),
    }
}

fn send_to_python(app: &AppHandle, msg: &Value) {
    let state = app.state::<AppState>();
    if let Err(e) = send_to_python_state(&state, msg) {
        eprintln!("Failed to send to Python: {}", e);
        let _ = app.emit(
            "python-message",
            json!({ "type": "error", "text": format!("Python backend error: {}", e) }),
        );
    }
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri always lives in a parent dir")
        .to_path_buf()
}

// Prefer the project-local .venv (bundled sherpa-onnx runtime) so the app is
// self-contained; fall back to whatever "python" is on PATH.
fn python_executable(root: &std::path::Path) -> PathBuf {
    let venv_python = root.join(".venv").join("Scripts").join("python.exe");
    if venv_python.exists() {
        venv_python
    } else {
        PathBuf::from("python")
    }
}

// ---- Floating overlay bubble ---- //
// Created hidden; the overlay shows itself only while recording/transcribing.

fn ensure_overlay(app: &AppHandle) {
    if app.get_webview_window("overlay").is_some() {
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Fly Overlay")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .inner_size(62.0, 62.0)
        .build();
}

fn hide_overlay(app: &AppHandle) {
    // Close (not just hide) so the bubble can never resurrect itself
    // via its own status listeners while the feature is disabled.
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.close();
    }
}

fn start_python(app: AppHandle) {
    let root = project_root();
    let script = root.join("whisper_main.py");

    if !script.exists() {
        let _ = app.emit(
            "python-message",
            json!({
                "type": "error",
                "text": format!("whisper_main.py not found at {}", script.display()),
            }),
        );
        return;
    }

    match Command::new(python_executable(&root))
        .arg("-u")
        .arg(&script)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            let stdin = child.stdin.take();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            {
                let state = app.state::<AppState>();
                *state.python_stdin.lock().unwrap() = stdin;
                *state.python_child.lock().unwrap() = Some(child);
            }

            let app_out = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout.expect("stdout was piped"));
                let mut overlay_on = false;
                let mut did_start_minimized = false;
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let msg: Value = match serde_json::from_str(trimmed) {
                        Ok(m) => m,
                        Err(_) => {
                            eprintln!("Failed to parse Python output: {}", trimmed);
                            continue;
                        }
                    };

                    // Register hotkey from initial config + spawn overlay if enabled
                    if msg["type"] == "ready" {
                        if let Some(hotkey) = msg.pointer("/config/hotkey").and_then(Value::as_str)
                        {
                            register_hotkey(&app_out, hotkey);
                        }
                        if msg
                            .pointer("/config/overlay_enabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                            && !overlay_on
                        {
                            overlay_on = true;
                            ensure_overlay(&app_out);
                        }
                        // Start minimized to tray (first ready only)
                        if !did_start_minimized
                            && msg
                                .pointer("/config/start_minimized")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                        {
                            did_start_minimized = true;
                            if let Some(w) = app_out.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }

                    // Handle config_updated - re-register hotkey / sync overlay
                    if msg["type"] == "config_updated" {
                        if let Some(hotkey) = msg.pointer("/config/hotkey").and_then(Value::as_str)
                        {
                            let current = {
                                let state = app_out.state::<AppState>();
                                let guard = state.current_hotkey.lock().unwrap();
                                guard.clone()
                            };
                            if !hotkey.is_empty() && hotkey != current {
                                register_hotkey(&app_out, hotkey);
                            }
                        }
                        let want = msg
                            .pointer("/config/overlay_enabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        if want != overlay_on {
                            overlay_on = want;
                            if want {
                                ensure_overlay(&app_out);
                            } else {
                                hide_overlay(&app_out);
                            }
                        }
                    }

                    let _ = app_out.emit("python-message", msg);
                }

                // Process exited
                println!("Python process exited");
                let _ = app_out.emit(
                    "python-message",
                    json!({ "type": "backend_state", "connected": false }),
                );

                let state = app_out.state::<AppState>();
                *state.python_stdin.lock().unwrap() = None;
                state.python_child.lock().unwrap().take();
            });

            // stderr logger
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr.expect("stderr was piped"));
                for line in reader.lines().map_while(Result::ok) {
                    eprintln!("Python stderr: {}", line);
                }
            });
        }
        Err(err) => {
            eprintln!("Failed to start Python: {}", err);
            let _ = app.emit(
                "python-message",
                json!({
                    "type": "error",
                    "text": format!("Failed to start Python: {}", err),
                }),
            );
        }
    }
}

// ---- Global shortcuts (port of main.js registerHotkey) ---- //

fn register_hotkey(app: &AppHandle, hotkey: &str) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    // Mirrors [hotkey, 'Ctrl+Shift+R'] fallbacks with [...new Set(...)]
    let mut candidates = vec![hotkey.to_string(), "Ctrl+Shift+R".to_string()];
    candidates.dedup();

    let mut registered_key: Option<String> = None;

    for key in candidates {
        let shortcut: Shortcut = match key.parse() {
            Ok(s) => s,
            Err(err) => {
                println!("Failed to parse shortcut '{}': {}", key, err);
                continue;
            }
        };
        match gs.register(shortcut) {
            Ok(()) => {
                println!("Shortcut {} triggered -> registered", key);
                registered_key = Some(key);
                break;
            }
            Err(err) => {
                println!("Failed to register shortcut {}: {}", key, err);
            }
        }
    }

    {
        let state = app.state::<AppState>();
        *state.current_hotkey.lock().unwrap() =
            registered_key.clone().unwrap_or_else(|| hotkey.to_string());
    }

    match registered_key {
        Some(key) => {
            let _ = app.emit(
                "python-message",
                json!({ "type": "shortcut_info", "shortcut": key }),
            );

            if key != hotkey {
                // Inform but NEVER overwrite the saved preference - the
                // requested hotkey stays in config.json for future launches.
                let _ = app.emit(
                    "python-message",
                    json!({
                        "type": "warning",
                        "text": format!(
                            "\"{}\" could not be registered globally. Using \"{}\" for this session.",
                            hotkey, key
                        ),
                    }),
                );
            }
        }
        None => {
            let _ = app.emit(
                "python-message",
                json!({
                    "type": "error",
                    "text": "Could not register any global hotkey. Use the button or click in the window and press Ctrl+Shift+R.",
                }),
            );
        }
    }
}

// ---- IPC commands (port of main.js ipcMain handlers) ---- //

#[tauri::command]
fn send_to_python_cmd(state: State<'_, AppState>, msg: Value) -> Result<(), String> {
    send_to_python_state(&state, &msg)
}

#[tauri::command]
fn set_hotkey(app: AppHandle, hotkey: String) {
    register_hotkey(&app, &hotkey);
    send_to_python(&app, &json!({ "action": "set_hotkey", "hotkey": hotkey }));
}

#[tauri::command]
fn toggle_devtools(window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
    #[cfg(not(debug_assertions))]
    let _ = window;
}

// ---- App entry ---- //

fn cleanup(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let state = app.state::<AppState>();
    *state.python_stdin.lock().unwrap() = None;
    let child = state.python_child.lock().unwrap().take();
    drop(state);
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        println!("Shortcut {:?} triggered", shortcut);
                        send_to_python(app, &json!({ "action": "toggle" }));
                    }
                })
                .build(),
        )
        .manage(AppState {
            python_stdin: Mutex::new(None),
            python_child: Mutex::new(None),
            current_hotkey: Mutex::new("Ctrl+Alt+R".to_string()),
        })
        .invoke_handler(tauri::generate_handler![
            send_to_python_cmd,
            set_hotkey,
            toggle_devtools
        ])
        .setup(|app| {
            // ---- System tray ---- //
            let open_i = MenuItem::with_id(app, "open", "Open Fly", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("fly-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Fly - local dictation")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Re-register the current hotkey when the window regains focus
            // (port of app.on('focus')).
            let handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                let win_for_close = window.clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::Focused(true) => {
                        let hotkey = {
                            let state = handle.state::<AppState>();
                            let guard = state.current_hotkey.lock().unwrap();
                            guard.clone()
                        };
                        if !hotkey.is_empty() {
                            register_hotkey(&handle, &hotkey);
                        }
                    }
                    // Close button hides to tray instead of quitting
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = win_for_close.hide();
                    }
                    _ => {}
                });
            }

            start_python(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                cleanup(app);
            }
        });
}
