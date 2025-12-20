# Test Setup Guide

## Prerequisites

1. **Python 3.13** (or Python 3.11/3.12)
2. **PostgreSQL** database running
3. **Test database** created

## Setup Test Database

### Option 1: Using Docker Compose (Recommended)

```bash
# Start PostgreSQL container
docker-compose up -d postgres

# Create test database
docker exec -it vayada-postgres psql -U vayada_user -d postgres -c "CREATE DATABASE vayada_test_db;"
```

### Option 2: Using Local PostgreSQL

```bash
# Create test database
createdb -U vayada_user vayada_test_db

# Or using psql
psql -U vayada_user -d postgres -c "CREATE DATABASE vayada_test_db;"
```

### Run Migrations on Test Database

```bash
# Set test database URL
export DATABASE_URL=postgresql://vayada_user:vayada_password@localhost:5432/vayada_test_db

# Run migrations
python scripts/run_migrations.py
```

## Environment Variables

You can set test environment variables in several ways:

1. **Using pytest.ini** (already configured)
2. **Using .env.test file** (copy from .env.test.example)
3. **Using environment variables** before running tests:

```bash
export TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/test_db
export EMAIL_ENABLED=false
pytest tests/test_auth.py -v
```

## Running Tests

```bash
# Install dependencies
pip install -r requirements.txt

# Run all tests
pytest tests/ -v

# Run specific test file
pytest tests/test_auth.py -v

# Run specific test class
pytest tests/test_auth.py::TestLogin -v

# Run specific test
pytest tests/test_auth.py::TestLogin::test_login_success -v
```

## Test Database Configuration

The tests use a separate test database (`vayada_test_db`) to avoid affecting your development database.

Default test database connection:
- Host: localhost
- Port: 5432
- User: vayada_user
- Password: vayada_password
- Database: vayada_test_db

You can override this by setting the `TEST_DATABASE_URL` environment variable.

## Notes

- Tests automatically clean up test data before and after each test
- Email sending is disabled in tests (mocked)
- Tests use a separate JWT secret key for security


