# Environment Configuration Guide

## Overview

The backend uses environment variables for all configuration. This makes it easy to:
- Switch between development and production
- Keep secrets out of code
- Configure for different environments (local, staging, AWS)

## Setup

1. **Copy the example file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your values:**
   ```bash
   # Edit .env file
   nano .env  # or use your preferred editor
   ```

3. **The `.env` file is automatically loaded** by:
   - Docker Compose (via `env_file` in docker-compose.yml)
   - Pydantic Settings (via `app/config.py`)

## Configuration Options

### API Configuration
```env
API_HOST=0.0.0.0          # Server host
API_PORT=8000             # Server port
API_TITLE=Vayada API      # API title
API_VERSION=1.0.0         # API version
```

### Database Configuration
```env
DATABASE_URL=postgresql://user:password@host:port/database
DATABASE_POOL_MIN_SIZE=2      # Minimum connection pool size
DATABASE_POOL_MAX_SIZE=10      # Maximum connection pool size
DATABASE_COMMAND_TIMEOUT=60    # Command timeout in seconds
```

### CORS Configuration
```env
# Comma-separated list of allowed origins
CORS_ORIGINS=http://localhost:3000,https://yourdomain.com
CORS_ALLOW_CREDENTIALS=true
CORS_ALLOW_METHODS=*
CORS_ALLOW_HEADERS=*
```

### Environment
```env
ENVIRONMENT=development   # development, staging, production
DEBUG=true               # Enable debug mode
```

## Environment-Specific Examples

### Local Development
```env
DATABASE_URL=postgresql://vayada_user:vayada_password@postgres:5432/vayada_db
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
ENVIRONMENT=development
DEBUG=true
```

### Production (AWS)
```env
DATABASE_URL=postgresql://user:password@your-rds-endpoint.region.rds.amazonaws.com:5432/vayada_db
CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
ENVIRONMENT=production
DEBUG=false
```

## Using Environment Variables

### In Docker Compose
The `docker-compose.yml` automatically loads `.env`:
```yaml
backend:
  env_file:
    - .env
```

### In Code
Access settings via the `settings` object:
```python
from app.config import settings

database_url = settings.DATABASE_URL
cors_origins = settings.cors_origins_list
```

## Security Best Practices

1. **Never commit `.env` to git** (already in `.gitignore`)
2. **Use `.env.example`** to document required variables
3. **For production**, use:
   - AWS Secrets Manager
   - AWS Parameter Store
   - Environment variables in ECS/EKS task definitions
4. **Rotate secrets regularly**
5. **Use different `.env` files** for different environments

## Testing Configuration

After changing `.env`, restart the backend:
```bash
docker-compose restart backend
```

Verify configuration:
```bash
curl http://localhost:8000/health
curl http://localhost:8000/health/db
```

