import threading
import queue
import wave
import json
import sys
import os
import time
import gc
import tarfile
import urllib.request
import ctypes
from pathlib import Path

# ---- App-local model storage ---- #
# Everything lives under <app dir>/models so an installed copy of the app is
# fully self-contained. Must run before third-party imports because
# huggingface_hub snapshots HF_HOME/HF_HUB_CACHE at import time.
APP_DIR = Path(__file__).resolve().parent
MODELS_DIR = APP_DIR / "models"
os.environ["HF_HOME"] = str(MODELS_DIR / "huggingface")
os.environ["HF_HUB_CACHE"] = str(MODELS_DIR / "huggingface" / "hub")

import numpy as np
import sounddevice as sd
import pyperclip
import pyautogui
from faster_whisper import WhisperModel
from huggingface_hub import HfApi, hf_hub_download

AVAILABLE_MODELS = [
    "tiny", "tiny.en", "base", "base.en", "small", "small.en",
    "medium", "medium.en", "large-v2", "large-v3", "large-v3-turbo",
]

# NeMo-family models (NVIDIA Parakeet / Canary) served through sherpa-onnx.
# Archives are tar.bz2 release assets from k2-fsa/sherpa-onnx containing
# pre-quantized ONNX encoder/decoder (+joiner) graphs and tokens.txt.
NEMO_MODELS = {
    "parakeet-tdt-0.6b-v2": {
        "kind": "transducer",
        "dirname": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
    },
    "parakeet-tdt-0.6b-v3": {
        "kind": "transducer",
        "dirname": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
    },
    "canary-180m-flash": {
        "kind": "canary",
        "dirname": "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
        "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2",
    },
}

# Keep the decoder neutral by default. A domain prompt can make a final padded
# Whisper window continue a plausible sentence after the user has stopped.
VAD_PARAMETERS = {
    "min_silence_duration_ms": 700,
    "speech_pad_ms": 200,
    "min_speech_duration_ms": 200,
}

MODEL_REPO_ALIASES = {
    "large-v3-turbo": [
        "Systran/faster-whisper-large-v3-turbo",
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    ],
}


def get_repo_ids(model_name):
    return MODEL_REPO_ALIASES.get(
        model_name, [f"Systran/faster-whisper-{model_name}"]
    )


SAMPLE_RATE = 16000
CHANNELS = 1

# pyperclip only handles text. On Windows, preserve the native clipboard
# formats so images, HTML, and rich content survive the dictation paste.
_CLIPBOARD_MAX_BYTES = 64 * 1024 * 1024
_GMEM_MOVEABLE = 0x0002
_CF_BITMAP = 2
_CF_METAFILEPICT = 3
_CF_PALETTE = 9
_CF_ENHMETAFILE = 14
_CF_OWNERDISPLAY = 0x0080
_CF_DSPBITMAP = 0x0082
_CF_DSPMETAFILEPICT = 0x0083


def _configure_clipboard_api():
    """Return configured Win32 clipboard APIs, or None on non-Windows."""
    if os.name != "nt":
        return None

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = ctypes.c_void_p

    user32.OpenClipboard.argtypes = [handle]
    user32.OpenClipboard.restype = ctypes.c_bool
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = ctypes.c_bool
    user32.EmptyClipboard.argtypes = []
    user32.EmptyClipboard.restype = ctypes.c_bool
    user32.EnumClipboardFormats.argtypes = [ctypes.c_uint]
    user32.EnumClipboardFormats.restype = ctypes.c_uint
    user32.GetClipboardData.argtypes = [ctypes.c_uint]
    user32.GetClipboardData.restype = handle
    user32.SetClipboardData.argtypes = [ctypes.c_uint, handle]
    user32.SetClipboardData.restype = handle

    kernel32.GlobalSize.argtypes = [handle]
    kernel32.GlobalSize.restype = ctypes.c_size_t
    kernel32.GlobalLock.argtypes = [handle]
    kernel32.GlobalLock.restype = handle
    kernel32.GlobalUnlock.argtypes = [handle]
    kernel32.GlobalUnlock.restype = ctypes.c_bool
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = handle
    kernel32.GlobalFree.argtypes = [handle]
    kernel32.GlobalFree.restype = handle

    return user32, kernel32


def _open_windows_clipboard(user32):
    for _ in range(20):
        if user32.OpenClipboard(None):
            return True
        time.sleep(0.01)
    return False


