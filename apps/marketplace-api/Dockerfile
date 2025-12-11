FROM python:3.11-slim

WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Copy scripts and migrations for running migrations
COPY scripts/ ./scripts/
COPY migrations/ ./migrations/

# Expose port (default, can be overridden by env)
EXPOSE 8000

# Run the application
# For production, use workers for better performance
CMD ["sh", "-c", "uvicorn app.main:app --host ${API_HOST:-0.0.0.0} --port ${API_PORT:-8000}"]

