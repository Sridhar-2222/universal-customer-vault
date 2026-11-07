"""OCR service for Universal Customer Vault (FastAPI).

POST /read  (multipart field "file": JPG/PNG/WEBP/PDF, max 15 MB) with the person's Supabase access token in
            "Authorization: Bearer <token>". The token is checked with Supabase Auth before anything is read, so only
            signed-in users of this app can use the service. The file is processed in memory and never stored or logged.
GET  /health

Settings (environment variables): SUPABASE_URL, SUPABASE_ANON_KEY (public values, used only to check tokens),
ALLOWED_ORIGINS (comma-separated web origins), OCR_ENGINE (rapidocr | paddleocr), OCR_MAX_PAGES.
OCR_DEV_NO_AUTH=1 skips the token check and is refused unless the service listens on 127.0.0.1 (local tests only).
"""
from __future__ import annotations

import os

import httpx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from ocr_pipeline import read_document

MAX_BYTES = 15 * 1024 * 1024
TYPES = {"image/jpeg", "image/png", "image/webp", "application/pdf"}
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
DEV_NO_AUTH = os.environ.get("OCR_DEV_NO_AUTH") == "1" and os.environ.get("HOST", "127.0.0.1") == "127.0.0.1"

app = FastAPI(title="UCV OCR", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=[o for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o],
                   allow_methods=["POST", "GET"], allow_headers=["authorization", "content-type"])


async def check_user(authorization: str | None) -> None:
    if DEV_NO_AUTH:
        return
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        raise HTTPException(503, "not_configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "sign_in_required")
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{SUPABASE_URL}/auth/v1/user", headers={"apikey": SUPABASE_ANON_KEY, "authorization": authorization})
    if r.status_code != 200:
        raise HTTPException(401, "sign_in_required")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/read")
async def read(file: UploadFile = File(...), authorization: str | None = Header(default=None)) -> dict:
    await check_user(authorization)
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "too_big")
    mime = (file.content_type or "").lower()
    if mime not in TYPES and data[:5] != b"%PDF-":
        raise HTTPException(415, "bad_type")
    try:
        return await run_in_threadpool(read_document, data, mime)
    except Exception:
        raise HTTPException(422, "could_not_read")
