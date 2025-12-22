#!/usr/bin/env python3
"""
Create an admin user in the database
"""
import asyncio
import asyncpg
import bcrypt
import sys
from pathlib import Path

# Add parent directory to path to import app modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import settings


async def create_admin_user(email: str, password: str, name: str = "Admin User"):
    """Create an admin user in the database"""
    try:
        # Hash password
        print(f"🔐 Hashing password...")
        password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        
        # Connect to database
        print(f"🔗 Connecting to database...")
        conn = await asyncpg.connect(settings.DATABASE_URL)
        print("✅ Connected to database")
        
        # Check if user already exists
        existing = await conn.fetchrow(
            "SELECT id, type, status FROM users WHERE email = $1",
            email
        )
        
        if existing:
            if existing['type'] == 'admin':
                print(f"⚠️  Admin user already exists: {email}")
                print(f"   ID: {existing['id']}")
                print(f"   Status: {existing['status']}")
                
                # Auto-update password in non-interactive mode (ECS)
                print("   Updating password...")
                await conn.execute(
                    "UPDATE users SET password_hash = $1, updated_at = now() WHERE email = $2",
                    password_hash,
                    email
                )
                print("✅ Password updated successfully")
            else:
                # User exists but is not admin - convert to admin
                print(f"⚠️  User exists but is not admin (type: {existing['type']})")
                print("   Converting to admin...")
                await conn.execute(
                    "UPDATE users SET type = 'admin', status = 'verified', password_hash = $1, updated_at = now() WHERE email = $2",
                    password_hash,
                    email
                )
                print("✅ User converted to admin successfully")
        else:
            # Create new admin user
            print(f"👤 Creating admin user: {email}")
            user = await conn.fetchrow(
                """
                INSERT INTO users (email, password_hash, name, type, status, email_verified)
                VALUES ($1, $2, $3, 'admin', 'verified', true)
                RETURNING id, email, name, type, status
                """,
                email,
                password_hash,
                name
            )
            
            print("✅ Admin user created successfully!")
            print(f"   ID: {user['id']}")
            print(f"   Email: {user['email']}")
            print(f"   Name: {user['name']}")
            print(f"   Type: {user['type']}")
            print(f"   Status: {user['status']}")
        
        await conn.close()
        print("\n✨ Done!")
        
    except asyncpg.exceptions.UniqueViolationError:
        print(f"❌ Error: Email {email} already exists")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error creating admin user: {e}")
        sys.exit(1)


if __name__ == "__main__":
    import os
    
    # Get credentials from environment variables (set by ECS) or use defaults
    email = os.getenv("ADMIN_EMAIL", "admin@vayada.com")
    password = os.getenv("ADMIN_PASSWORD", "Vayada123")
    name = os.getenv("ADMIN_NAME", "Admin User")
    
    print("🚀 Creating admin user...")
    print(f"   Email: {email}")
    print(f"   Name: {name}")
    print()
    
    asyncio.run(create_admin_user(email, password, name))

