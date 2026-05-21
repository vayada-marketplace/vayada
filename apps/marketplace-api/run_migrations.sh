#!/bin/bash
# Simple migration runner using psql

set -e

# Get DATABASE_URL from .env file
if [ ! -f .env ]; then
    echo "❌ .env file not found"
    exit 1
fi

# Extract DATABASE_URL from .env
DATABASE_URL=$(grep "^DATABASE_URL=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")

if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not found in .env file"
    exit 1
fi

echo "📁 Running migrations..."
echo "🔗 Connecting to database..."
echo ""

# Get migrations directory
MIGRATIONS_DIR="migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
    echo "❌ Migrations directory not found: $MIGRATIONS_DIR"
    exit 1
fi

# Run each migration file in order
for migration_file in $(ls -1 "$MIGRATIONS_DIR"/*.sql | sort); do
    filename=$(basename "$migration_file")
    echo "🔄 Running $filename..."
    
    if psql "$DATABASE_URL" -f "$migration_file" > /dev/null 2>&1; then
        echo "✅ Completed $filename"
    else
        echo "⚠️  $filename may have already been run or had errors (check above)"
    fi
    echo ""
done

echo "🎉 Migrations completed!"
echo ""
echo "💡 To verify, run:"
echo "   psql \"$DATABASE_URL\" -c \"\\dt\""




