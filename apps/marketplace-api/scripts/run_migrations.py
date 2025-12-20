#!/usr/bin/env python3
"""
Simple migration runner for RDS PostgreSQL
Connects to database and runs all migration files in order
"""
import os
import sys
import asyncio
import asyncpg
from pathlib import Path
from app.config import settings


async def run_migrations():
    """Run all migration files in order"""
    # Get migrations directory
    migrations_dir = Path(__file__).parent.parent / "migrations"
    
    if not migrations_dir.exists():
        print(f"❌ Migrations directory not found: {migrations_dir}")
        sys.exit(1)
    
    # Get all SQL files sorted by name
    migration_files = sorted(migrations_dir.glob("*.sql"))
    
    if not migration_files:
        print(f"❌ No migration files found in {migrations_dir}")
        sys.exit(1)
    
    print(f"📁 Found {len(migration_files)} migration files")
    print(f"🔗 Connecting to database...")
    print()
    
    try:
        # Connect to database
        conn = await asyncpg.connect(settings.DATABASE_URL)
        print("✅ Connected to database")
        print()
        
        # Create migrations tracking table if it doesn't exist
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL UNIQUE,
                executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        
        # Get already executed migrations
        executed = await conn.fetch("SELECT filename FROM schema_migrations")
        executed_filenames = {row['filename'] for row in executed}
        
        # Run migrations
        for migration_file in migration_files:
            filename = migration_file.name
            
            if filename in executed_filenames:
                print(f"⏭️  Skipping {filename} (already executed)")
                continue
            
            print(f"🔄 Running {filename}...")
            
            try:
                # Read and execute migration
                sql = migration_file.read_text()
                
                # Remove comments and check if there's actual SQL
                # Split by lines, remove comment-only lines and empty lines
                lines = [line for line in sql.split('\n') 
                         if line.strip() and not line.strip().startswith('--')]
                sql_content = '\n'.join(lines).strip()
                
                # Skip empty migrations (only whitespace/comments)
                if not sql_content:
                    print(f"⏭️  Skipping {filename} (empty or comments only)")
                    # Still mark as executed
                    await conn.execute(
                        "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
                        filename
                    )
                    print()
                    continue
                
                # Execute in a transaction
                async with conn.transaction():
                    await conn.execute(sql)
                    await conn.execute(
                        "INSERT INTO schema_migrations (filename) VALUES ($1)",
                        filename
                    )
                
                print(f"✅ Completed {filename}")
                print()
                
            except Exception as e:
                print(f"❌ Error running {filename}: {e}")
                await conn.close()
                sys.exit(1)
        
        await conn.close()
        print("🎉 All migrations completed successfully!")
        
    except asyncpg.exceptions.InvalidPasswordError:
        print("❌ Invalid database password. Check your DATABASE_URL in .env")
        sys.exit(1)
    except asyncpg.exceptions.InvalidCatalogNameError:
        print("❌ Database does not exist. Check your DATABASE_URL in .env")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Database connection error: {e}")
        print(f"   Check your DATABASE_URL in .env file")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run_migrations())
