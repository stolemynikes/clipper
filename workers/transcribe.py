"""Transcribe a media file with word timestamps.

Usage: python transcribe.py '{"input": "clip.mp4", "model": "large-v3", "language": null}'
Prints JSON: {"language": "nl", "words": [{"w": "hoi", "s": 0.12, "e": 0.4}, ...]}
"""
import json
import os
import subprocess
import sys

import numpy as np

# CUDA runtime DLLs come from the nvidia-* pip wheels; ctranslate2 needs them on the DLL path (Windows).
_nv = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
for _lib in ("cublas", "cudnn"):
    _bin = os.path.join(_nv, _lib, "bin")
    if os.path.isdir(_bin):
        os.add_dll_directory(_bin)
        os.environ["PATH"] = _bin + os.pathsep + os.environ.get("PATH", "")

from faster_whisper import WhisperModel


def load_audio(path: str) -> np.ndarray:
    """16 kHz mono float32 via ffmpeg (faster-whisper's PyAV decoder breaks on av>=19)."""
    pcm = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(pcm, np.float32)


def transcribe(audio: np.ndarray, model_name: str, language, device: str, compute: str) -> dict:
    model = WhisperModel(model_name, device=device, compute_type=compute)
    segments, info = model.transcribe(audio, language=language, word_timestamps=True, vad_filter=True)
    words = [  # segments is lazy: CUDA errors surface here, inside the caller's try
        {"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)}
        for seg in segments
        for w in (seg.words or [])
        if w.word.strip()
    ]
    return {"language": info.language, "words": words}


def main() -> None:
    args = json.loads(sys.argv[1])
    audio = load_audio(args["input"])
    name, lang = args.get("model", "large-v3"), args.get("language")
    try:
        result = transcribe(audio, name, lang, "cuda", "float16")
    except Exception as e:  # no usable CUDA libs (cublas/cudnn): slower, but still works
        print(f"cuda failed ({e}), using cpu", file=sys.stderr)
        result = transcribe(audio, name, lang, "cpu", "int8")
    peak = float(np.abs(audio).max()) if audio.size else 0.0
    result["peakDb"] = round(20 * np.log10(peak), 1) if peak > 0 else -120.0  # silent clip (mic off) check
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
