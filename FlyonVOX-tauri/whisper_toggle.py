import threading
import queue
import wave
import time
import numpy as np
import sounddevice as sd
import customtkinter as ctk
import keyboard
import pyautogui
import pyperclip
from faster_whisper import WhisperModel

# Configuration
AVAILABLE_MODELS = [
    "tiny", "tiny.en", "base", "base.en", "small", "small.en",
    "medium", "medium.en", "large-v2", "large-v3", "large-v3-turbo",
    "distil-small.en", "distil-medium.en"
]
SAMPLE_RATE = 16000
CHANNELS = 1

# Natural prompt for development context without hallucination
INITIAL_PROMPT = "Transcribing software development, code, and technical discussion."

current_model_size = "tiny.en"
model = WhisperModel(current_model_size, device="cuda", compute_type="int8")

is_recording = False
stream = None
worker_thread = None
audio_chunks: list[np.ndarray] = []
audio_q: "queue.Queue[np.ndarray | None]" = queue.Queue()


def audio_callback(indata, frames, time, status):
    if status:
        print(status)
    audio_q.put(indata.copy())


def audio_collector():
    """Background thread that drains audio_q into audio_chunks until sentinel."""
    while True:
        try:
            chunk = audio_q.get(timeout=0.2)
        except queue.Empty:
            if not is_recording:
                break
            continue
        if chunk is None:
            break
        audio_chunks.append(chunk)


def start_recording():
    global is_recording, stream, audio_chunks, worker_thread
    if is_recording:
        return
    audio_chunks.clear()

    while not audio_q.empty():
        try:
            audio_q.get_nowait()
        except queue.Empty:
            break

    is_recording = True
    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="int16",
        callback=audio_callback,
    )
    stream.start()
    worker_thread = threading.Thread(target=audio_collector, daemon=True)
    worker_thread.start()
    status_var.set("Recording...")


def stop_and_transcribe():
    global is_recording, stream, audio_chunks, worker_thread
    if not is_recording:
        return
    is_recording = False
    status_var.set("Finishing...")

    time.sleep(0.15)
    if stream:
        try:
            stream.stop()
            stream.close()
        except Exception:
            pass
        stream = None

    audio_q.put(None)
    if worker_thread is not None and worker_thread.is_alive():
        worker_thread.join(timeout=10.0)

    if not audio_chunks:
        status_var.set("Idle")
        return

    all_audio = np.concatenate(audio_chunks, axis=0).flatten()

    # Save to file
    try:
        with wave.open("recording.wav", "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(all_audio.astype(np.int16).tobytes())
    except Exception as e:
        print(e)

    # Full audio transcription pass
    final_text = ""
    if model:
        try:
            audio_data = all_audio.astype(np.float32) / 32768.0
            segments, _ = model.transcribe(
                audio_data,
                beam_size=1,
                vad_filter=False,
                initial_prompt=INITIAL_PROMPT
            )
            final_text = " ".join(seg.text for seg in segments).strip()
        except Exception as e:
            print(e)

    if final_text:
        output.delete("1.0", ctk.END)
        output.insert(ctk.END, final_text)
        try:
            pyperclip.copy(final_text)
            try:
                pyautogui.keyUp("ctrl")
                pyautogui.keyUp("alt")
                pyautogui.keyUp("shift")
            except Exception:
                pass
            time.sleep(0.08)
            pyautogui.hotkey('ctrl', 'v')
        except Exception as e:
            print(e)

    status_var.set("Idle")


def toggle():
    if is_recording:
        toggle_btn.configure(text="Start Recording")
        threading.Thread(target=stop_and_transcribe, daemon=True).start()
    else:
        toggle_btn.configure(text="Stop Recording")
        start_recording()


def change_model(new_size):
    global model, current_model_size
    status_var.set(f"Loading {new_size}...")
    root.update_idletasks()

    def load():
        global model, current_model_size
        current_model_size = new_size
        model = WhisperModel(new_size, device="cuda", compute_type="int8")
        status_var.set("Idle")

    threading.Thread(target=load, daemon=True).start()


# UI Setup
root = ctk.CTk()
root.title("Faster-Whisper Recorder")
root.geometry("500x600")

status_var = ctk.StringVar(value="Idle")

main_frame = ctk.CTkFrame(root)
main_frame.pack(padx=20, pady=20, fill=ctk.BOTH, expand=True)

ctk.CTkLabel(main_frame, text="Select Model:").pack(pady=(20, 0))
model_menu = ctk.CTkOptionMenu(main_frame, values=AVAILABLE_MODELS, command=change_model)
model_menu.set(current_model_size)
model_menu.pack(pady=10)

toggle_btn = ctk.CTkButton(main_frame, text="Start Recording", width=200, command=toggle)
toggle_btn.pack(pady=20)

status_label = ctk.CTkLabel(main_frame, textvariable=status_var)
status_label.pack()

output = ctk.CTkTextbox(main_frame, width=400, height=250, wrap="word")
output.pack(padx=20, pady=20, fill=ctk.BOTH, expand=True)

# Hotkey setup
keyboard.add_hotkey('ctrl+alt+r', toggle)

root.mainloop()
