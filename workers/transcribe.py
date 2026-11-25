"""Transcribe a media file with word timestamps.

Usage: python transcribe.py '{"input": "clip.mp4", "model": "large-v3", "language": null}'
Prints JSON: {"language": "nl", "words": [{"w": "hoi", "s": 0.12, "e": 0.4}, ...]}
Serve mode: python transcribe.py --serve reads one JSON request per stdin line and answers one JSON line each,
keeping models loaded (large-v3 takes ~100s to load from the HDD, transcribing a clip ~6s).
"""
import json
import os
import subprocess
import sys
import traceback

import numpy as np

# CUDA runtime DLLs come from the nvidia-* pip wheels; ctranslate2 needs them on the DLL path (Windows).
_nv = os.path.join(sys.prefix, "Lib", "site-packages", "nvidia")
for _lib in ("cublas", "cudnn"):
    _bin = os.path.join(_nv, _lib, "bin")
    if os.path.isdir(_bin):
        os.add_dll_directory(_bin)
        os.environ["PATH"] = _bin + os.pathsep + os.environ.get("PATH", "")

from faster_whisper import WhisperModel

_find_alignment = WhisperModel.find_alignment


def _safe_find_alignment(self, tokenizer, text_tokens, encoder_output, num_frames, median_filter_width=7):
    """faster-whisper 1.2.1 crashes (IndexError on time_indices[jumps]) when ctranslate2's align returns no
    alignment pairs for a segment; that happens at random on temperature-fallback text. Give that 30s window
    no word timings (seg_words then estimates them) instead of failing the whole clip (the library already returns [] for 0-1 word segments).
    We use the sequential model, so text_tokens is one window per call."""
    try:
        return _find_alignment(self, tokenizer, text_tokens, encoder_output, num_frames, median_filter_width)
    except IndexError:
        print("word alignment failed for one window; its words get estimated timings", file=sys.stderr)
        return [[] for _ in text_tokens]


WhisperModel.find_alignment = _safe_find_alignment


def load_audio(path: str) -> np.ndarray:
    """16 kHz mono float32 via ffmpeg (faster-whisper's PyAV decoder breaks on av>=19)."""
    pcm = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(pcm, np.float32)


_models: dict = {}


def transcribe(audio: np.ndarray, model_name: str, language, device: str, compute: str) -> dict:
    key = (model_name, device)
    if key not in _models:
        _models[key] = WhisperModel(model_name, device=device, compute_type=compute)
    segments, info = _models[key].transcribe(audio, language=language, word_timestamps=True, vad_filter=True)
    # segments is lazy: CUDA errors surface here, inside the caller's try
    return {"language": info.language, "words": join_words(w for seg in segments for w in seg_words(seg.words, seg.text, seg.start, seg.end))}


def seg_words(words, text, start, end):
    """Word timings of a segment. A segment whose alignment failed has text but no words:
    spread its words over the segment's own start-end by length, so its captions still show."""
    if words:
        return [(w.word, w.start, w.end) for w in words]
    parts = [" " + t for t in text.split()]
    total = sum(len(p) for p in parts)
    out, t = [], start
    for p in parts:
        d = (end - start) * len(p) / total
        out.append((p, t, t + d))
        t += d
    return out


def join_words(raw):
    """Whisper words start with a space; one without is a split-off piece ("AT" + "&T"), so glue it to the previous word."""
    words = []
    for text, start, end in raw:
        if not text.strip():
            continue
        if words and not text.startswith(" ") and text.strip()[0] in "&'-.%":
            words[-1]["w"] += text.strip()
            words[-1]["e"] = round(end, 3)
        else:
            words.append({"w": text.strip(), "s": round(start, 3), "e": round(end, 3)})
    return words


def handle(args: dict) -> dict:
    audio = load_audio(args["input"])
    name, lang = args.get("model", "large-v3"), args.get("language")
    if not audio.size:  # no decoded samples: VAD crashes on empty input; peakDb -120 makes the editor skip it as silent
        return {"language": lang, "words": [], "peakDb": -120.0}
    try:
        result = transcribe(audio, name, lang, "cuda", "float16")
    except Exception as e:  # no usable CUDA libs (cublas/cudnn): slower, but still works
        print(f"cuda failed ({e}), using cpu", file=sys.stderr)
        result = transcribe(audio, name, lang, "cpu", "int8")
    peak = float(np.abs(audio).max()) if audio.size else 0.0
    result["peakDb"] = round(20 * np.log10(peak), 1) if peak > 0 else -120.0  # silent clip (mic off) check
    return result


def main() -> None:
    if sys.argv[1] != "--serve":
        json.dump(handle(json.loads(sys.argv[1])), sys.stdout)  # ASCII-escaped: safe under any console codepage
        return
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            out = handle(json.loads(line))
        except Exception as e:  # one bad clip must not kill the server
            where = " < ".join(f"{os.path.basename(f.filename)}:{f.lineno}" for f in reversed(traceback.extract_tb(e.__traceback__)[-3:]))
            out = {"error": f"{type(e).__name__}: {e} (at {where})"}
        print(json.dumps(out), flush=True)


def _selftest():
    w = seg_words(None, " hoi daar", 1.0, 2.0)
    assert [x[0] for x in w] == [" hoi", " daar"] and w[0][1] == 1.0 and abs(w[-1][2] - 2.0) < 1e-9, w
    assert seg_words(None, "  ", 0, 1) == []


if __name__ == "__main__":
    main()