def _snapshot_windows_clipboard():
    """Capture HGLOBAL-backed clipboard formats, including common image data."""
    api = _configure_clipboard_api()
    if api is None:
        return None
    user32, kernel32 = api
    if not _open_windows_clipboard(user32):
        return None

    formats = []
    skip_formats = {
        _CF_BITMAP,
        _CF_METAFILEPICT,
        _CF_PALETTE,
        _CF_ENHMETAFILE,
        _CF_OWNERDISPLAY,
        _CF_DSPBITMAP,
        _CF_DSPMETAFILEPICT,
    }
    try:
        clipboard_format = 0
        while True:
            clipboard_format = user32.EnumClipboardFormats(clipboard_format)
            if not clipboard_format:
                break
            if clipboard_format in skip_formats:
                continue

            data_handle = user32.GetClipboardData(clipboard_format)
            if not data_handle:
                continue
            size = int(kernel32.GlobalSize(data_handle))
            if size <= 0 or size > _CLIPBOARD_MAX_BYTES:
                continue

            data_ptr = kernel32.GlobalLock(data_handle)
            if not data_ptr:
                continue
            try:
                payload = ctypes.string_at(data_ptr, size)
            finally:
                kernel32.GlobalUnlock(data_handle)
            formats.append((int(clipboard_format), payload))
    finally:
        user32.CloseClipboard()
    return formats


def _restore_windows_clipboard(formats):
    """Restore a clipboard snapshot created by _snapshot_windows_clipboard."""
    api = _configure_clipboard_api()
    if api is None or formats is None:
        return False
    user32, kernel32 = api
    if not _open_windows_clipboard(user32):
        return False

    try:
        if not user32.EmptyClipboard():
            return False
        for clipboard_format, payload in formats:
            data_handle = kernel32.GlobalAlloc(_GMEM_MOVEABLE, max(1, len(payload)))
            if not data_handle:
                continue
            data_ptr = kernel32.GlobalLock(data_handle)
            if not data_ptr:
                kernel32.GlobalFree(data_handle)
                continue
            try:
                ctypes.memmove(data_ptr, payload, len(payload))
            finally:
                kernel32.GlobalUnlock(data_handle)

            # SetClipboardData takes ownership only when it succeeds.
            if not user32.SetClipboardData(clipboard_format, data_handle):
                kernel32.GlobalFree(data_handle)
    finally:
        user32.CloseClipboard()
    return True


def capture_clipboard():
    """Capture the current clipboard with native formats when available."""
    if os.name == "nt":
        snapshot = _snapshot_windows_clipboard()
        return ("windows", snapshot) if snapshot is not None else None
    try:
        return ("text", pyperclip.paste())
    except Exception:
        return None


def restore_clipboard(snapshot):
    """Restore a clipboard snapshot, preserving images on Windows."""
    if snapshot is None:
        return False
    kind, payload = snapshot
    if kind == "windows":
        return _restore_windows_clipboard(payload)
    try:
        pyperclip.copy(payload)
        return True
    except Exception:
        return False

CONFIG_FILE = APP_DIR / "config.json"
HF_CACHE = MODELS_DIR / "huggingface" / "hub"          # new downloads land here
LEGACY_HF_CACHE = Path(os.path.expanduser("~")) / ".cache" / "huggingface" / "hub"
CT2_CACHE = Path(os.path.expanduser("~")) / ".cache" / "ctranslate2" / "models"
FW_CACHE = Path(os.path.expanduser("~")) / ".cache" / "faster_whisper" / "models"
SHERPA_DIR = MODELS_DIR / "sherpa"

DEFAULT_CONFIG = {
    "hotkey": "Ctrl+Alt+R",
    "device": "cuda",
    "model": "tiny.en",
    "language": "en",
    "compute": "int8",
    "theme": "system",
    "preserve_clipboard": False,
    "overlay_enabled": True,
    "start_minimized": False,
    "gradient_outline": False,
    # First-use wizard: flips to true when complete_onboarding succeeds
    "onboarded": False,
}

config = dict(DEFAULT_CONFIG)
first_run = False
VALID_THEMES = {"system", "graphite", "daylight", "forest", "ocean", "crimson", "slate", "mono"}
model = None   # faster-whisper WhisperModel (whisper backend)
nemo = None    # sherpa-onnx OfflineRecognizer (parakeet/canary backend)
is_recording = False
is_processing = False
is_model_loading = False
stream = None
audio_chunks: list[np.ndarray] = []
audio_q: "queue.Queue[np.ndarray | None]" = queue.Queue()
collector_thread = None
model_op_lock = threading.Lock()
_lvl_state = {"t": 0.0}


