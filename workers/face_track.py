"""Find the layout of a stream clip: scene type, facecam box, and where the action is.

Usage: python face_track.py '{"input": "src.mp4", "model": "assets/models/blaze_face_short_range.tflite", "hint": Rect | null}'
hint = the facecam box from streamers.yaml; used when the detected face sits inside it (edge snapping
can latch onto game UI, the hand-measured box cannot).
Input may also be an image (for testing). Prints JSON:
  {"scene": "cam" | "fullcam" | "nocam", "cam": Rect | null, "content": Rect}
Rect = {"x", "y", "w", "h"} as fractions of the source frame.
  cam     -> facecam overlay over gameplay/video: render cam on top, content (1080:1152) below.
  fullcam -> the camera is the whole scene (just chatting): content is a 9:16 crop around the face.
  nocam   -> no stable face: content is the 9:16 crop with the most motion.
"""
import json
import sys

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

SAMPLES = 16
FULLCAM_FACE_W = 0.13  # a face wider than this (of frame width) means the camera fills the scene
MIN_PRESENCE = 0.3  # a cam face must be seen in at least this share of sampled frames
W, H = 640, 360  # analysis size; fractions are resolution independent


def read_frames(path: str) -> list[tuple[np.ndarray, np.ndarray]]:
    """Pairs of frames ~0.2s apart at SAMPLES points; the pair difference is the motion."""
    img = cv2.imread(path) if path.lower().endswith((".jpg", ".png")) else None
    if img is not None:
        f = cv2.resize(img, (W, H))
        return [(f, f)]
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    gap = max(1, int((cap.get(cv2.CAP_PROP_FPS) or 30) * 0.2))
    pairs = []
    for i in range(SAMPLES):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int((i + 0.5) * total / SAMPLES))
        ok_a, a = cap.read()
        for _ in range(gap - 1):
            cap.grab()
        ok_b, b = cap.read()
        if ok_a and ok_b:
            pairs.append((cv2.resize(a, (W, H)), cv2.resize(b, (W, H))))
    cap.release()
    if not pairs:
        raise SystemExit(f"no frames read from {path}")
    return pairs


def detect_faces(frames: list[np.ndarray], model: str) -> list[tuple[int, tuple[float, float, float, float]]]:
    """(frame index, box) for every face. Runs on the frame and on overlapping tiles: the short-range
    model sees a 128px image, so a small facecam face is only found when zoomed in."""
    opts = vision.FaceDetectorOptions(base_options=BaseOptions(model_asset_path=model), min_detection_confidence=0.6)
    det = vision.FaceDetector.create_from_options(opts)
    # Quarter tiles catch a webcam inset in a full-screen browser scene (face ~5% of frame width).
    tiles = [(0, 0, 1, 1)] + [(x, y, 0.5, 0.5) for x in (0, 0.25, 0.5) for y in (0, 0.25, 0.5)]         + [(x / 8, y / 8, 0.25, 0.25) for x in range(7) for y in range(7)]
    found = []
    for i, f in enumerate(frames):
        rgb = cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
        for tx, ty, tw, th in tiles:
            x0, y0 = int(tx * W), int(ty * H)
            crop = np.ascontiguousarray(rgb[y0:y0 + int(th * H), x0:x0 + int(tw * W)])
            for d in det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop)).detections:
                b = d.bounding_box
                found.append((i, (tx + b.origin_x / W, ty + b.origin_y / H, b.width / W, b.height / H)))
    det.close()
    return found


def stable_face(found, n_frames: int):
    """Median box of the face that stays in one place over most frames (filters game characters)."""
    best = None
    for _, (x, y, w, h) in found:
        cx, cy = x + w / 2, y + h / 2
        near = [(i, b) for i, b in found if abs(b[0] + b[2] / 2 - cx) < 0.06 and abs(b[1] + b[3] / 2 - cy) < 0.08]
        frames_seen = len({i for i, _ in near})
        if best is None or frames_seen > best[0]:
            best = (frames_seen, near)
    if best is None or best[0] < max(1, MIN_PRESENCE * n_frames):
        return None
    return tuple(float(np.median([b[k] for _, b in best[1]])) for k in range(4))


