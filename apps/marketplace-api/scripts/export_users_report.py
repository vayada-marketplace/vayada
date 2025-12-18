#!/usr/bin/env python3
"""
Export all registered users to a beautiful HTML report and CSV file
"""
import asyncio
import sys
from pathlib import Path
from datetime import datetime
import csv

# Add parent directory to path to import app modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.database import Database
from app.config import settings


async def export_users_report():
    """Export users to HTML and CSV files"""
    try:
        print("🔗 Connecting to database...")
        await Database.get_pool()
        print("✅ Connected to database\n")
        
        # Fetch all users
        users = await Database.fetch(
            """
            SELECT id, email, name, type, status, created_at
            FROM users
            ORDER BY created_at DESC
            """
        )
        
        if not users:
            print("📭 No users found in the database")
            return
        
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        
        # Export to CSV
        csv_filename = f"users_export_{timestamp}.csv"
        print(f"📊 Exporting {len(users)} users to CSV...")
        
        with open(csv_filename, 'w', newline='', encoding='utf-8') as csvfile:
            writer = csv.writer(csvfile)
            writer.writerow(['Email', 'Name', 'Type', 'Status', 'Created At'])
            
            for user in users:
                writer.writerow([
                    user['email'] or '',
                    user['name'] or '',
                    user['type'] or '',
                    user['status'] or '',
                    user['created_at'].strftime('%Y-%m-%d %H:%M:%S') if user['created_at'] else ''
                ])
        
        print(f"✅ CSV exported: {csv_filename}\n")
        
        # Generate HTML report
        html_filename = f"users_report_{timestamp}.html"
        print(f"📄 Generating HTML report...")
        
        # Calculate statistics
        type_counts = {}
        status_counts = {}
        for user in users:
            user_type = user['type']
            user_status = user['status']
            type_counts[user_type] = type_counts.get(user_type, 0) + 1
            status_counts[user_status] = status_counts.get(user_status, 0) + 1
        
        # Generate HTML
        html_content = f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vayada Users Report - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</title>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
            min-height: 100vh;
        }}
        
        .container {{
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }}
        
        .header {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }}
        
        .header h1 {{
            font-size: 2.5em;
            margin-bottom: 10px;
            font-weight: 700;
        }}
        
        .header p {{
            font-size: 1.1em;
            opacity: 0.9;
        }}
        
        .stats {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8f9fa;
        }}
        
        .stat-card {{
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            text-align: center;
        }}
        
        .stat-card h3 {{
            color: #667eea;
            font-size: 2em;
            margin-bottom: 5px;
        }}
        
        .stat-card p {{
            color: #666;
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        
        .table-container {{
            padding: 30px;
            overflow-x: auto;
        }}
        
        table {{
            width: 100%;
            border-collapse: collapse;
            background: white;
        }}
        
        thead {{
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }}
        
        th {{
            padding: 15px;
            text-align: left;
            font-weight: 600;
            text-transform: uppercase;
            font-size: 0.85em;
            letter-spacing: 0.5px;
        }}
        
        td {{
            padding: 15px;
            border-bottom: 1px solid #e9ecef;
        }}
        
        tbody tr {{
            transition: background-color 0.2s;
        }}
        
        tbody tr:hover {{
            background-color: #f8f9fa;
        }}
        
        .badge {{
            display: inline-block;
            padding: 5px 12px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: 600;
            text-transform: uppercase;
        }}
        
        .badge-creator {{
            background: #e3f2fd;
            color: #1976d2;
        }}
        
        .badge-hotel {{
            background: #fff3e0;
            color: #f57c00;
        }}
        
        .badge-pending {{
            background: #fff9c4;
            color: #f9a825;
        }}
        
        .badge-verified {{
            background: #c8e6c9;
            color: #388e3c;
        }}
        
        .footer {{
            padding: 20px;
            text-align: center;
            color: #666;
            background: #f8f9fa;
            border-top: 1px solid #e9ecef;
        }}
        
        .email {{
            color: #667eea;
            text-decoration: none;
        }}
        
        .email:hover {{
            text-decoration: underline;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 Vayada Users Report</h1>
            <p>Generated on {datetime.now().strftime('%B %d, %Y at %H:%M:%S')}</p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <h3>{len(users)}</h3>
                <p>Total Users</p>
            </div>
            <div class="stat-card">
                <h3>{type_counts.get('creator', 0)}</h3>
                <p>Creators</p>
            </div>
            <div class="stat-card">
                <h3>{type_counts.get('hotel', 0)}</h3>
                <p>Hotels</p>
            </div>
            <div class="stat-card">
                <h3>{status_counts.get('pending', 0)}</h3>
                <p>Pending</p>
            </div>
            <div class="stat-card">
                <h3>{status_counts.get('verified', 0)}</h3>
                <p>Verified</p>
            </div>
        </div>
        
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Email</th>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Created At</th>
                    </tr>
                </thead>
                <tbody>
"""
        
        for idx, user in enumerate(users, 1):
            email = user['email'] or 'N/A'
            name = user['name'] or 'N/A'
            user_type = user['type'] or 'N/A'
            status = user['status'] or 'N/A'
            created_at = user['created_at'].strftime('%Y-%m-%d %H:%M') if user['created_at'] else 'N/A'
            
            type_class = 'badge-creator' if user_type == 'creator' else 'badge-hotel'
            status_class = f"badge-{status.lower()}"
            
            html_content += f"""
                    <tr>
                        <td>{idx}</td>
                        <td><a href="mailto:{email}" class="email">{email}</a></td>
                        <td>{name}</td>
                        <td><span class="badge {type_class}">{user_type}</span></td>
                        <td><span class="badge {status_class}">{status}</span></td>
                        <td>{created_at}</td>
                    </tr>
"""
        
        html_content += """
                </tbody>
            </table>
        </div>
        
        <div class="footer">
            <p>© Vayada - All rights reserved</p>
            <p>This report was automatically generated</p>
        </div>
    </div>
</body>
</html>
"""
        
        with open(html_filename, 'w', encoding='utf-8') as f:
            f.write(html_content)
        
        print(f"✅ HTML report generated: {html_filename}\n")
        print(f"📁 Files created:")
        print(f"   - {csv_filename} (CSV format)")
        print(f"   - {html_filename} (HTML report)")
        print(f"\n💡 Open {html_filename} in your browser to view the beautiful report!")
        
        # Also output HTML content (base64 encoded for easy copy)
        import base64
        html_b64 = base64.b64encode(html_content.encode('utf-8')).decode('utf-8')
        print(f"\n📋 HTML Report (Base64 - copy and decode to save locally):")
        print("=" * 80)
        print(html_b64)
        print("=" * 80)
        print("\n💡 To decode: echo '<base64_string>' | base64 -d > report.html")
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        await Database.close_pool()


if __name__ == "__main__":
    asyncio.run(export_users_report())

