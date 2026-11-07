# OCR service (strong OCR for bills and invoices)

A small private web service the app sends a bill photo or PDF to. It returns the text lines with positions and
confidence; the app's document-intelligence layer (`lib/ocr-extract.ts`) turns them into invoice fields, and a person
reviews and approves before anything reaches the books.

**Engines:** PaddleOCR's PP-OCR models first (run on ONNX Runtime via `rapidocr-onnxruntime`, light enough for free
CPU hosting; set `OCR_ENGINE=paddleocr` to use the official PaddleOCR package instead), Tesseract as the fallback
when PP-OCR reads little or with low confidence. PDFs with a text layer are read exactly from the PDF itself.

**Clean-up:** EXIF rotation, scaling, uneven-light flattening, denoise, contrast (CLAHE), tilt straightening,
0/90/180/270 page rotation, warnings for blurred / dark / probably handwritten pages. Up to 10 pages per PDF.

**Privacy and access:** files are processed in memory and never stored or logged. Every request must carry the
person's Supabase sign-in token; the service checks it with Supabase Auth before reading.

## Benchmark (synthetic bills, 7 Nov 2026)

`bench/make_and_read.py` renders GST invoices with known answers (1–5 items, 5–28% GST, intra- and inter-state,
round-off) and damages them like phone photos; `bench/score.ts` scores the extracted fields. 27 bills, 3 per condition.

| Condition | Amounts, taxes, total | GSTIN | Date | Fully correct (every field) |
|---|---|---|---|---|
| Clean / tilted / sideways / upside down / shadow / phone photo / digital PDF / scanned 2-page PDF | 100% | 100% | 100% | 100% |
| Blurred | 100% | 100% | 100% | 0% (spaces between words lost in shop names and item names; one invoice number misread) |
| **All 27** (PP-OCR first) | **100%** | **100%** | **100%** | **89%** |
| All 27, Tesseract alone (earlier run, for comparison) | 100% | 93% | 100% | 81% (weaker on blurred and phone photos) |

Re-measured on 7 Nov 2026 with the exact versions in `requirements.txt` (rapidocr-onnxruntime 1.4.4, OpenCV 4.10).
Blurred photos get a "photo looks blurred" warning on the review screen.

Remaining mistakes are single characters in names or numbers, which is why every bill is reviewed. Real photos
(creases, handwriting, thermal paper, stamps) are harder than these synthetic ones and **have not been tested yet**.
Average time: about 4–5 s per photo page on one CPU core; a digital PDF takes milliseconds.

Run it: `pip install -r requirements.txt` (plus `tesseract-ocr`), then
`python bench/make_and_read.py 27 && bun bench/score.ts` (use `OCR_ONLY_TESSERACT=1 BENCH_OUT=bench/out-tess` to compare).

## Deploy (free, browser only)

Any free container host works. One option, Hugging Face Spaces:
1. huggingface.co → New Space → SDK **Docker** → *Private*.
2. Upload `Dockerfile`, `requirements.txt`, `app.py`, `ocr_pipeline.py` (Files → Add file).
3. Settings → Variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the public anon key — never the service-role key),
   `ALLOWED_ORIGINS` (your web app address).
4. Put the Space URL in the app as `EXPO_PUBLIC_OCR_URL`.

Local test: `OCR_DEV_NO_AUTH=1 uvicorn app:app --host 127.0.0.1 --port 7860` (the no-auth switch works only on 127.0.0.1).
