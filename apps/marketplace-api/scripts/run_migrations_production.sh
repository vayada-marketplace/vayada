#!/bin/bash

# Production migration runner
# This script can be run:
# 1. Locally with production DATABASE_URL in .env
# 2. As an ECS task
# 3. Via AWS Systems Manager Session Manager

set -e

echo "🔄 Running database migrations..."
echo ""

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    if [ -f .env ]; then
        echo "📄 Loading DATABASE_URL from .env file..."
        export $(grep "^DATABASE_URL=" .env | xargs)
    else
        echo "❌ DATABASE_URL not set and .env file not found"
        echo "   Please set DATABASE_URL environment variable"
        exit 1
    fi
fi

if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL is not set"
    exit 1
fi

echo "🔗 Connecting to database..."
echo ""

# Get migrations directory
MIGRATIONS_DIR="migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
    echo "❌ Migrations directory not found: $MIGRATIONS_DIR"
    exit 1
fi

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo "❌ psql is not installed. Please install PostgreSQL client tools."
    echo "   macOS: brew install postgresql"
    echo "   Ubuntu: sudo apt-get install postgresql-client"
    exit 1
fi

# Create migrations tracking table if it doesn't exist
echo "📋 Setting up migration tracking..."
psql "$DATABASE_URL" -c "
    CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
" > /dev/null 2>&1 || {
    echo "❌ Failed to create migrations tracking table"
    exit 1
}

# Get list of migration files
MIGRATION_FILES=$(ls -1 "$MIGRATIONS_DIR"/*.sql | sort)

if [ -z "$MIGRATION_FILES" ]; then
    echo "❌ No migration files found in $MIGRATIONS_DIR"
    exit 1
fi

# Get already executed migrations
EXECUTED_MIGRATIONS=$(psql "$DATABASE_URL" -t -c "SELECT filename FROM schema_migrations;" 2>/dev/null | tr -d ' ' || echo "")

echo "📁 Found migration files:"
for file in $MIGRATION_FILES; do
    filename=$(basename "$file")
    echo "   - $filename"
done
echo ""

# Run migrations
SUCCESS_COUNT=0
SKIP_COUNT=0
ERROR_COUNT=0

for migration_file in $MIGRATION_FILES; do
    filename=$(basename "$migration_file")
    
    # Check if already executed
    if echo "$EXECUTED_MIGRATIONS" | grep -q "^${filename}$"; then
        echo "⏭️  Skipping $filename (already executed)"
        SKIP_COUNT=$((SKIP_COUNT + 1))
        continue
    fi
    
    echo "🔄 Running $filename..."
    
    # Run migration in a transaction
    if psql "$DATABASE_URL" <<EOF > /dev/null 2>&1
BEGIN;
$(cat "$migration_file")
INSERT INTO schema_migrations (filename) VALUES ('$filename');
COMMIT;
EOF
    then
        echo "✅ Completed $filename"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    else
        echo "❌ Error running $filename"
        ERROR_COUNT=$((ERROR_COUNT + 1))
        # Try to rollback
        psql "$DATABASE_URL" -c "ROLLBACK;" > /dev/null 2>&1 || true
        echo "   Migration failed. Please check the error above."
        exit 1
    fi
    echo ""
done

echo "🎉 Migration summary:"
echo "   ✅ Successful: $SUCCESS_COUNT"
echo "   ⏭️  Skipped: $SKIP_COUNT"
echo "   ❌ Errors: $ERROR_COUNT"
echo ""

if [ $ERROR_COUNT -eq 0 ]; then
    echo "✨ All migrations completed successfully!"
else
    echo "⚠️  Some migrations had errors. Please review above."
    exit 1
fi
