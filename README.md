# vayada

vayada is a hospitality platform that connects travel creators and influencers with hotels for collaborations, and provides hotels with a direct booking engine and property management system. The platform is composed of three core products — a **Creator Marketplace**, a **Booking Engine**, and a **Property Management System (PMS)** — each with dedicated customer-facing frontends, admin dashboards, and backend APIs, all sharing a centralized authentication system.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Repository Structure](#repository-structure)
- [Tech Stack](#tech-stack)
- [Services](#services)
  - [Creator Marketplace](#creator-marketplace)
  - [Booking Engine](#booking-engine)
  - [Property Management System](#property-management-system)
  - [Shared Authentication](#shared-authentication)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Running the Full Stack](#running-the-full-stack)
  - [Seeding Test Data](#seeding-test-data)
- [Service Ports](#service-ports)
- [Databases](#databases)
- [Infrastructure](#infrastructure)
- [Environment Variables](#environment-variables)
- [Git Submodules](#git-submodules)
- [Scripts](#scripts)
- [Test Accounts](#test-accounts)
- [Development Workflow](#development-workflow)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              vayada Platform                                │
│                                                                              │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────────┐  │
│  │  Creator Marketplace │  │    Booking Engine     │  │        PMS        │  │
│  │                      │  │                       │  │                   │  │
│  │ ┌────────┐ ┌───────┐ │  │ ┌────────┐ ┌───────┐ │  │ ┌───────┐        │  │
│  │ │Frontend│ │ Admin │ │  │ │Frontend│ │ Admin │ │  │ │Frontend│        │  │
│  │ │ :3000  │ │ :3001 │ │  │ │ :3002  │ │ :3003 │ │  │ │ :3004  │        │  │
│  │ └───┬────┘ └───┬───┘ │  │ └───┬────┘ └───┬───┘ │  │ └───┬───┘        │  │
│  │     │          │      │  │     │          │      │  │     │            │  │
│  │ ┌───▼──────────▼────┐ │  │ ┌───▼──────────▼────┐ │  │ ┌───▼──────────┐ │  │
│  │ │ Marketplace API   │ │  │ │  Booking API      │ │  │ │   PMS API    │ │  │
│  │ │     :8000         │ │  │ │     :8001         │ │  │ │    :8002     │ │  │
│  │ └───┬───────────────┘ │  │ └───┬───────────────┘ │  │ └───┬─────────┘ │  │
│  └─────┼────────────────┘  └─────┼────────────────┘  └─────┼───────────┘  │
│        │                         │                          │              │
│  ┌─────▼──────┐ ┌──────────┐ ┌───▼──────┐ ┌───────────┐ ┌──▼──────────┐  │
│  │Marketplace │ │ Auth DB  │ │Booking DB│ │  PMS DB   │ │   MinIO     │  │
│  │ DB :5432   │ │  :5435   │ │  :5434   │ │  :5436    │ │ :9000/:9001 │  │
│  │ PostgreSQL │ │PostgreSQL│ │PostgreSQL│ │PostgreSQL │ │ S3 Storage  │  │
│  └────────────┘ └──────────┘ └──────────┘ └───────────┘ └─────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

The platform follows a microservices architecture:

- **Eight application services**: Three backends (FastAPI) and five frontends (Next.js)
- **Four PostgreSQL databases**: One per domain (marketplace, booking, PMS, auth)
- **MinIO**: S3-compatible object storage for images
- **Shared auth database**: Centralized user management across all services
- **Docker Compose orchestration**: All services managed through a single compose file

---

## Repository Structure

```
vayada/
├── booking-engine/                     # Booking engine product
│   ├── vayada-booking-engine-backend/        # FastAPI backend (submodule)
│   ├── vayada-booking-engine-frontend/       # Next.js guest frontend (submodule)
│   └── vayada-booking-engine-frontend-admin/ # Next.js admin dashboard (submodule)
│
├── pms/                               # Property Management System
│   ├── vayada-pms-backend/                   # FastAPI backend (submodule)
│   └── vayada-pms-frontend/                  # Next.js hotel dashboard (submodule)
│
├── marketplace/                        # Creator marketplace product
│   ├── vayada-creator-marketplace-backend/        # FastAPI backend (submodule)
│   ├── vayada-creator-marketplace-frontend/       # Next.js public frontend (submodule)
│   └── vayada-creator-marketplace-frontend-admin/ # Next.js admin dashboard (submodule)
│
├── auth-db/                            # Shared authentication database
│   ├── migrations/                           # Auth schema migrations
│   └── scripts/                              # Migration runner
│
├── infra/                              # AWS infrastructure (Terraform)
│   ├── ecs.tf                                # ECS service definitions
│   ├── alb.tf                                # ALB and routing rules
│   ├── ecr.tf                                # Container registries
│   ├── route53.tf                            # DNS records
│   └── ...
│
├── scripts/                            # Seed and utility scripts
│   ├── seed_all.py                           # Master seed runner
│   ├── seed_users.py                         # Auth DB user seeds
│   ├── seed_marketplace.py                   # Marketplace DB seeds
│   ├── seed_booking.py                       # Booking + PMS DB seeds
│   └── run_migration.sh                      # Remote migration runner
│
├── docker-compose.yml                  # Full-stack orchestration (13 services)
├── .gitmodules                         # Submodule definitions
└── README.md
```

---

## Tech Stack

| Layer           | Technology                                      |
|-----------------|------------------------------------------------|
| **Backends**    | Python 3.11, FastAPI, Uvicorn (ASGI)           |
| **Frontends**   | Next.js 14 (App Router), React 18, TypeScript  |
| **Styling**     | Tailwind CSS, PostCSS                          |
| **Databases**   | PostgreSQL 15 (Alpine)                         |
| **ORM / DB**    | AsyncPG (async PostgreSQL driver)              |
| **Auth**        | JWT-based (PyJWT, bcrypt)                      |
| **Payments**    | Stripe                                         |
| **Storage**     | MinIO (S3-compatible), boto3                   |
| **i18n**        | next-intl (booking engine frontend)            |
| **Icons**       | Heroicons React                                |
| **Infra**       | AWS (ECS Fargate, ALB, RDS, ECR, Route53, S3)  |
| **IaC**         | Terraform                                      |
| **CI/CD**       | GitHub Actions                                 |
| **Containers**  | Docker, Docker Compose                         |

---

## Services

### Creator Marketplace

The marketplace connects travel creators and influencers with hotels for paid collaborations.

**Backend** (`marketplace/vayada-creator-marketplace-backend/`) — Port 8000

- User registration and authentication (creators, hotels, admins)
- Creator profiles with social platforms, audience analytics, and portfolio
- Hotel listings with collaboration offerings and creator requirements
- Collaboration workflow: requests, negotiations, deliverables, messaging
- Real-time chat between creators and hotels
- Image upload and processing via MinIO/S3
- Invite codes for hotel onboarding (pre-configured setups)
- GDPR compliance: data export, deletion requests, consent tracking
- Email notifications

**Admin Panel** (`marketplace/vayada-creator-marketplace-frontend-admin/`) — Port 3001

- Sidebar navigation: Users, Hotels, Marketplace, Collaborations, Invite Codes
- User management (view, edit, approve, reject creators and hotels)
- Hotel booking engine configuration (embedded)
- Marketplace preview (listings and creators)
- Collaboration monitoring
- Invite code creation with full setup wizard (property, branding, rooms, policies, billing terms)

---

### Booking Engine

The booking engine allows hotels to accept direct bookings from guests with a fully customizable, white-label booking experience.

**Backend** (`booking-engine/vayada-booking-engine-backend/`) — Port 8001

- Hotel configuration with branding, amenities, social links, and translations
- Room type management with images, pricing, and availability
- End-to-end booking flow with guest details and payment
- Affiliate link tracking and commission management
- Multi-currency support with live exchange rates
- Custom domain support (Cloudflare integration)
- Property settings API (including billing plans and payout details)
- Add-on management (transport, wellness, dining, experiences)

**Frontend** (`booking-engine/vayada-booking-engine-frontend/`) — Port 3002

- Hotel landing page with hero, amenities, and room previews
- Room listing with filters, availability search, and detail modals
- Dynamic book-direct benefits per room type
- Checkout flow with guest form and payment
- Booking confirmation and lookup
- Affiliate tracking via URL parameters
- Multi-language support (EN, DE, FR, ES, ID)
- Social media links in footer
- Custom domain resolution

**Admin Dashboard** (`booking-engine/vayada-booking-engine-frontend-admin/`) — Port 3003

- Dashboard with booking metrics
- Design Studio: hero image, colors, font pairing (live preview)
- Booking Flow: room filters, add-ons, guest details, payment config
- Settings: property info, contact, social media, currency/languages, billing
- Billing tab: view commission/fixed-fee plans, switch for next month, payout details (IBAN)
- Setup wizard (5 steps) with invite code support for pre-filled onboarding

---

### Property Management System

The PMS provides hotel operations management — rooms, bookings, calendar, and channel management.

**Backend** (`pms/vayada-pms-backend/`) — Port 8002

- Hotel and room type management with seasonal pricing
- Booking management with room assignment
- Calendar with availability blocks
- Public rooms API (serves room data to booking frontend)
- Image upload to S3
- Beds24 channel manager integration (two-way sync)
- Affiliate management and payout scheduling

**Frontend** (`pms/vayada-pms-frontend/`) — Port 3004

- Dashboard with occupancy and revenue metrics
- Room type management with amenities, features, and benefits
- Calendar view with drag-and-drop
- Booking list and detail views
- Settings: hotel info, integrations
- Beds24 connection and room mapping

---

### Shared Authentication

The auth database (`auth-db/`) provides centralized user management for all services.

**Schema tables:**
- `users` — Core user table (email, password hash, name, type, status, avatar)
- `password_reset_tokens` — Token-based password recovery
- `email_verification_codes` — One-time verification codes
- `cookie_consent`, `consent_history` — GDPR consent tracking
- `gdpr_requests` — Data export and deletion requests

**User types:** `hotel`, `creator`, `admin`
**User statuses:** `pending`, `verified`, `rejected`, `suspended`

---

## Getting Started

### Prerequisites

- **Docker** and **Docker Compose** (v2+)
- **Python 3.11+** with `asyncpg` and `bcrypt` (for seed scripts)
- **Git** (with submodule support)

### Running the Full Stack

1. **Clone with submodules:**

   ```bash
   git clone --recurse-submodules https://github.com/FlamurMaliqi/vayada.git
   cd vayada
   ```

2. **Run auth migrations** (auth DB doesn't auto-migrate):

   ```bash
   DATABASE_URL="postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db" \
     python3 auth-db/scripts/run_migrations.py
   ```

3. **Start all services:**

   ```bash
   docker compose up -d
   ```

4. **Seed test data:**

   ```bash
   pip install asyncpg bcrypt
   python scripts/seed_all.py
   ```

5. **Access the applications:**

   | Application               | URL                        |
   |---------------------------|----------------------------|
   | Marketplace Frontend      | http://localhost:3000       |
   | Marketplace Admin         | http://localhost:3001       |
   | Booking Engine Frontend   | http://localhost:3002       |
   | Booking Engine Admin      | http://localhost:3003       |
   | PMS Frontend              | http://localhost:3004       |
   | Marketplace API Docs      | http://localhost:8000/docs  |
   | Booking Engine API Docs   | http://localhost:8001/docs  |
   | PMS API Docs              | http://localhost:8002/docs  |
   | MinIO Console             | http://localhost:9001       |

---

## Service Ports

| Service                       | Port  | Description                          |
|-------------------------------|-------|--------------------------------------|
| Marketplace Frontend          | 3000  | Public marketplace site              |
| Marketplace Admin             | 3001  | vayada admin dashboard               |
| Booking Frontend              | 3002  | Guest-facing booking site            |
| Booking Admin                 | 3003  | Hotel admin dashboard                |
| PMS Frontend                  | 3004  | Hotel property management            |
| Marketplace Backend API       | 8000  | Marketplace REST API                 |
| Booking Backend API           | 8001  | Booking engine REST API              |
| PMS Backend API               | 8002  | PMS REST API                         |
| Marketplace PostgreSQL        | 5432  | Marketplace database                 |
| Booking PostgreSQL            | 5434  | Booking engine database              |
| Auth PostgreSQL               | 5435  | Shared authentication database       |
| PMS PostgreSQL                | 5436  | PMS database                         |
| MinIO API                     | 9000  | S3-compatible object storage         |
| MinIO Console                 | 9001  | MinIO web management UI              |

---

## Databases

| Database      | Port | Name               | User                  |
|---------------|------|--------------------|-----------------------|
| Auth          | 5435 | `vayada_auth_db`   | `vayada_auth_user`    |
| Marketplace   | 5432 | `vayada_db`        | `vayada_user`         |
| Booking       | 5434 | `vayada_booking_db`| `vayada_booking_user` |
| PMS           | 5436 | `vayada_pms_db`    | `vayada_pms_user`     |

All databases use PostgreSQL 15 Alpine with UUID primary keys and timestamp columns. Migrations are in each service's `migrations/` directory.

---

## Infrastructure

Production infrastructure is managed with Terraform in the `infra/` directory:

- **AWS ECS Fargate**: All services run as containers
- **Application Load Balancer**: Routes traffic by hostname
- **RDS PostgreSQL**: Single multi-database instance
- **ECR**: Container registries for each service
- **Route53**: DNS for `*.booking.vayada.com`, `pms.vayada.com`, `api.vayada.com`, etc.
- **S3**: Production image storage (`vayada-uploads-prod`)
- **Cloudflare**: Custom domain SSL for hotel booking engines
- **GitHub Actions**: CI/CD pipelines per service (test, build, push, deploy)

Production domains:
- `*.booking.vayada.com` — Hotel booking engines (wildcard)
- `admin.booking.vayada.com` — Booking admin
- `pms.vayada.com` — PMS frontend
- `booking-api.vayada.com` — Booking API
- `pms-api.vayada.com` — PMS API
- `api.vayada.com` — Marketplace API
- `admin.vayada.com` — Marketplace admin

---

## Environment Variables

Key environment variables are configured in `docker-compose.yml` and service `.env` files. See `infra/terraform.tfvars.example` for production variables.

### Frontends

| Variable                         | Description                    |
|----------------------------------|--------------------------------|
| `NEXT_PUBLIC_API_URL`            | Backend API base URL           |
| `NEXT_PUBLIC_PMS_URL`            | PMS API URL (booking admin)    |
| `NEXT_PUBLIC_MARKETPLACE_API_URL`| Marketplace API (invite codes) |
| `NEXT_PUBLIC_HOTEL_SLUG`         | Default hotel slug             |
| `NEXT_PUBLIC_BOOKING_ADMIN_URL`  | Booking admin URL (PMS handoff)|

---

## Git Submodules

| Submodule                                            | Path                                                    |
|------------------------------------------------------|---------------------------------------------------------|
| `vayada-booking-engine-backend`                      | `booking-engine/vayada-booking-engine-backend`          |
| `vayada-booking-engine-frontend`                     | `booking-engine/vayada-booking-engine-frontend`         |
| `vayada-booking-engine-frontend-admin`               | `booking-engine/vayada-booking-engine-frontend-admin`   |
| `vayada-pms-backend`                                 | `pms/vayada-pms-backend`                                |
| `vayada-pms-frontend`                                | `pms/vayada-pms-frontend`                               |
| `vayada-creator-marketplace-backend`                 | `marketplace/vayada-creator-marketplace-backend`        |
| `vayada-creator-marketplace-frontend`                | `marketplace/vayada-creator-marketplace-frontend`       |
| `vayada-creator-marketplace-frontend-admin`          | `marketplace/vayada-creator-marketplace-frontend-admin` |

```bash
# Initialize and pull all submodules
git submodule update --init --recursive

# Pull latest changes for all submodules
git submodule update --remote --merge
```

---

## Scripts

| Script                 | Description                                            |
|------------------------|--------------------------------------------------------|
| `seed_all.py`          | Runs all seeds in sequence (users, marketplace, booking)|
| `seed_users.py`        | Creates admin, creator, and hotel users in auth DB     |
| `seed_marketplace.py`  | Creates creator profiles, hotel listings, collaborations|
| `seed_booking.py`      | Creates hotels, room types, translations, sample bookings|
| `run_migration.sh`     | Runs migrations against AWS RDS for a given service    |

All seed scripts use `asyncpg` and are idempotent (safe to run multiple times).

---

## Test Accounts

After running `python scripts/seed_all.py`:

| Email              | Password    | Type    | Notes                          |
|--------------------|-------------|---------|--------------------------------|
| admin@vayada.com   | vayada123   | admin   | Full admin access              |
| creator1@mock.com  | Test1234    | creator | Verified, with platforms       |
| creator2@mock.com  | Test1234    | creator | Verified                       |
| creator3@mock.com  | Test1234    | creator | Pending                        |
| creator4@mock.com  | Test1234    | creator | Verified                       |
| hotel1@mock.com    | Test1234    | hotel   | Hotel Alpenrose (EUR)          |
| hotel2@mock.com    | Test1234    | hotel   | Grand Hotel Riviera (USD)      |
| hotel3@mock.com    | Test1234    | hotel   | The Birchwood Lodge (GBP)      |
| hotel4@mock.com    | Test1234    | hotel   | City Center Hotel (minimal)    |
| hotel5@mock.com    | Test1234    | hotel   | Seaside Retreat (no booking)   |

---

## Development Workflow

### Working on a single service

Each submodule can be developed independently:

```bash
# Backend
cd pms/vayada-pms-backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8002

# Frontend
cd booking-engine/vayada-booking-engine-frontend
npm install && npm run dev
```

### Running only databases

```bash
docker compose up -d marketplace-postgres booking-postgres auth-postgres pms-postgres minio minio-setup
```

### Full stack

```bash
docker compose up -d        # Start everything
docker compose down          # Stop everything
docker compose down -v       # Stop and remove volumes
```