def edge_profile(gray: np.ndarray, axis: int) -> np.ndarray:
    """Mean edge strength per column (axis=0) or per row (axis=1)."""
    g = cv2.Sobel(gray, cv2.CV_32F, 1, 0) if axis == 0 else cv2.Sobel(gray, cv2.CV_32F, 0, 1)
    return np.abs(g).mean(axis=axis)


def snap(lo: float, hi: float, prof: np.ndarray, size: int, default: float) -> float:
    """Strongest straight edge between lo and hi (fractions); the default when no clear border."""
    a, b = sorted((int(np.clip(lo, 0, 1) * size), int(np.clip(hi, 0, 1) * size)))
    if b - a < 3:
        return default
    seg = prof[a:b]
    k = int(seg.argmax())
    return (a + k) / size if seg[k] > 3 * (np.median(prof) + 1e-6) else default


def cam_rect(face, frames: list[np.ndarray]) -> dict:
    """Cam overlay = face box grown to a typical webcam crop, then snapped to the overlay border.
    The border is a static straight edge, so it survives in the median of the sampled frames."""
    fx, fy, fw, fh = face
    gray = cv2.cvtColor(np.median(np.stack(frames), axis=0).astype(np.uint8), cv2.COLOR_BGR2GRAY)
    band_rows = gray[int(max(0, fy - fh) * H):int(min(1, fy + 2 * fh) * H)]
    band_cols = gray[:, int(max(0, fx - fw) * W):int(min(1, fx + 2 * fw) * W)]
    cols, rows = edge_profile(band_rows, 0), edge_profile(band_cols, 1)
    left = snap(fx - 3 * fw, fx - 0.3 * fw, cols, W, fx - 1.6 * fw)
    right = snap(fx + 1.3 * fw, fx + 4 * fw, cols, W, fx + 2.6 * fw)
    top = snap(fy - 1.5 * fh, fy - 0.2 * fh, rows, H, fy - 0.9 * fh)
    bottom = snap(fy + 1.4 * fh, fy + 3.5 * fh, rows, H, fy + 1.9 * fh)
    # A border within 3% of the frame edge is the frame edge.
    left, top = (0.0 if v < 0.03 else v for v in (left, top))
    right, bottom = (1.0 if v > 0.97 else v for v in (right, bottom))
    return rect(left, top, right - left, bottom - top)


def rect(x, y, w, h) -> dict:
    x, y = max(0.0, x), max(0.0, y)
    return {"x": round(x, 4), "y": round(y, 4), "w": round(min(w, 1 - x), 4), "h": round(min(h, 1 - y), 4)}


def best_window(weight: np.ndarray, out_aspect: float) -> dict:
    """Full-height crop of the given output aspect (w/h) that holds the most weight."""
    cw = min(W, int(round(H * out_aspect)))
    col = np.concatenate([[0], np.cumsum(weight.sum(axis=0))])
    sums = col[cw:] - col[:-cw] if cw < W else np.array([col[-1]])
    x = int(sums.argmax()) if sums.max() > 0 else (W - cw) // 2
    return rect(x / W, 0, cw / W, 1)


def motion_map(pairs) -> np.ndarray:
    m = np.zeros((H, W), np.float32)
    for a, b in pairs:
        m += cv2.absdiff(cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)).astype(np.float32)
    return cv2.GaussianBlur(m, (0, 0), 5)


CAM_ASPECT = 1080 / 768  # top panel of the cam layout
STATIC_SHARE = 0.25  # measured: browser scene moves in ~3% of pixels, gameplay in ~100%
GAMEPLAY_SHARE = 0.6  # above this share of moving pixels the scene is gameplay
FACE_ZOOM = 4  # face fills ~1/4 of the panel width: close, still shows hands and reactions


