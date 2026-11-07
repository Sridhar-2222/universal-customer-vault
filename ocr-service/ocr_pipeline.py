"""Strong OCR pipeline for bills and invoices (no network calls, nothing stored).

Order of work for each page:
  1. PDF pages: use the PDF's own text layer when it has one (exact, confidence 1.0); otherwise render the page.
  2. Photos: fix EXIF rotation, scale to a readable size, flatten uneven lighting, boost contrast, straighten small
     tilts, and pick the 0/90/180/270 rotation that reads best.
  3. PaddleOCR (PP-OCR models) reads the page. If it reads little or with low confidence, Tesseract reads it too and
     the better reading is kept (per page).
  4. Warnings for blurred, very dark/faint, or probably handwritten pages.
Output: {"pages": [{"width", "height", "engine", "rotation", "lines": [{"text", "conf", "box": [x0, y0, x1, y1]}]}],
         "warnings": [...], "engine": "...", "ms": int}
The invoice fields are then extracted by lib/ocr-extract.ts (shared with the app), and a person reviews them.
"""
from __future__ import annotations

import io
import os
import time
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps

MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "10"))
ENGINE = os.environ.get("OCR_ENGINE", "rapidocr")  # "rapidocr" (PP-OCR models on ONNX Runtime) or "paddleocr"
ONLY_TESSERACT = os.environ.get("OCR_ONLY_TESSERACT") == "1"  # benchmark comparisons only


@dataclass
class Line:
    text: str
    conf: float
    box: tuple[int, int, int, int]

    def as_dict(self) -> dict:
        return {"text": self.text, "conf": round(float(self.conf), 4), "box": [int(v) for v in self.box]}


# ---------- engines ----------
_paddle = None


def _paddle_engine():
    """PP-OCR text detection + recognition. RapidOCR runs PaddleOCR's own PP-OCR models on ONNX Runtime (light enough for
    free hosting); OCR_ENGINE=paddleocr uses the official PaddleOCR package instead when it is installed."""
    global _paddle
    if _paddle is None:
        if ENGINE == "paddleocr":
            from paddleocr import PaddleOCR  # type: ignore

            _paddle = ("paddleocr", PaddleOCR(use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=True))
        else:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore

            plain = RapidOCR()
            plain.use_angle_cls = False  # second copy without the per-line flip, used only to find the page's rotation
            _paddle = ("pp-ocr", (RapidOCR(), plain))
    return _paddle


def read_paddle(img: np.ndarray, use_cls: bool = True) -> list[Line]:
    kind, eng = _paddle_engine()
    out: list[Line] = []
    if kind == "paddleocr":
        for r in eng.predict(img):
            for txt, sc, poly in zip(r["rec_texts"], r["rec_scores"], r["rec_polys"]):
                xs, ys = [p[0] for p in poly], [p[1] for p in poly]
                out.append(Line(txt, float(sc), (min(xs), min(ys), max(xs), max(ys))))
        return out
    res, _ = (eng[0] if use_cls else eng[1])(img)
    for box, txt, sc in res or []:
        xs, ys = [p[0] for p in box], [p[1] for p in box]
        out.append(Line(txt, float(sc), (min(xs), min(ys), max(xs), max(ys))))
    return out


