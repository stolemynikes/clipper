"""Split a clip's sound into voice and the rest (sherpa-onnx spleeter 2-stems), so music can be turned down under speech.

stdin/argv JSON: {"input": "<audio or video>", "vocals": "<out.wav>", "music": "<out.wav>"}
stdout JSON: {"sec": <duration>}. Both outputs are 44.1kHz stereo 16-bit WAV, same length as the input.
Model (not in git), from github.com/k2-fsa/sherpa-onnx/releases into assets/models/:
  source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2 (unpack)
"""
import json
import os
import subprocess
import sys
import wave

import numpy as np
import sherpa_onnx

MODEL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "models", "sherpa-onnx-spleeter-2stems-fp16")
RATE = 44100


def load(path: str) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "2", "-ar", str(RATE), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()  # (channels, samples)


def save(path: str, data: np.ndarray) -> None:
    pcm = (np.clip(data.T, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


def separate(src: str, vocals: str, music: str) -> float:
    spl = sherpa_onnx.OfflineSourceSeparationSpleeterModelConfig(
        vocals=os.path.join(MODEL, "vocals.fp16.onnx"), accompaniment=os.path.join(MODEL, "accompaniment.fp16.onnx"))
    sep = sherpa_onnx.OfflineSourceSeparation(sherpa_onnx.OfflineSourceSeparationConfig(
        model=sherpa_onnx.OfflineSourceSeparationModelConfig(spleeter=spl, num_threads=min(4, os.cpu_count() or 1))))
    audio = load(src)
    n = audio.shape[1]
    stems = sep.process(RATE, audio).stems  # [vocals, accompaniment], padded past n
    save(vocals, stems[0].data[:, :n])
    save(music, stems[1].data[:, :n])
    return n / RATE


if __name__ == "__main__":
    args = json.loads(sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read())
    print(json.dumps({"sec": round(separate(args["input"], args["vocals"], args["music"]), 2)}))
