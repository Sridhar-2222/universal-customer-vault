"""Benchmark data: renders synthetic GST invoices with known answers, damages them like phone photos, and runs the OCR
pipeline. Writes bench/out/<case>.json = {"truth": {...}, "ocr": {...}}; bench/score.ts scores the extraction.
Synthetic only (no real bills). Usage: python bench/make_and_read.py [count]
"""
from __future__ import annotations

import glob
import io
import json
import os
import random
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ocr_pipeline import read_document  # noqa: E402

OUT = os.environ.get("BENCH_OUT", os.path.join(os.path.dirname(__file__), "out"))
os.makedirs(OUT, exist_ok=True)
C = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin(state: str, rnd: random.Random) -> str:
    L = "ABCDEFGHJKLMNPRSTUVWXYZ"
    s = state + "".join(rnd.choice(L) for _ in range(5)) + "".join(rnd.choice("0123456789") for _ in range(4)) + rnd.choice(L) + "1Z"
    t = 0
    for i, ch in enumerate(s):
        p = C.index(ch) * (1 if i % 2 == 0 else 2)
        t += p // 36 + p % 36
    return s + C[(36 - t % 36) % 36]


def font(paths: list[str], name: str, size: int):
    m = [p for p in paths if name in p]
    return ImageFont.truetype(m[0] if m else paths[0], size)


def inr(p: int) -> str:
    r, ps = divmod(p, 100)
    s = str(r)
    head, tail = s[:-3], s[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return (",".join(groups) + "," if groups else "") + tail + f".{ps:02d}"


SELLERS = ["UDAYA FITTINGS", "SRI LAKSHMI TRADERS", "GANESH ELECTRICALS", "KRISHNA HARDWARE STORES", "VIJAYA AGENCIES", "BALAJI PAINTS & SANITARY"]
ITEMS = [("LED bulb 9W", "8539"), ("PVC wire 90m", "8544"), ("Modular switch 6A", "8536"), ("MCB 32A", "8536"), ("Ceiling fan 1200mm", "8414"),
         ("PVC pipe 1 inch", "3917"), ("Wall putty 20kg", "3214"), ("Copper wire 1.5mm", "7408"), ("Door hinge steel", "8302"), ("Tile adhesive", "3214")]


def make_invoice(rnd: random.Random, my_gstin: str) -> tuple[dict, list[list[tuple[int, str, str]]]]:
    inter = rnd.random() < 0.3
    seller_g = gstin("27" if inter else "36", rnd)
    rate = rnd.choice([5, 12, 18, 18, 28])
    items = []
    for desc, hsn in rnd.sample(ITEMS, rnd.randint(1, 5)):
        qty = rnd.choice([1, 2, 5, 10, 12, 25, 50, 100])
        price = rnd.choice([45, 60, 85, 120, 250, 499, 750, 1200, 2450]) * 100
        items.append({"description": desc, "hsn": hsn, "qty": qty, "rate": price, "amount": qty * price})
    taxable = sum(i["amount"] for i in items)
    tax = round(taxable * rate / 100)
    half = round(tax / 2)
    cgst, sgst, igst = (0, 0, tax) if inter else (half, half, 0)
    total = round((taxable + cgst + sgst + igst) / 100) * 100  # bills round to whole rupees
    num = f"{rnd.choice(['INV', 'UF', 'SLT', 'GE'])}/{rnd.choice(['25-26', '2026'])}/{rnd.randint(10, 9999)}"
    d, m = rnd.randint(1, 28), rnd.randint(1, 10)
    truth = {"kind": "purchase", "party": SELLERS[rnd.randrange(len(SELLERS))], "gstin": seller_g, "number": num, "date": f"2026-{m:02d}-{d:02d}",
             "items": items, "cgst": cgst, "sgst": sgst, "igst": igst, "total": total, "rate": rate}
    # rows of (x, text, style) — style: big | bold | normal
    rows: list[list[tuple[int, str, str]]] = [
        [(320, truth["party"], "big")],
        [(260, f"{rnd.randint(1, 99)}-{rnd.randint(1, 9)}, Main Road, {'Pune' if inter else 'Secunderabad'} - 5000{rnd.randint(10, 99)}", "normal")],
        [(320, f"GSTIN: {seller_g}", "normal")],
        [(400, "TAX INVOICE", "bold")],
        [(60, f"Invoice No: {num}", "normal"), (620, f"Date: {d:02d}/{m:02d}/2026", "normal")],
        [(60, "Bill To: Sai Electricals", "normal")],
        [(60, f"GSTIN: {my_gstin}", "normal")],
        [(60, "S.No", "bold"), (130, "Description", "bold"), (470, "HSN", "bold"), (570, "Qty", "bold"), (660, "Rate", "bold"), (850, "Amount", "bold")],
    ]
    for k, it in enumerate(items, 1):
        rows.append([(70, str(k), "normal"), (130, it["description"], "normal"), (470, it["hsn"], "normal"), (575, str(it["qty"]), "normal"),
                     (660, inr(it["rate"]), "normal"), (850, inr(it["amount"]), "normal")])
    rows.append([(600, "Taxable Value", "normal"), (850, inr(taxable), "normal")])
    if inter:
        rows.append([(600, f"IGST @ {rate}%", "normal"), (850, inr(igst), "normal")])
    else:
        rows.append([(600, f"CGST @ {rate / 2:g}%", "normal"), (850, inr(cgst), "normal")])
        rows.append([(600, f"SGST @ {rate / 2:g}%", "normal"), (850, inr(sgst), "normal")])
    ro = total - (taxable + cgst + sgst + igst)
    if ro:
        rows.append([(600, "Round Off", "normal"), (850, ("-" if ro < 0 else "") + inr(abs(ro)), "normal")])
    rows.append([(600, "Grand Total", "bold"), (850, inr(total), "bold")])
    rows.append([(60, "Thank you for your business", "normal")])
    return truth, rows


def render(rows, fonts) -> Image.Image:
    img = Image.new("RGB", (1100, 140 + 46 * len(rows)), "white")
    d = ImageDraw.Draw(img)
    y = 50
    for row in rows:
        for x, text, style in row:
            f = fonts["big"] if style == "big" else fonts["bold"] if style == "bold" else fonts["normal"]
            d.text((x, y), text, fill=(20, 20, 20), font=f)
        y += 58 if row[0][2] == "big" else 46
    d.line((50, 40 + 46 * 8.3, 1050, 40 + 46 * 8.3), fill=(90, 90, 90), width=2)
    return img


def to_bytes(img: Image.Image, fmt="JPEG", q=88) -> bytes:
    b = io.BytesIO()
    img.save(b, fmt, quality=q)
    return b.getvalue()


def damage(img: Image.Image, how: str, rnd: random.Random) -> Image.Image:
    if how == "clean":
        return img
    if how == "tilt":
        return img.rotate(rnd.choice([-5, -3, 3, 5]), expand=True, fillcolor="white", resample=Image.BICUBIC)
    if how == "rot90":
        return img.rotate(90, expand=True)
    if how == "upside_down":
        return img.rotate(180)
    if how == "blur":
        return img.filter(ImageFilter.GaussianBlur(1.6))
    if how == "shadow":
        a = np.asarray(img).astype(np.float32)
        h, w = a.shape[:2]
        grad = np.tile(np.linspace(1.0, 0.45, w), (h, 1))[..., None]
        a = a * grad * 0.9 + 15
        return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    if how == "phone":  # small, noisy, slightly tilted, low-quality JPEG
        im = img.rotate(2, expand=True, fillcolor=(235, 235, 230)).resize((int(img.width * 0.62), int(img.height * 0.62)), Image.BILINEAR)
        a = np.asarray(im).astype(np.float32) + np.random.default_rng(rnd.randint(0, 9999)).normal(0, 9, (im.height, im.width, 3))
        return Image.open(io.BytesIO(to_bytes(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)), q=55)))
    raise ValueError(how)


