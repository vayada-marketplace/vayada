#!/bin/bash
# Setup script for test database

set -e

echo "Setting up test database..."

# Default values
DB_USER="${POSTGRES_USER:-vayada_user}"
DB_PASSWORD="${POSTGRES_PASSWORD:-vayada_password}"
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
TEST_DB_NAME="${TEST_DB_NAME:-vayada_test_db}"

# Check if using Docker
if docker ps | grep -q vayada-postgres; then
    echo "Using Docker PostgreSQL container..."
    
    # Create test database in Docker container
    docker exec -i vayada-postgres psql -U "$DB_USER" -d postgres <<EOF
SELECT 'CREATE DATABASE $TEST_DB_NAME'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$TEST_DB_NAME')\gexec
EOF
    
    echo "✓ Test database '$TEST_DB_NAME' created in Docker container"
    
    # Run migrations
    echo "Running migrations on test database..."
    export DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$TEST_DB_NAME"
    python3 scripts/run_migrations.py
    
    echo "✓ Migrations completed"
    
else
    echo "Using local PostgreSQL..."
    
    # Check if psql is available
    if ! command -v psql &> /dev/null; then
        echo "Error: psql command not found. Please install PostgreSQL client tools."
        exit 1
    fi
    
    # Create test database
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "CREATE DATABASE $TEST_DB_NAME;" 2>/dev/null || echo "Database might already exist"
    
    echo "✓ Test database '$TEST_DB_NAME' created"
    
    # Run migrations
    echo "Running migrations on test database..."
    export DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$TEST_DB_NAME"
    python3 scripts/run_migrations.py
    
    echo "✓ Migrations completed"
fi

echo ""
echo "Test database setup complete!"
echo "You can now run tests with: pytest tests/ -v"


