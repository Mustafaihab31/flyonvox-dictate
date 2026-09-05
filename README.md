# FlyonVOX Dictate

FlyonVOX Dictate is a privacy-first, local voice dictation app for Windows. Press a global hotkey, speak, and the transcript is pasted into the application that was previously focused. Speech recognition runs locally with downloadable Faster-Whisper models.

The project is currently an early preview. The working path is the Tauri desktop app in [`FlyonVOX-tauri/`](FlyonVOX-tauri/). The repository also contains an early marketing site and UI explorations that are not required to run the app.

## What works today

- Local microphone recording at 16 kHz mono audio.
- Faster-Whisper models from `tiny` through `large-v3-turbo`.
- CPU and CUDA execution, with INT8 and supported FP16 compute modes.
- Configurable global hotkey, defaulting to `Ctrl+Alt+R`.
- Automatic clipboard paste into the previously focused Windows app.
- Optional clipboard restoration after pasting.
- Optional floating recording overlay and system-tray operation.
- Model downloads and first-run onboarding.
- Multiple color themes.

NVIDIA Parakeet and Canary support remains in the codebase, but is marked **Coming soon** in the public UI while it is being tested. It is not currently offered for download or selection.

## Privacy

Transcription is local after a model has been downloaded. The app accesses the microphone while recording and uses the clipboard plus simulated `Ctrl+V` input to insert transcripts into other applications. Model downloads require an internet connection. No account is required by the current application.

## Development setup

The current development target is Windows.

Prerequisites:

- Node.js and npm
- Rust and the Tauri prerequisites
- Python 3.10+
- A working Windows audio input device
- CUDA toolkit/driver support only if using GPU inference

From the repository root:

```powershell
cd FlyonVOX-tauri
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
npm install
npm run dev
```

On first launch, choose a Whisper model in the setup wizard. Larger models need substantially more disk space and memory. The model files are intentionally downloaded at runtime and are not stored in Git.

## Project layout

- `FlyonVOX-tauri/renderer/` — Tauri frontend and overlay UI.
- `FlyonVOX-tauri/src-tauri/` — Rust host, tray integration, global shortcuts, and IPC.
- `FlyonVOX-tauri/whisper_main.py` — Python audio, model, download, and paste backend.
- `FlyonVOX-tauri/config.example.json` — example local configuration.

## Status

This project is being prepared for its first public release. Expect Windows-only behavior, changing APIs, and incomplete packaging while the core workflow is stabilized.

## License

The project is released under the MIT License. Individual speech models and third-party dependencies remain subject to their own licenses.
