# CI/CD Pipeline Documentation

## Overview

This repository uses GitHub Actions to automatically run tests and deploy code. The pipeline ensures that:

1. **Tests run automatically** on every push and pull request
2. **Deployment only happens** if all tests pass
3. **Code quality is maintained** before merging

## Workflow Files

### 1. `test.yml` - Test Workflow
- **Triggers**: Push to `main`/`develop` branches, Pull Requests
- **Purpose**: Run the full test suite
- **Steps**:
  1. Sets up Python 3.13
  2. Installs dependencies
  3. Starts PostgreSQL service
  4. Creates test database
  5. Runs database migrations
  6. Executes all tests

### 2. `deploy-to-ecr.yml` - Deployment Workflow
- **Triggers**: Push to `main` branch
- **Purpose**: Build and push Docker image to AWS ECR
- **Dependencies**: Requires `test` job to pass first
- **Steps**:
  1. Runs tests (as a job dependency)
  2. Configures AWS credentials
  3. Builds Docker image
  4. Pushes to ECR

## How It Works

### When You Push Code

1. **Push to any branch** → Tests run automatically
2. **Push to `main`** → Tests run, then if they pass, deployment happens
3. **Pull Request** → Tests run to verify the PR is safe to merge

### Test Execution Flow

```
Push/PR → GitHub Actions Triggered
  ↓
Set up Python & PostgreSQL
  ↓
Install Dependencies
  ↓
Create Test Database
  ↓
Run Migrations
  ↓
Run Tests (pytest)
  ↓
✅ Pass → Deployment can proceed
❌ Fail → Deployment blocked
```

## Viewing Test Results

1. Go to your GitHub repository
2. Click on the **"Actions"** tab
3. Select the workflow run you want to view
4. See detailed logs for each step

## Local Testing

Before pushing, you can run tests locally:

```bash
# Start test database
docker-compose up -d postgres

# Run migrations
# (Your migration script or manual SQL)

# Run tests
export DATABASE_URL=postgresql://vayada_user:vayada_password@localhost:5432/vayada_test_db
PYTHONPATH=. pytest tests/ -v
```

## Environment Variables

The test workflow uses these environment variables (set in the workflow file):
- `DATABASE_URL`: Test database connection string
- `EMAIL_ENABLED`: "true" (emails are mocked in tests)
- `JWT_SECRET_KEY`: Test secret key
- `DEBUG`: "true"
- `FRONTEND_URL`: Test frontend URL
- `CORS_ORIGINS`: Test CORS origins

## Troubleshooting

### Tests Fail in CI but Pass Locally

1. Check Python version (CI uses 3.13)
2. Verify database migrations are up to date
3. Check environment variables match
4. Review test logs in GitHub Actions

### Deployment Blocked

If deployment is blocked, it means tests failed. Check:
1. GitHub Actions → Latest workflow run
2. Review test failures
3. Fix issues locally
4. Push again

## Best Practices

1. **Always run tests locally** before pushing
2. **Fix failing tests** before merging PRs
3. **Keep migrations in sync** with your code
4. **Don't skip tests** - they protect your codebase

## Adding New Tests

When you add new tests:
1. Write the test in `tests/` directory
2. Follow existing test patterns
3. Ensure tests are independent and can run in any order
4. Tests will automatically run in CI