def read_tesseract(img: np.ndarray) -> list[Line]:
    """Tesseract word boxes merged into lines (block/paragraph/line numbers), confidence 0..1."""
    import pytesseract  # type: ignore

    d = pytesseract.image_to_data(img, lang=os.environ.get("TESS_LANG", "eng"), config="--oem 1 --psm 6", output_type=pytesseract.Output.DICT)
    groups: dict[tuple[int, int, int], list[int]] = {}
    for i, word in enumerate(d["text"]):
        if word.strip() and float(d["conf"][i]) >= 0:
            groups.setdefault((d["block_num"][i], d["par_num"][i], d["line_num"][i]), []).append(i)
    out: list[Line] = []
    for idx in groups.values():
        # split a line where there is a wide gap, so table columns stay separate boxes (like PP-OCR)
        seg: list[int] = []
        segs: list[list[int]] = []
        for i in idx:
            if seg and d["left"][i] - (d["left"][seg[-1]] + d["width"][seg[-1]]) > 2.5 * max(8, d["height"][i]):
                segs.append(seg)
                seg = []
            seg.append(i)
        segs.append(seg)
        for s in segs:
            x0 = min(d["left"][i] for i in s)
            y0 = min(d["top"][i] for i in s)
            x1 = max(d["left"][i] + d["width"][i] for i in s)
            y1 = max(d["top"][i] + d["height"][i] for i in s)
            conf = sum(float(d["conf"][i]) for i in s) / len(s) / 100.0
            out.append(Line(" ".join(d["text"][i] for i in s), conf, (x0, y0, x1, y1)))
    return out


def score(lines: list[Line]) -> float:
    """How much was read, weighted by confidence (characters × confidence)."""
    return sum(len(l.text.strip()) * l.conf for l in lines)


def mean_conf(lines: list[Line]) -> float:
    n = sum(len(l.text) for l in lines)
    return sum(len(l.text) * l.conf for l in lines) / n if n else 0.0


# ---------- image clean-up ----------
def load_image(data: bytes) -> np.ndarray:
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def scale(img: np.ndarray, long_side: int = 2000) -> np.ndarray:
    h, w = img.shape[:2]
    f = long_side / max(h, w)
    if 0.8 < f < 1.25:
        return img
    return cv2.resize(img, (int(w * f), int(h * f)), interpolation=cv2.INTER_CUBIC if f > 1 else cv2.INTER_AREA)


def enhance(img: np.ndarray) -> np.ndarray:
    """Flatten uneven lighting (divide by a large blur), light denoise, local contrast (CLAHE). Returns BGR."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bg = cv2.GaussianBlur(g, (0, 0), sigmaX=max(15, g.shape[1] // 40))
    flat = cv2.divide(g, bg, scale=255)
    flat = cv2.fastNlMeansDenoising(flat, h=7)
    flat = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(flat)
    return cv2.cvtColor(flat, cv2.COLOR_GRAY2BGR)


def deskew_angle(img: np.ndarray) -> float:
    """Small tilt (±15°) from the dominant angle of text strokes."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    th = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3)))
    lines = cv2.HoughLinesP(th, 1, np.pi / 720, threshold=150, minLineLength=th.shape[1] // 6, maxLineGap=20)
    if lines is None:
        return 0.0
    angles = [np.degrees(np.arctan2(y2 - y1, x2 - x1)) for x1, y1, x2, y2 in lines.reshape(-1, 4)]
    angles = [a for a in angles if abs(a) <= 15]
    return float(np.median(angles)) if angles else 0.0


def rotate(img: np.ndarray, angle: float) -> np.ndarray:
    if abs(angle) < 0.3:
        return img
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, m, (nw, nh), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255))