def pdf_digital(rows) -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    y = 50
    for row in rows:
        for x, text, style in row:
            page.insert_text((x * 0.5, y), text, fontsize=13 if style == "big" else 9, fontname="helv" if style == "normal" else "hebo")
        y += 28 if row[0][2] == "big" else 22
    return doc.tobytes()


def pdf_scanned(imgs: list[Image.Image]) -> bytes:
    b = io.BytesIO()
    imgs[0].save(b, "PDF", resolution=150, save_all=True, append_images=imgs[1:])
    return b.getvalue()


def main(n: int) -> None:
    rnd = random.Random(7)
    paths = sorted(glob.glob("/usr/share/fonts/truetype/**/*.ttf", recursive=True))
    fonts = {"normal": font(paths, "DejaVuSans.ttf", 22), "bold": font(paths, "DejaVuSans-Bold.ttf", 22), "big": font(paths, "DejaVuSans-Bold.ttf", 34)}
    my = gstin("36", rnd)
    hows = ["clean", "tilt", "rot90", "upside_down", "blur", "shadow", "phone", "pdf_digital", "pdf_scanned_2pages"]
    for i in range(n):
        truth, rows = make_invoice(rnd, my)
        how = hows[i % len(hows)]
        if how == "pdf_digital":
            data, mime = pdf_digital(rows), "application/pdf"
        elif how == "pdf_scanned_2pages":
            split = 8 + max(1, len(truth["items"]) // 2)
            data, mime = pdf_scanned([render(rows[:split], fonts), render(rows[split:], fonts)]), "application/pdf"
        else:
            data, mime = to_bytes(damage(render(rows, fonts), how, rnd)), "image/jpeg"
        ocr = read_document(data, mime)
        with open(os.path.join(OUT, f"{i:03d}_{how}.json"), "w") as f:
            json.dump({"truth": truth, "my_gstin": my, "how": how, "ocr": ocr}, f)
        print(f"{i:03d} {how:20s} {ocr['engine']:12s} {ocr['ms']:6d} ms  lines={sum(len(p['lines']) for p in ocr['pages'])}", flush=True)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 27)