def _effective_compute():
    # float16 is not supported on CPU by ctranslate2, fall back to int8
    return "int8" if config["device"] == "cpu" else config.get("compute", "int8")


def _unload_engine():
    """Free the active engine(s) and release their RAM/VRAM before a reload."""
    global model, nemo
    if model is not None:
        try:
            del model
        except Exception:
            pass
        model = None
    if nemo is not None:
        # OfflineRecognizer has no explicit close; dropping the reference frees ONNX sessions
        nemo = None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _cuda_supports(compute):
    """Mirror ctranslate2's strict 'efficient compute' requirements.
    float16 needs compute capability >= 7.0 (Volta/Turing/RTX+)."""
    if compute == "int8":
        return True
    try:
        import ctranslate2
        types = [t.name.lower() for t in ctranslate2.get_supported_compute_types("cuda")]
        return compute in types
    except Exception:
        return False


def _sanitize_compute():
    """If the stored precision is unsupported on the current device,
    downgrade to int8 and persist - never fail a device switch over precision."""
    if config["device"] == "cuda" and not _cuda_supports(config.get("compute", "int8")):
        config["compute"] = "int8"
        save_config()
        send_json({"type": "warning", "text": "GPU does not support float16 - using int8."})


def _restore_previous(prev):
    """Best-effort reload with a previous known-good config after a failed swap."""
    global model, nemo
    try:
        send_json({"type": "status", "text": "Restoring previous settings..."})
        config.update(prev)
        save_config()
        _unload_engine()
        _assign_engine(config["model"], _build_engine(config["model"]))
        send_json({"type": "config_updated", "config": {**config}})
        send_json({"type": "model_loaded", "model": config["model"]})
        send_json({"type": "status", "text": "Ready"})
    except Exception as e:
        model = None
        nemo = None
        send_json({"type": "error", "text": f"Restore failed: {e}"})
        send_json({"type": "status", "text": "Error"})


_print_lock = threading.Lock()


def send_json(msg):
    line = json.dumps(msg)
    with _print_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def load_config():
    global config, first_run
    if not CONFIG_FILE.exists():
        # Brand-new install: keep defaults and let the UI run the setup wizard
        config = dict(DEFAULT_CONFIG)
        first_run = True
        return
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        config = {**DEFAULT_CONFIG, **data}
        # A saved config without the flag predates the wizard - that user is done
        if "onboarded" not in data:
            config["onboarded"] = True
        first_run = False
    except Exception as e:
        send_json({"type": "error", "text": f"Config load failed: {e}"})
        config = dict(DEFAULT_CONFIG)
        first_run = True


def save_config():
    try:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp_file = CONFIG_FILE.with_suffix(".tmp")
        temp_file.write_text(json.dumps(config, indent=2), encoding="utf-8")
        temp_file.replace(CONFIG_FILE)
    except Exception as e:
        send_json({"type": "error", "text": f"Config save failed: {e}"})


def _snapshot_ok(repo_dir):
    snaps = Path(repo_dir) / "snapshots"
    if not snaps.is_dir():
        return False
    for snap in snaps.iterdir():
        if snap.is_dir() and (snap / "model.bin").exists() and (snap / "config.json").exists():
            return True
    return False


def is_model_downloaded(model_name):
    for repo_id in get_repo_ids(model_name):
        safe_name = repo_id.replace("/", "--")
        for base in (HF_CACHE, LEGACY_HF_CACHE):
            if _snapshot_ok(base / f"models--{safe_name}"):
                return True
    for v in [f"faster-whisper-{model_name}", model_name]:
        p = CT2_CACHE / v
        if p.exists() and any(p.iterdir()):
            return True
    for v in [f"faster-whisper-{model_name}", model_name]:
        p = FW_CACHE / v
        if p.exists() and any(p.iterdir()):
            return True
    return False


def resolve_model_path(model_name):
    for base_cache in (HF_CACHE, LEGACY_HF_CACHE):
        for repo_id in get_repo_ids(model_name):
            safe_name = repo_id.replace("/", "--")
            snaps = base_cache / f"models--{safe_name}" / "snapshots"
            if snaps.is_dir():
                for snap in snaps.iterdir():
                    if snap.is_dir() and (snap / "model.bin").exists() and (snap / "config.json").exists():
                        return str(snap)
    for base in (CT2_CACHE, FW_CACHE):
        for v in [f"faster-whisper-{model_name}", model_name]:
            p = base / v
            if p.exists() and (p / "model.bin").exists():
                return str(p)
    return model_name


