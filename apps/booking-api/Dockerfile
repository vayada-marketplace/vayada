FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/

EXPOSE 8001

CMD ["sh", "-c", "python scripts/run_migrations.py && uvicorn app.main:app --host ${API_HOST:-0.0.0.0} --port ${API_PORT:-8001}"]
