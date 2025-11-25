# Test Suite

This directory contains comprehensive tests for all API endpoints.

## Test Structure

- `conftest.py` - Pytest configuration and fixtures
- `test_auth.py` - Authentication endpoint tests (register, login)
- `test_creators.py` - Creator profile endpoint tests
- `test_users.py` - User endpoint tests (email update)

## Running Tests

### Prerequisites

Install test dependencies:
```bash
pip install -r requirements.txt
```

### Run All Tests

```bash
pytest tests/ -v
```

### Run Specific Test File

```bash
pytest tests/test_auth.py -v
pytest tests/test_creators.py -v
pytest tests/test_users.py -v
```

### Run Specific Test

```bash
pytest tests/test_auth.py::TestAuth::test_register_creator -v
```

### With Coverage

```bash
pip install pytest-cov
pytest tests/ --cov=app --cov-report=html
```

## Test Coverage

### Authentication Endpoints (`/auth`)
- ✅ Register creator
- ✅ Register hotel
- ✅ Register with duplicate email (error)
- ✅ Register with invalid password (error)
- ✅ Login success
- ✅ Login with invalid email (error)
- ✅ Login with invalid password (error)

### Creator Endpoints (`/creators`)
- ✅ Get creator profile
- ✅ Get profile when not found (error)
- ✅ Update creator profile (full)
- ✅ Update creator profile (partial)
- ✅ Update profile with no fields (error)
- ✅ Create platform
- ✅ Create platform with invalid name (error)
- ✅ Create duplicate platform (error)
- ✅ Update platform
- ✅ Update platform not found (error)
- ✅ Delete platform
- ✅ Delete platform not found (error)
- ✅ Profile complete after adding platform
- ✅ Unauthorized access (error)

### User Endpoints (`/users`)
- ✅ Update email success
- ✅ Update email duplicate (error)
- ✅ Update email invalid format (error)
- ✅ Update email missing (error)
- ✅ Unauthorized access (error)

## CI/CD Integration

Tests are automatically run in GitHub Actions on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

See `.github/workflows/ci.yml` for configuration.

