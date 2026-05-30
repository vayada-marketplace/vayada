# scripts

Helper scripts for the Vayada monorepo.

## `dev-portless.sh`

Start the local development stack with Docker databases/backends and portless
frontends.

```sh
./scripts/dev-portless.sh
# or
npm run dev:portless
```

The script starts the Docker services needed by the FastAPI APIs in the
background, registers the portless API aliases, then runs `portless` in the
foreground for all Next.js apps.

To stop the Docker backend services started by the script:

```sh
./scripts/dev-portless.sh --stop
```

## `run_migration.sh`

Run database migrations against the production AWS RDS instance for a given
service. Temporarily opens the RDS security group to your public IP, runs the
service's `scripts/run_migrations.py`, then revokes the ingress rule on exit.

```sh
./scripts/run_migration.sh <pms|booking|marketplace|auth>
```

Requires AWS CLI credentials and Python 3 with `asyncpg`. DB passwords are stored in AWS SSM under `/vayada/prod/`.

## Seed scripts

Populate local databases with mock data for development. All seed scripts
default to `localhost` Postgres URLs; override via `DATABASE_URL`,
`AUTH_DATABASE_URL`, `PMS_DATABASE_URL` env vars.

| Script                | Purpose                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `seed_users.py`       | Seeds the shared auth DB with the admin user and mock hotel/creator accounts. **Run this first.**                  |
| `seed_marketplace.py` | Seeds the marketplace DB with profiles, listings, collaborations, chats, and reviews.                              |
| `seed_booking.py`     | Seeds the booking-engine DB (hotel properties, translations) and the PMS DB (hotels, room types, sample bookings). |
| `seed_all.py`         | Runs the three above in order (`users → marketplace → booking`) and prints credentials at the end.                 |

```sh
npm run seed:test-data
```

Default credentials after seeding:

- Admin: `admin@vayada.com` / `Vayada123`
- Hotels: `hotel[1-5]@mock.com` / `Test1234`
- Creators: `creator[1-4]@mock.com` / `Test1234`