def center_on_face(cam: dict, face, aspect: float) -> dict:
    """Window of the panel aspect inside the cam box, centered on the face (clamped to the box), at most
    FACE_ZOOM face-widths wide. A hint box wider than the real webcam would otherwise show HUD and a tiny face."""
    fx, fy, fw, fh = face
    cx, cy = fx + fw / 2, fy + fh / 2
    w_px = min(cam["w"] * W, cam["h"] * H * aspect, fw * W * FACE_ZOOM)
    w, h = w_px / W, w_px / aspect / H
    x = min(max(cx - w / 2, cam["x"]), cam["x"] + cam["w"] - w)
    y = min(max(cy - h / 2, cam["y"]), cam["y"] + cam["h"] - h)
    return rect(x, y, w, h)


def intersect(a: dict, b: dict) -> dict | None:
    x0, y0 = max(a["x"], b["x"]), max(a["y"], b["y"])
    x1, y1 = min(a["x"] + a["w"], b["x"] + b["w"]), min(a["y"] + a["h"], b["y"] + b["h"])
    return rect(x0, y0, x1 - x0, y1 - y0) if x1 > x0 and y1 > y0 else None


def inside(face, r: dict | None) -> bool:
    if not r:
        return False
    cx, cy = face[0] + face[2] / 2, face[1] + face[3] / 2
    return r["x"] <= cx <= r["x"] + r["w"] and r["y"] <= cy <= r["y"] + r["h"]


def analyze(path: str, model: str, hint: dict | None = None) -> dict:
    pairs = read_frames(path)
    frames = [a for a, _ in pairs]
    face = stable_face(detect_faces(frames, model), len(frames))
    motion = motion_map(pairs)

    if face is None:
        # Whole 16:9 screen on a blurred 9:16 background: any crop cut off browsers, tweets and menus.
        return {"scene": "nocam", "cam": None, "content": best_window(motion, 16 / 9)}

    fx, fy, fw, fh = face
    if fw >= FULLCAM_FACE_W:
        weight = np.zeros((H, W), np.float32)
        weight[:, int((fx + fw / 2) * W)] = 1  # center the crop on the face
        return {"scene": "fullcam", "cam": None, "content": best_window(weight, 9 / 16)}

    box = cam_rect(face, frames)
    if inside(face, hint):
        # Hint = the webcam border; the edge snap can tighten it (smaller cam in other scenes) but not widen it.
        both = intersect(hint, box)
        box = both if both and inside(face, both) else hint
    cam = center_on_face(box, face, CAM_ASPECT)
    x0, y0 = int(box["x"] * W), int(box["y"] * H)
    motion[y0:y0 + int(box["h"] * H) + 4, x0:x0 + int(box["w"] * W) + 4] = 0  # the cam is shown on top already
    share = (motion > motion.max() * 0.1).mean()
    if share > GAMEPLAY_SHARE:
        # Gameplay moves everywhere, so the motion peak is noise; character and crosshair sit in the center.
        cw = H * 1080 / 1152 / W
        x = 0.5 - cw / 2
        # Slide off a cam overlay that pokes into the crop edge, else a sliver of it shows.
        if box["x"] + box["w"] < 0.5:
            x = max(x, box["x"] + box["w"])
        elif box["x"] > 0.5:
            x = min(x, box["x"] - cw)
        return {"scene": "cam", "cam": cam, "content": rect(x, 0, cw, 1)}
    if share < STATIC_SHARE:
        # Browser/tweet/menu scene: a crop cuts the page, so show the whole screen below the cam,
        # minus the cam column when the strip beside it is wide (no duplicate cam, bigger text).
        # The detected cam, not the hint: the hint is measured on the gameplay scene and is often wider.
        left, right = cam["x"], 1 - cam["x"] - cam["w"]
        content = rect(0, 0, 1, 1) if max(left, right) < 0.5 else (
            rect(cam["x"] + cam["w"], 0, right, 1) if right >= left else rect(0, 0, left, 1))
        return {"scene": "cam", "cam": cam, "content": content, "fit": "full"}
    # Bottom panel is 1080x1152; the source crop has that aspect at full height.
    return {"scene": "cam", "cam": cam, "content": best_window(motion, 1080 / 1152)}


if __name__ == "__main__":
    args = json.loads(sys.argv[1])
    json.dump(analyze(args["input"], args["model"], args.get("hint")), sys.stdout)
