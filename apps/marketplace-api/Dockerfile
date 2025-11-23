FROM python:3.11-slim

WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Expose port (default, can be overridden by env)
EXPOSE 8000

# Run the application with hot reload enabled for development
# Host and port will be read from environment variables via settings
# Set RELOAD=false to disable hot reload for production
CMD ["sh", "-c", "uvicorn app.main:app --host ${API_HOST:-0.0.0.0} --port ${API_PORT:-8000} --reload"]