def check_all_models():
    result = {m: is_model_downloaded(m) for m in AVAILABLE_MODELS}
    result.update({m: is_nemo_downloaded(m) for m in NEMO_MODELS})
    return result


# ---- NeMo (Parakeet / Canary) via sherpa-onnx ---- #

def nemo_model_dir(model_name):
    return SHERPA_DIR / NEMO_MODELS[model_name]["dirname"]


def is_nemo_downloaded(model_name):
    d = nemo_model_dir(model_name)
    return (
        (d / "tokens.txt").is_file()
        and any(d.glob("encoder*.onnx"))
        and any(d.glob("decoder*.onnx"))
    )


def _canary_src_lang():
    lang = config.get("language")
    return lang if lang in ("en", "de", "fr", "es") else "en"


def _nemo_file(d, base):
    """Pick the int8 graph when precision allows it, else the fp32 one."""
    if _effective_compute() == "int8":
        p = d / f"{base}.int8.onnx"
        if p.is_file():
            return str(p)
    return str(d / f"{base}.onnx")


def _build_engine(model_name):
    """Instantiate whichever engine backs model_name."""
    entry = NEMO_MODELS.get(model_name)
    if entry is not None:
        import sherpa_onnx

        d = nemo_model_dir(model_name)
        provider = "cuda" if config["device"] == "cuda" else "cpu"
        encoder = _nemo_file(d, "encoder")
        decoder = _nemo_file(d, "decoder")
        tokens = str(d / "tokens.txt")

        if entry["kind"] == "canary":
            src = _canary_src_lang()
            return sherpa_onnx.OfflineRecognizer.from_nemo_canary(
                encoder=encoder,
                decoder=decoder,
                tokens=tokens,
                src_lang=src,
                tgt_lang=src,
                num_threads=1,
                provider=provider,
            )
        return sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=encoder,
            decoder=decoder,
            joiner=_nemo_file(d, "joiner"),
            tokens=tokens,
            num_threads=1,
            feature_dim=128,
            provider=provider,
        )
    return WhisperModel(
        resolve_model_path(model_name),
        device=config["device"],
        compute_type=_effective_compute(),
    )


def _assign_engine(model_name, engine):
    global model, nemo
    if model_name in NEMO_MODELS:
        nemo = engine
        model = None
    else:
        model = engine
        nemo = None


def download_nemo_thread(model_name):
    entry = NEMO_MODELS[model_name]
    SHERPA_DIR.mkdir(parents=True, exist_ok=True)
    archive_path = SHERPA_DIR / (entry["dirname"] + ".tar.bz2")

    def progress(pct):
        send_json({
            "type": "download_status",
            "model": model_name,
            "status": "downloading",
            "progress": max(0, min(100, int(pct))),
        })

    progress(0)
    try:
        req = urllib.request.Request(
            entry["url"], headers={"User-Agent": "fly-dictation/1.0"}
        )
        with urllib.request.urlopen(req) as resp, open(archive_path, "wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            last = 0.0
            while True:
                chunk = resp.read(512 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                now = time.time()
                if total and now - last >= 0.5:
                    last = now
                    progress(done / total * 100)

        progress(99)
        send_json({"type": "status", "text": f"Extracting {model_name}..."})
        with tarfile.open(archive_path, "r:bz2") as tf:
            tf.extractall(SHERPA_DIR)
        archive_path.unlink(missing_ok=True)

        if not is_nemo_downloaded(model_name):
            raise RuntimeError("Archive extracted but expected ONNX files are missing")

        progress(100)
        send_json({"type": "download_status", "model": model_name, "status": "done", "progress": 100})
    except Exception as e:
        try:
            archive_path.unlink(missing_ok=True)
        except Exception:
            pass
        send_json({"type": "download_status", "model": model_name, "status": "error", "progress": -1, "text": str(e)})
    send_json({"type": "downloaded_models", "models": check_all_models()})


# ---- Audio Recording (collect only, no live transcription) ---- #

def audio_callback(indata, frames, time_info, status):
    if status:
        print(status, file=sys.stderr)
    audio_q.put(indata.copy())


def audio_collector():
    """Background thread that drains audio_q into audio_chunks until sentinel."""
    while True:
        try:
            chunk = audio_q.get(timeout=0.5)
        except queue.Empty:
            if not is_recording:
                break
            continue
        if chunk is None:
            break
        audio_chunks.append(chunk)

        # Stream rough loudness to the overlay bubble (throttled)
        now = time.time()
        if now - _lvl_state["t"] > 0.1:
            _lvl_state["t"] = now
            try:
                rms = float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2)))
                level = max(0.0, min(1.0, rms / 2500.0))
                send_json({"type": "mic_level", "value": round(level, 3)})
            except Exception:
                pass