ROT = {0: None, 90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def blur_value(img: np.ndarray) -> float:
    return float(cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())


# ---------- per page ----------
def read_image(img: np.ndarray, page_no: int, warnings: list[str]) -> dict:
    img = scale(img)
    if blur_value(img) < 60:
        warnings.append(f"Page {page_no}: the photo looks blurred. Retake it if numbers are wrong.")
    brightness = float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean())
    if brightness < 70:
        warnings.append(f"Page {page_no}: the photo is very dark.")
    clean = enhance(img)
    clean = rotate(clean, deskew_angle(clean))
    # Quarter turns: read a smaller copy each way and keep the best; most photos are upright, so try 0 first.
    best_rot, best = 0, None
    small = scale(clean, 1100)
    # Score each turn WITHOUT the per-line flip classifier (which would read upside-down lines "correctly" but leave
    # the page order reversed) and count only wide boxes (text lines are wider than tall when the page is upright).
    for rot in (0, 90, 270, 180):
        trial = small if ROT[rot] is None else cv2.rotate(small, ROT[rot])
        tl = [l for l in read_paddle(trial, use_cls=False) if (l.box[2] - l.box[0]) > 1.2 * (l.box[3] - l.box[1])]
        s = score(tl)
        if best is None or s > best * 1.15:
            best_rot, best = rot, s
        if rot == 0 and len(tl) >= 8 and mean_conf(tl) > 0.9:
            break  # clearly upright: skip the other turns
    final = clean if ROT[best_rot] is None else cv2.rotate(clean, ROT[best_rot])
    if ONLY_TESSERACT:
        tl = read_tesseract(final)
        h, w = final.shape[:2]
        return {"width": w, "height": h, "engine": "tesseract", "rotation": best_rot, "lines": [l.as_dict() for l in tl if l.text.strip()]}
    lines, engine = read_paddle(final), "pp-ocr"
    if len(lines) < 5 or mean_conf(lines) < 0.75:
        try:
            tl = read_tesseract(final)
            if score(tl) > score(lines) * 1.1:
                lines, engine = tl, "tesseract"
        except Exception:  # Tesseract missing: keep PP-OCR's reading
            pass
    h, w = final.shape[:2]
    if lines and mean_conf(lines) < 0.7:
        warnings.append(f"Page {page_no}: much of the text was hard to read (faint or handwritten?). Check every field.")
    return {"width": w, "height": h, "engine": engine, "rotation": best_rot, "lines": [l.as_dict() for l in lines if l.text.strip()]}


def read_pdf(data: bytes, warnings: list[str]) -> list[dict]:
    import fitz  # PyMuPDF

    pages: list[dict] = []
    with fitz.open(stream=data, filetype="pdf") as doc:
        if doc.page_count > MAX_PAGES:
            warnings.append(f"Only the first {MAX_PAGES} pages were read.")
        for i, page in enumerate(doc):
            if i >= MAX_PAGES:
                break
            words = page.get_text("words")  # x0, y0, x1, y1, word, block, line, word_no
            if sum(len(w[4]) for w in words) >= 40:
                z = 2.0  # same scale as a 144-dpi render so layouts compare with photos
                groups: dict[tuple[int, int], list] = {}
                for w in words:
                    groups.setdefault((w[5], w[6]), []).append(w)
                lines = []
                for ws in groups.values():
                    ws.sort(key=lambda w: w[0])
                    seg = [ws[0]]
                    for w in ws[1:]:
                        if w[0] - seg[-1][2] > 3 * (w[3] - w[1]):
                            lines.append(seg)
                            seg = []
                        seg.append(w)
                    lines.append(seg)
                pages.append({"width": int(page.rect.width * z), "height": int(page.rect.height * z), "engine": "pdf-text", "rotation": 0,
                              "lines": [{"text": " ".join(w[4] for w in s), "conf": 1.0,
                                         "box": [int(s[0][0] * z), int(min(w[1] for w in s) * z), int(s[-1][2] * z), int(max(w[3] for w in s) * z)]} for s in lines]})
            else:
                pix = page.get_pixmap(dpi=200)
                img = cv2.cvtColor(np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n), cv2.COLOR_RGB2BGR if pix.n == 3 else cv2.COLOR_RGBA2BGR)
                pages.append(read_image(img, i + 1, warnings))
    return pages


def read_document(data: bytes, mime: str) -> dict:
    t = time.time()
    warnings: list[str] = []
    if mime == "application/pdf" or data[:5] == b"%PDF-":
        pages = read_pdf(data, warnings)
    else:
        pages = [read_image(load_image(data), 1, warnings)]
    engines = sorted({p["engine"] for p in pages})
    return {"pages": pages, "warnings": warnings, "engine": "+".join(engines), "ms": int((time.time() - t) * 1000)}
