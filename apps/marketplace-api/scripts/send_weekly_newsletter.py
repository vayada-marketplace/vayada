#!/usr/bin/env python3
"""
Weekly newsletter sender.

Run via cron or a scheduler once a week, e.g.:
    0 9 * * 1 cd /app && python -m scripts.send_weekly_newsletter

Reads newsletter preferences, fetches recommendations, and sends emails.
"""
import asyncio
import logging
import random
import sys
import os
from datetime import datetime, timedelta

# Add parent dir to path so we can import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import Database, AuthDatabase
from app.config import settings
from app.email_service import (
    send_email,
    create_newsletter_for_creator_html,
    create_newsletter_for_hotel_html,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

RECOMMENDATIONS_COUNT = 5
NEW_ITEMS_COUNT = 5


async def _get_verified_user_ids() -> dict:
    """Return {user_id_str: {id, email, name, type}} for all verified users."""
    rows = await AuthDatabase.fetch(
        "SELECT id, email, name, type FROM users WHERE status = 'verified'"
    )
    return {str(r['id']): dict(r) for r in rows}


async def _get_newsletter_prefs() -> list:
    """Return all enabled newsletter preference rows."""
    rows = await Database.fetch(
        "SELECT * FROM newsletter_preferences WHERE enabled = TRUE"
    )
    return [dict(r) for r in rows]


async def _get_hotel_listings(country_filter: list | None = None) -> list:
    """Get verified hotel listings for recommendations."""
    query = """
        SELECT hl.id, hl.name, hl.location, hl.description,
               hl.accommodation_type, hl.images,
               hp.name as hotel_name, hp.picture as hotel_picture,
               hp.id as hotel_profile_id, hl.created_at
        FROM hotel_listings hl
        JOIN hotel_profiles hp ON hp.id = hl.hotel_profile_id
        WHERE hp.profile_complete = TRUE
        ORDER BY hl.created_at DESC
    """
    rows = await Database.fetch(query)
    results = [dict(r) for r in rows]

    if country_filter:
        # Simple case-insensitive substring match on location
        lower_filter = [c.lower() for c in country_filter]
        results = [
            r for r in results
            if r.get('location') and any(c in r['location'].lower() for c in lower_filter)
        ]

    return results


async def _get_creators(country_filter: list | None = None) -> list:
    """Get verified creators for recommendations."""
    query = """
        SELECT c.id, c.user_id, c.location, c.short_description,
               c.profile_picture, c.creator_type, c.created_at,
               (SELECT SUM(followers) FROM creator_platforms WHERE creator_id = c.id) as total_followers,
               (SELECT name FROM creator_platforms WHERE creator_id = c.id ORDER BY followers DESC LIMIT 1) as top_platform
        FROM creators c
        WHERE c.profile_complete = TRUE
        ORDER BY c.created_at DESC
    """
    rows = await Database.fetch(query)
    results = [dict(r) for r in rows]

    if country_filter:
        lower_filter = [c.lower() for c in country_filter]
        results = [
            r for r in results
            if r.get('location') and any(c in r['location'].lower() for c in lower_filter)
        ]

    return results


def _pick_recommendations(items: list, count: int) -> list:
    """Pick a semi-random set, weighting newer items higher."""
    if len(items) <= count:
        return items
    # Top third are "new", rest are "older" — pick from both
    third = max(1, len(items) // 3)
    new_pool = items[:third]
    old_pool = items[third:]
    # Pick ~60% from new, ~40% from old
    new_count = min(len(new_pool), max(1, int(count * 0.6)))
    old_count = min(len(old_pool), count - new_count)
    picked = random.sample(new_pool, new_count) + random.sample(old_pool, old_count)
    random.shuffle(picked)
    return picked


def _get_new_items(items: list, count: int, days: int = 7) -> list:
    """Items created in the last `days` days."""
    cutoff = datetime.utcnow() - timedelta(days=days)
    new = [i for i in items if i.get('created_at') and i['created_at'].replace(tzinfo=None) > cutoff]
    return new[:count]


async def send_newsletters_with_pools():
    """
    Entry point when DB pools are already initialised (called from the app scheduler).
    """
    await _run_newsletter_loop()


async def send_newsletters():
    """Standalone entry point — creates and tears down its own DB pools."""
    await Database.get_pool()
    await AuthDatabase.get_pool()

    try:
        await _run_newsletter_loop()
    finally:
        await AuthDatabase.close_pool()
        await Database.close_pool()


async def _run_newsletter_loop():
    """Core newsletter logic shared by both entry points."""
    verified_users = await _get_verified_user_ids()
    prefs_list = await _get_newsletter_prefs()

    # Build a lookup: user_id -> preferences
    prefs_map = {str(p['user_id']): p for p in prefs_list}

    # Collect users who explicitly disabled
    disabled_ids = set()
    rows = await Database.fetch(
        "SELECT user_id FROM newsletter_preferences WHERE enabled = FALSE"
    )
    for r in rows:
        disabled_ids.add(str(r['user_id']))

    # Build final recipient list: verified users who are not explicitly disabled
    recipients = []
    for user_id, user in verified_users.items():
        if user['type'] not in ('creator', 'hotel'):
            continue
        if user_id in disabled_ids:
            continue
        pref = prefs_map.get(user_id)
        country_filter = pref.get('country_filter') if pref else None
        recipients.append((user_id, user, country_filter))

    if not recipients:
        logger.info("No newsletter recipients found. Exiting.")
        return

    sent = 0
    skipped = 0

    for user_id, user, country_filter in recipients:
        user_type = user['type']
        user_email = user['email']
        user_name = user['name'] or 'there'

        try:
            if user_type == 'creator':
                await _send_creator_newsletter(user_email, user_name, country_filter)
            elif user_type == 'hotel':
                await _send_hotel_newsletter(user_email, user_name, user_id, country_filter)
            else:
                continue
            sent += 1
        except Exception as e:
            logger.error(f"Failed to send newsletter to {user_email}: {e}")
            skipped += 1

    logger.info(f"Newsletter run complete. Sent: {sent}, Skipped: {skipped}")


async def _send_creator_newsletter(email: str, name: str, country_filter: list | None):
    """Build and send newsletter for a creator."""
    all_listings = await _get_hotel_listings(country_filter)
    if not all_listings:
        logger.info(f"No listings to recommend for creator {email}")
        return

    recs = _pick_recommendations(all_listings, RECOMMENDATIONS_COUNT)
    new_hotels = _get_new_items(all_listings, NEW_ITEMS_COUNT)

    rec_items = []
    for r in recs:
        images = r.get('images') or []
        rec_items.append({
            "name": r['hotel_name'] + " — " + r['name'],
            "location": r.get('location', ''),
            "description": r.get('description', '')[:120],
            "image_url": images[0] if images else None,
        })

    new_items = []
    for h in new_hotels:
        images = h.get('images') or []
        new_items.append({
            "name": h['hotel_name'] + " — " + h['name'],
            "location": h.get('location', ''),
            "description": h.get('description', '')[:120],
            "image_url": images[0] if images else None,
        })

    html = create_newsletter_for_creator_html(
        creator_name=name,
        recommendations=rec_items,
        new_hotels=new_items,
        frontend_url=settings.FRONTEND_URL,
    )
    await send_email(email, "Your Weekly Hotel Picks — Vayada", html)


async def _send_hotel_newsletter(email: str, name: str, user_id: str, country_filter: list | None):
    """Build and send newsletter for a hotel."""
    # Get verified creator user IDs to filter
    verified_users = await _get_verified_user_ids()
    all_creators = await _get_creators(country_filter)

    # Only include creators whose user is verified
    verified_creator_ids = {uid for uid, u in verified_users.items() if u['type'] == 'creator'}
    all_creators = [c for c in all_creators if str(c['user_id']) in verified_creator_ids]

    if not all_creators:
        logger.info(f"No creators to recommend for hotel {email}")
        return

    # Resolve creator names
    creator_names = {}
    for c in all_creators:
        uid = str(c['user_id'])
        u = verified_users.get(uid)
        creator_names[uid] = u['name'] if u else 'Creator'

    recs = _pick_recommendations(all_creators, RECOMMENDATIONS_COUNT)
    new_creators = _get_new_items(all_creators, NEW_ITEMS_COUNT)

    def _to_item(c):
        return {
            "name": creator_names.get(str(c['user_id']), 'Creator'),
            "location": c.get('location', ''),
            "description": c.get('short_description', '')[:120],
            "image_url": c.get('profile_picture'),
            "followers": c.get('total_followers'),
            "platform": c.get('top_platform'),
        }

    rec_items = [_to_item(c) for c in recs]
    new_items = [_to_item(c) for c in new_creators]

    html = create_newsletter_for_hotel_html(
        hotel_name=name,
        recommendations=rec_items,
        new_creators=new_items,
        frontend_url=settings.FRONTEND_URL,
    )
    await send_email(email, "Your Weekly Creator Picks — Vayada", html)


if __name__ == "__main__":
    asyncio.run(send_newsletters())
