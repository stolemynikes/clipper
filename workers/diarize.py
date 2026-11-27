"""Who speaks when (sherpa-onnx: pyannote segmentation 3.0 + 3D-Speaker embedding, no Hugging Face token).

stdin/argv JSON: {"input": "<audio or video>", "start": 0, "end": null, "speakers": null}
stdout JSON: {"segments": [{"start": s, "end": s, "speaker": n}, ...]} with times relative to `start`.
Models (not in git), from github.com/k2-fsa/sherpa-onnx/releases into assets/models/:
  speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 (unpack)
  speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
"""
import json
import os
import subprocess
import sys

import numpy as np
import sherpa_onnx

MODELS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "models")
SEG = os.path.join(MODELS, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
EMB = os.path.join(MODELS, "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx")
THRESHOLD = 0.5  # cluster distance: lower splits one voice into more speakers


def load_audio(path: str, start: float, end: float | None, rate: int) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error", "-ss", str(start), "-i", path]
    if end is not None:
        cmd += ["-t", str(end - start)]
    cmd += ["-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"]
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, dtype=np.float32)


def diarize(path: str, start: float = 0, end: float | None = None, speakers: int | None = None) -> list[dict]:
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=SEG)),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=EMB),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=speakers or -1, threshold=THRESHOLD),
        min_duration_on=0.3, min_duration_off=0.5)
    if not config.validate():
        raise RuntimeError("bad diarization config (models missing?)")
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)
    audio = load_audio(path, start, end, sd.sample_rate)
    return [{"start": round(s.start, 2), "end": round(s.end, 2), "speaker": s.speaker} for s in sd.process(audio).sort_by_start_time()]


if __name__ == "__main__":
    args = json.loads(sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read())
    json.dump({"segments": diarize(args["input"], args.get("start") or 0, args.get("end"), args.get("speakers"))}, sys.stdout)
