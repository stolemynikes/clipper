"""Detect background music in a media file (YAMNet via MediaPipe, ~1s frames).

Usage: python music_detect.py '{"input": "clip.mp4"}'
Prints JSON: {"musicRatio": 0.4, "vocalRatio": 0.1, "musicSec": [[0.0, 12.7], ...]}
musicRatio = share of frames where music is a top class; vocalRatio = share with singing/rap (likely a licensed song).
"""
import json
import os
import subprocess
import sys

import numpy as np
from mediapipe.tasks.python import audio as mp_audio
from mediapipe.tasks.python.components.containers import audio_data
from mediapipe.tasks.python.core.base_options import BaseOptions

MODEL = os.path.join(os.path.dirname(__file__), "..", "assets", "models", "yamnet.tflite")
RATE = 16000
MUSIC_MIN = 0.2  # YAMNet "Music" score per frame
# Human reactions, for the "is it fun" signals (laughRatio, cheerRatio = share of frames with one of these).
HUMAN_MIN = 0.1
LAUGH = {"Laughter", "Giggle", "Snicker", "Belly laugh", "Chuckle, chortle", "Baby laughter"}
CHEER = {"Cheering", "Screaming", "Shout", "Yell", "Children shouting", "Applause"}
VOCAL = {"Singing", "Rapping", "Song", "Choir", "Chant", "Pop music", "Hip hop music", "Vocal music"}


def load_audio(path: str) -> np.ndarray:
    pcm = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(RATE), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(pcm, np.float32)


def frames(audio: np.ndarray) -> list[tuple[float, dict]]:
    """[(start_sec, {class: score})] per YAMNet frame."""
    opts = mp_audio.AudioClassifierOptions(base_options=BaseOptions(model_asset_path=MODEL), max_results=-1)  # all 521: laughter drops out of a top 10 under speech + game audio
    with mp_audio.AudioClassifier.create_from_options(opts) as clf:
        results = clf.classify(audio_data.AudioData.create_from_array(audio.astype(float), RATE))
    return [(r.timestamp_ms / 1000, {c.category_name: c.score for c in r.classifications[0].categories}) for r in results]


def summarize(fr: list[tuple[float, dict]], step: float = 0.975) -> dict:
    music = [t for t, c in fr if c.get("Music", 0) >= MUSIC_MIN]
    vocal = [t for t, c in fr if c.get("Music", 0) >= MUSIC_MIN and any(c.get(v, 0) >= 0.1 for v in VOCAL)]
    spans: list[list[float]] = []
    for t in music:  # merge consecutive frames into spans
        if spans and t - spans[-1][1] <= step + 0.05:
            spans[-1][1] = round(t + step, 2)
        else:
            spans.append([round(t, 2), round(t + step, 2)])
    n = max(len(fr), 1)
    share = lambda names: round(sum(any(c.get(k, 0) >= HUMAN_MIN for k in names) for _, c in fr) / n, 3)
    peak = lambda names: round(max((max(c.get(k, 0) for k in names) for _, c in fr), default=0), 3)
    return {"musicRatio": round(len(music) / n, 3), "vocalRatio": round(len(vocal) / n, 3), "musicSec": spans,
            "laughRatio": share(LAUGH), "cheerRatio": share(CHEER),
            "laughMax": peak(LAUGH), "cheerMax": peak(CHEER), "sfx": sfx_spans(fr, step)}


SFX = {"laughs": LAUGH, "screams": {"Screaming", "Yell", "Shout"}}
SFX_MIN = 0.3  # same YAMNet peak cut as lessonRank (LAUGH_CUT)


def sfx_spans(fr: list[tuple[float, dict]], step: float = 0.975) -> list[list]:
    """[[start, end, "laughs"|"screams"]] where a reaction clearly sounds, consecutive frames merged."""
    out: list[list] = []
    for t, c in fr:
        best = max(SFX, key=lambda k: max(c.get(n, 0) for n in SFX[k]))
        if max(c.get(n, 0) for n in SFX[best]) < SFX_MIN:
            continue
        if out and out[-1][2] == best and t - out[-1][1] <= 0.05:
            out[-1][1] = round(t + step, 2)
        else:
            out.append([round(t, 2), round(t + step, 2), best])
    return out


def main() -> None:
    args = json.loads(sys.argv[1])
    audio = load_audio(args["input"])
    json.dump(summarize(frames(audio)) if audio.size else {"musicRatio": 0, "vocalRatio": 0, "musicSec": [], "laughRatio": 0, "cheerRatio": 0, "laughMax": 0, "cheerMax": 0, "sfx": []}, sys.stdout)


if __name__ == "__main__":
    main()
