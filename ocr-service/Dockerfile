# Universal Customer Vault OCR service: PP-OCR (PaddleOCR models) + Tesseract fallback. Runs on a free CPU host.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ocr_pipeline.py ./
ENV HOST=0.0.0.0 PORT=7860
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app:app --host $HOST --port $PORT --workers 1"]
