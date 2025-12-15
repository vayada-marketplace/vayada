#!/usr/bin/env python3
"""
Script to display database entries
"""
import asyncio
import sys
import os
from pathlib import Path

# Add parent directory to path to import app modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.database import Database
from app.config import settings


async def show_table_data(table_name: str, limit: int = 100):
    """Show data from a specific table"""
    try:
        # Get column names first
        columns = await Database.fetch(
            f"""
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = $1 
            ORDER BY ordinal_position
            """,
            table_name
        )
        
        if not columns:
            print(f"  Table '{table_name}' not found or has no columns")
            return
        
        column_names = [col['column_name'] for col in columns]
        
        # Get row count
        count = await Database.fetchval(f"SELECT COUNT(*) FROM {table_name}")
        
        print(f"\n{'='*80}")
        print(f"Table: {table_name} ({count} rows)")
        print(f"{'='*80}")
        
        if count == 0:
            print("  (No data)")
            return
        
        # Fetch data
        rows = await Database.fetch(f"SELECT * FROM {table_name} LIMIT {limit}")
        
        if len(rows) > limit:
            print(f"  (Showing first {limit} of {count} rows)")
        
        # Print column headers
        print("\nColumns:", ", ".join(column_names))
        print("-" * 80)
        
        # Print rows
        for i, row in enumerate(rows, 1):
            print(f"\nRow {i}:")
            for col_name in column_names:
                value = row[col_name]
                # Format the value nicely
                if value is None:
                    value_str = "NULL"
                elif isinstance(value, (dict, list)):
                    value_str = str(value)[:100] + ("..." if len(str(value)) > 100 else "")
                else:
                    value_str = str(value)
                print(f"  {col_name}: {value_str}")
        
    except Exception as e:
        print(f"  Error reading table '{table_name}': {e}")


async def show_all_tables():
    """Show all tables and their data"""
    try:
        # Get all table names
        tables = await Database.fetch(
            """
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
            ORDER BY table_name
            """
        )
        
        if not tables:
            print("No tables found in database")
            return
        
        print("\n" + "="*80)
        print("DATABASE ENTRIES")
        print("="*80)
        print(f"\nFound {len(tables)} tables:")
        for table in tables:
            print(f"  - {table['table_name']}")
        
        # Show data for each table
        for table in tables:
            table_name = table['table_name']
            await show_table_data(table_name)
        
    except Exception as e:
        print(f"Error: {e}")


async def show_specific_tables():
    """Show data from specific important tables"""
    important_tables = [
        'users',
        'creators',
        'creator_platforms',
        'hotel_profiles',
        'hotel_listings',
        'listing_collaboration_offerings',
        'listing_creator_requirements',
    ]
    
    print("\n" + "="*80)
    print("DATABASE ENTRIES - IMPORTANT TABLES")
    print("="*80)
    
    for table_name in important_tables:
        await show_table_data(table_name)


async def main():
    """Main function"""
    try:
        # Initialize database connection
        await Database.get_pool()
        
        # Check if specific table requested
        if len(sys.argv) > 1:
            table_name = sys.argv[1]
            await show_table_data(table_name)
        else:
            # Show all important tables
            await show_specific_tables()
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        await Database.close_pool()


if __name__ == "__main__":
    asyncio.run(main())
