# Vayada Backend API

FastAPI backend for the Vayada Creator Marketplace.

## Setup

### Prerequisites
- Docker and Docker Compose
- Python 3.11+ (for local development)

### Running with Docker

1. Start all services:
```bash
docker-compose up -d
```

2. Check services are running:
```bash
docker-compose ps
```

3. View logs:
```bash
docker-compose logs -f backend
```

### Environment Variables

The backend uses environment variables from a `.env` file. Copy `.env.example` to `.env` and customize as needed:

```bash
cp .env.example .env
```

**Key Environment Variables:**
- `DATABASE_URL`: PostgreSQL connection string
- `CORS_ORIGINS`: Comma-separated list of allowed frontend origins
- `API_HOST`: API server host (default: 0.0.0.0)
- `API_PORT`: API server port (default: 8000)
- `ENVIRONMENT`: Environment name (development/production)
- `DEBUG`: Enable debug mode (true/false)

See `.env.example` for all available configuration options.

## API Endpoints

### Health Checks
- `GET /` - Root endpoint
- `GET /health` - Service health check
- `GET /health/db` - Database connection health check

### API Documentation
- `GET /docs` - Interactive Swagger UI
- `GET /openapi.json` - OpenAPI schema

## Database

The database runs in a Docker container and automatically runs migrations on first startup.

### Connection Details
- Host: `localhost` (from host) or `postgres` (from Docker network)
- Port: `5432`
- Database: `vayada_db`
- User: `vayada_user`
- Password: `vayada_password`

### Manual Database Access
```bash
docker-compose exec postgres psql -U vayada_user -d vayada_db
```

## Development

### Rebuilding after changes
```bash
docker-compose build backend
docker-compose up -d backend
```

### Viewing logs
```bash
docker-compose logs -f backend
```

## Frontend Connection

The frontend should be configured to connect to:
- Development: `http://localhost:8000`

Create a `.env.local` file in the frontend directory with:
```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

