# Vayada Admin Frontend

Admin panel for managing Vayada users, built with Next.js 14.

## Getting Started

### Option 1: Local Development (without Docker)

1. Install dependencies:
```bash
npm install
```

2. Create a `.env.local` file:
```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

3. Run the development server:
```bash
npm run dev
```

The admin panel will be available at [http://localhost:3001](http://localhost:3001)

### Option 2: Docker Development

1. Create a `.env.local` file (optional, defaults to `http://localhost:8000`):
```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

2. Run with Docker Compose:
```bash
docker-compose up
```

The admin panel will be available at [http://localhost:3001](http://localhost:3001)

### Option 3: Production Build with Docker

1. Build the Docker image:
```bash
docker build --build-arg NEXT_PUBLIC_API_URL=http://your-api-url:8000 -t vayada-admin-frontend .
```

2. Run the container:
```bash
docker run -p 3001:3001 vayada-admin-frontend
```

Or build and run in one command:
```bash
docker build --build-arg NEXT_PUBLIC_API_URL=http://your-api-url:8000 -t vayada-admin-frontend . && docker run -p 3001:3001 vayada-admin-frontend
```

## Features

- Admin authentication
- User management (view, edit, approve, deny)
- User filtering and search
- Clean, functional admin interface

## Docker Files

- `Dockerfile` - Production multi-stage build (optimized)
- `Dockerfile.dev` - Development build
- `docker-compose.yml` - Local development setup