def start_recording():
    global is_recording, stream, audio_chunks, collector_thread
    if is_recording:
        return
    if is_processing:
        send_json({"type": "warning", "text": "Still transcribing - one moment."})
        return
    if is_model_loading or (model is None and nemo is None):
        send_json({"type": "error", "text": "Model is still loading. Please wait..."})
        return

    audio_chunks = []

    # Drain queue
    while not audio_q.empty():
        try:
            audio_q.get_nowait()
        except queue.Empty:
            break

    try:
        is_recording = True
        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            callback=audio_callback,
        )
        stream.start()
        collector_thread = threading.Thread(target=audio_collector, daemon=True)
        collector_thread.start()
        send_json({"type": "status", "text": "Recording...", "recording": True})
    except Exception as e:
        is_recording = False
        send_json({"type": "error", "text": f"Microphone error: {e}"})
        send_json({"type": "status", "text": "Ready", "recording": False})


def stop_and_transcribe():
    global is_recording, is_processing, stream, collector_thread
    if not is_recording:
        return
    is_recording = False
    is_processing = True
    send_json({"type": "status", "text": "Transcribing...", "recording": False})
    try:
        _transcribe_session()
    finally:
        is_processing = False


def _transcribe_session():
    global stream, collector_thread

    # Let mic hardware flush remaining frames
    time.sleep(0.15)

    if stream is not None:
        try:
            stream.stop()
            stream.close()
        except Exception:
            pass
        stream = None

    # Signal collector to stop and wait for it
    audio_q.put(None)
    if collector_thread is not None and collector_thread.is_alive():
        collector_thread.join(timeout=10.0)

    if not audio_chunks:
        send_json({"type": "status", "text": "Ready", "recording": False})
        return

    all_audio = np.concatenate(audio_chunks, axis=0).flatten()

    # Save wav
    try:
        with wave.open("recording.wav", "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(all_audio.astype(np.int16).tobytes())
    except Exception as e:
        print(f"Error saving wav: {e}", file=sys.stderr)

    # Transcribe the full recording in one pass
    final_text = ""
    audio_data = all_audio.astype(np.float32) / 32768.0
    if nemo is not None:
        try:
            stream = nemo.create_stream()
            stream.accept_waveform(SAMPLE_RATE, audio_data)
            nemo.decode_stream(stream)
            final_text = stream.result.text.strip()
        except Exception as e:
            print(f"Transcription error: {e}", file=sys.stderr)
    elif model is not None:
        try:
            lang = "en" if config.get("language") == "en" else None
            segments, _ = model.transcribe(
                audio_data,
                beam_size=1,
                temperature=0.0,
                vad_filter=True,
                vad_parameters=VAD_PARAMETERS,
                language=lang,
                condition_on_previous_text=False,
            )
            segments = list(segments)
            for segment in segments:
                print(
                    "[transcription] "
                    f"segment={getattr(segment, 'id', '?')} "
                    f"start={getattr(segment, 'start', 0.0):.2f} "
                    f"end={getattr(segment, 'end', 0.0):.2f} "
                    f"temperature={getattr(segment, 'temperature', '?')} "
                    f"no_speech_prob={getattr(segment, 'no_speech_prob', '?')} "
                    f"avg_logprob={getattr(segment, 'avg_logprob', '?')} "
                    f"compression_ratio={getattr(segment, 'compression_ratio', '?')} "
                    f"text={segment.text!r}",
                    file=sys.stderr,
                    flush=True,
                )
            final_text = " ".join(seg.text for seg in segments).strip()
        except Exception as e:
            print(f"Transcription error: {e}", file=sys.stderr)

    # Send transcript to UI and paste
    if final_text:
        send_json({"type": "transcript", "text": final_text})

        # Preserve clipboard: remember native formats, including images, and
        # restore them after the transcript has been pasted.
        saved_clipboard = None
        if config.get("preserve_clipboard"):
            saved_clipboard = capture_clipboard()
            if saved_clipboard is None:
                print("Clipboard preservation could not capture the current clipboard", file=sys.stderr)

        try:
            pyperclip.copy(final_text)
            # Release any stuck modifier keys from the hotkey
            try:
                pyautogui.keyUp("ctrl")
                pyautogui.keyUp("alt")
                pyautogui.keyUp("shift")
            except Exception:
                pass
            time.sleep(0.08)
            pyautogui.hotkey("ctrl", "v")
            # Give the target app a beat to read the clipboard, then restore it
            time.sleep(0.2)
        except Exception as e:
            print(f"Clipboard paste error: {e}", file=sys.stderr)
        finally:
            if saved_clipboard is not None and not restore_clipboard(saved_clipboard):
                print("Clipboard preservation could not restore the original clipboard", file=sys.stderr)
    else:
        send_json({"type": "transcript", "text": ""})

    send_json({"type": "status", "text": "Ready", "recording": False})


def toggle():
    if is_recording:
        threading.Thread(target=stop_and_transcribe, daemon=True).start()
    else:
        start_recording()


# ---- Model Management ---- #

def _echo_ready():
    """Tell the UI the current model is usable (only when truly not loading)."""
    if not is_model_loading and (model is not None or nemo is not None):
        send_json({"type": "model_loaded", "model": config["model"]})


def change_model_thread(new_size):
    global is_model_loading
    if not model_op_lock.acquire(blocking=False):
        send_json({"type": "warning", "text": "Still switching models - one moment."})
        _echo_ready()
        send_json({"type": "config_updated", "config": {**config}})
        return
    is_model_loading = True
    prev = dict(config)
    if config["device"] == "cuda":
        _sanitize_compute()
    send_json({"type": "model_loading", "model": new_size})
    try:
        # Pre-flight checks BEFORE tearing down the working engine
        if new_size in NEMO_MODELS:
            if not is_nemo_downloaded(new_size):
                raise RuntimeError(f"{new_size} is not downloaded yet - open the Downloads tab.")
            import sherpa_onnx  # noqa: F401
        send_json({"type": "status", "text": "Unloading old model..."})
        _unload_engine()
        send_json({"type": "status", "text": f"Loading {new_size}..."})
        _assign_engine(new_size, _build_engine(new_size))
        config["model"] = new_size
        save_config()
        send_json({"type": "config_updated", "config": {**config}})
        send_json({"type": "model_loaded", "model": new_size})
        send_json({"type": "status", "text": "Ready"})
    except ImportError:
        send_json({"type": "error", "text": "Parakeet/Canary need sherpa-onnx - run: pip install sherpa-onnx"})
        _restore_previous(prev)
    except Exception as e:
        send_json({"type": "error", "text": f"Failed to load {new_size}: {e}"})
        _restore_previous(prev)
    finally:
        is_model_loading = False
        model_op_lock.release()
    send_json({"type": "downloaded_models", "models": check_all_models()})


def download_model_thread(model_name):
    repo_id = f"Systran/faster-whisper-{model_name}"
    safe_name = repo_id.replace("/", "--")
    marker = HF_CACHE / f"models--{safe_name}" / ".download_complete"
    marker.unlink(missing_ok=True)

    send_json({"type": "download_status", "model": model_name, "status": "downloading", "progress": 0})

    try:
        api = HfApi()
        info = api.repo_info(repo_id, files_metadata=True)
        files = [(s.rfilename, s.size or 0) for s in info.siblings]
        total_size = sum(s for _, s in files) or 1

        downloaded = 0
        for filename, fsize in files:
            hf_hub_download(repo_id=repo_id, filename=filename, local_files_only=False)
            downloaded += fsize
            pct = int(downloaded / total_size * 100)
            send_json({"type": "download_status", "model": model_name, "status": "downloading", "progress": pct})

        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        send_json({"type": "download_status", "model": model_name, "status": "done", "progress": 100})
    except Exception as e:
        marker.unlink(missing_ok=True)
        send_json({"type": "download_status", "model": model_name, "status": "error", "progress": -1, "text": str(e)})
    send_json({"type": "downloaded_models", "models": check_all_models()})


def set_device_thread(new_device):
    global model, config, is_model_loading
    if not model_op_lock.acquire(blocking=False):
        send_json({"type": "warning", "text": "Still switching models - one moment."})
        _echo_ready()
        send_json({"type": "config_updated", "config": {**config}})
        return
    is_model_loading = True
    prev = dict(config)
    config["device"] = new_device
    # Precision that worked on the old device may be impossible here
    if new_device == "cuda":
        _sanitize_compute()
    save_config()
    send_json({"type": "model_loading", "model": config["model"]})
    try:
        send_json({"type": "status", "text": "Unloading old model..."})
        _unload_engine()
        send_json({"type": "status", "text": f"Switching to {new_device}..."})
        _assign_engine(config["model"], _build_engine(config["model"]))
        send_json({"type": "config_updated", "config": {**config}})
        send_json({"type": "model_loaded", "model": config["model"]})
        send_json({"type": "status", "text": "Ready"})
    except Exception as e:
        send_json({"type": "error", "text": f"Failed to switch device: {e}"})
        _restore_previous(prev)
    finally:
        is_model_loading = False
        model_op_lock.release()


def set_compute_thread(new_compute):
    global model, config, is_model_loading
    if not model_op_lock.acquire(blocking=False):
        send_json({"type": "warning", "text": "Still switching models - one moment."})
        _echo_ready()
        send_json({"type": "config_updated", "config": {**config}})
        return
    is_model_loading = True
    prev = dict(config)
    if new_compute != "int8" and config["device"] == "cuda" and not _cuda_supports(new_compute):
        config["compute"] = "int8"
        save_config()
        is_model_loading = False
        model_op_lock.release()
        send_json({"type": "warning", "text": f"GPU does not support {new_compute} - staying on int8."})
        _echo_ready()
        send_json({"type": "config_updated", "config": {**config}})
        return
    config["compute"] = new_compute
    save_config()
    send_json({"type": "model_loading", "model": config["model"]})
    try:
        send_json({"type": "status", "text": "Unloading old model..."})
        _unload_engine()
        send_json({"type": "status", "text": f"Switching to {new_compute}..."})
        _assign_engine(config["model"], _build_engine(config["model"]))
        send_json({"type": "config_updated", "config": {**config}})
        send_json({"type": "model_loaded", "model": config["model"]})
        send_json({"type": "status", "text": "Ready"})
    except Exception as e:
        import traceback
        traceback.print_exc()
        if "float16" in str(e).lower():
            send_json({"type": "warning", "text": "GPU lacks efficient FP16 (Volta/RTX or newer required) - staying on int8."})
        else:
            send_json({"type": "error", "text": f"Failed to switch compute type: {e}"})
        _restore_previous(prev)
    finally:
        is_model_loading = False
        model_op_lock.release()


# ---- Command Dispatch ---- #

def _model_present(model_name):
    if model_name in NEMO_MODELS:
        return is_nemo_downloaded(model_name)
    return is_model_downloaded(model_name)


def onboarding_apply_thread(model_name):
    """First-run setup: fetch the chosen model if needed, then load it."""
    try:
        if not _model_present(model_name):
            send_json({"type": "onboarding_stage", "stage": "download", "model": model_name})
            if model_name in NEMO_MODELS:
                download_nemo_thread(model_name)
            else:
                download_model_thread(model_name)
            if not _model_present(model_name):
                send_json({"type": "error", "text": "Setup download failed - retry from the Downloads tab."})
                return
        send_json({"type": "onboarding_stage", "stage": "load", "model": model_name})
        change_model_thread(model_name)
    except Exception as e:
        send_json({"type": "error", "text": f"Setup failed: {e}"})


ONBOARDING_KEYS = {
    "model": str,
    "language": str,
    "theme": str,
    "device": str,
    "hotkey": str,
    "preserve_clipboard": bool,
    "overlay_enabled": bool,
    "start_minimized": bool,
    "gradient_outline": bool,
}


def process_command(cmd):
    global config
    action = cmd.get("action")

    if action == "toggle":
        toggle()
    elif action == "start":
        start_recording()
    elif action == "stop":
        threading.Thread(target=stop_and_transcribe, daemon=True).start()
    elif action in ("get_state", "ping", "init"):
        send_json({"type": "ready", "config": {**config}})
        send_json({"type": "downloaded_models", "models": check_all_models()})
        if not is_model_loading and (model is not None or nemo is not None):
            send_json({"type": "model_loaded", "model": config["model"]})
        elif is_model_loading:
            send_json({"type": "model_loading", "model": config["model"]})
    elif action == "set_language":
        config["language"] = cmd.get("language", "en")
        save_config()
        send_json({"type": "config_updated", "config": {**config}})
    elif action == "change_model":
        new_size = cmd.get("model")
        if new_size:
            if new_size in NEMO_MODELS:
                send_json({"type": "warning", "text": f"{new_size} is coming soon while NVIDIA model support is being tested."})
                return
            threading.Thread(target=change_model_thread, args=(new_size,), daemon=True).start()
    elif action == "set_hotkey":
        config["hotkey"] = cmd.get("hotkey", "Ctrl+Alt+R")
        save_config()
        send_json({"type": "config_updated", "config": {**config}})
    elif action == "set_device":
        new_device = cmd.get("device", "cuda")
        if new_device != config["device"]:
            threading.Thread(target=set_device_thread, args=(new_device,), daemon=True).start()
        else:
            _echo_ready()
            send_json({"type": "config_updated", "config": {**config}})
    elif action == "set_compute":
        new_compute = cmd.get("compute", "int8")
        if new_compute in ("int8", "float16") and new_compute != config["compute"]:
            threading.Thread(target=set_compute_thread, args=(new_compute,), daemon=True).start()
        else:
            _echo_ready()
            send_json({"type": "config_updated", "config": {**config}})
    elif action == "set_theme":
        new_theme = cmd.get("theme", "system")
        if new_theme in VALID_THEMES:
            config["theme"] = new_theme
            save_config()
        send_json({"type": "config_updated", "config": {**config}})
    elif action == "set_preserve_clipboard":
        config["preserve_clipboard"] = bool(cmd.get("enabled", False))
        save_config()
        send_json({"type": "config_updated", "config": {**config}})
    elif action == "set_overlay":
        config["overlay_enabled"] = bool(cmd.get("enabled", False))
        save_config()
        send_json({"type": "config_updated", "config": {**config}})
    elif action == "set_start_minimized":
        config["start_minimized"] = bool(cmd.get("enabled", False))
        save_config()
        send_json({"type": "config_updated", "config": {**config}})
    elif action == "set_gradient_outline":
        config["gradient_outline"] = bool(cmd.get("enabled", False))
        save_config()
        send_json({"type": "config_updated", "config": {**config}})
    elif action == "complete_onboarding":
        payload = cmd.get("config") or {}
        for key, kind in ONBOARDING_KEYS.items():
            if key in payload and isinstance(payload[key], kind):
                config[key] = payload[key]
        model_choice = config["model"]
        if model_choice not in NEMO_MODELS and model_choice not in AVAILABLE_MODELS:
            send_json({"type": "error", "text": f"Unknown model: {model_choice}"})
            return
        config["onboarded"] = True
        save_config()
        send_json({"type": "config_updated", "config": {**config}})
        threading.Thread(target=onboarding_apply_thread, args=(model_choice,), daemon=True).start()
    elif action == "check_downloaded":
        send_json({"type": "downloaded_models", "models": check_all_models()})
    elif action == "download_model":
        model_name = cmd.get("model")
        if model_name:
            if model_name in NEMO_MODELS:
                send_json({"type": "warning", "text": f"{model_name} is coming soon while NVIDIA model support is being tested."})
            else:
                threading.Thread(target=download_model_thread, args=(model_name,), daemon=True).start()
    elif action == "debug_downloads":
        info = {}
        for m in AVAILABLE_MODELS:
            repo_id = f"Systran/faster-whisper-{m}"
            safe = repo_id.replace("/", "--")
            info[m] = {
                "hf": str(HF_CACHE / f"models--{safe}"),
                "ct2": str(CT2_CACHE / f"faster-whisper-{m}"),
                "fw": str(FW_CACHE / f"faster-whisper-{m}"),
                "fw_noprefix": str(FW_CACHE / m),
                "detected": is_model_downloaded(m),
            }
        send_json({"type": "debug_downloads", "info": info})


if __name__ == "__main__":
    try:
        sys.stdin.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    load_config()

    # Validate saved precision against the actual GPU (e.g. Pascal has no efficient FP16)
    _sanitize_compute()

    send_json({"type": "startup", "text": "Initializing...", "config": {**config}})
    send_json({"type": "ready", "config": {**config}, "first_run": first_run})
    send_json({"type": "downloaded_models", "models": check_all_models()})

    if first_run or not config.get("onboarded"):
        # Fresh install - wait for the wizard's complete_onboarding
        send_json({"type": "status", "text": "Waiting for setup..."})
    else:
        # Load model asynchronously so stdin is never blocked
        threading.Thread(target=change_model_thread, args=(config["model"],), daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            process_command(cmd)
        except json.JSONDecodeError as e:
            send_json({"type": "error", "text": str(e)})
