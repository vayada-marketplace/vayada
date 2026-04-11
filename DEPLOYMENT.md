# Production Deployment Playbook

This document describes how to deploy two independent changes to AWS:

1. **Currency Fix** — already on `main`, fixes the non-USD price-scrambling bug
2. **Multi-Hotel Support** — on `feature/multi-hotel-ids`, lets one user own multiple properties

Deploy them as **two separate releases**, with a stability window between them, so that if anything breaks it's clear which change to roll back.

---

## Infrastructure quick reference

- **RDS instance:** `vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com`
- **Region:** `eu-west-1` (Ireland)
- **All four application databases** (`vayada_booking_db`, `vayada_auth_db`, `vayada_pms_db`, `vayada_db` marketplace) live on the same RDS instance as separate databases
- **A single RDS snapshot** backs up all four DBs at once — this is your rollback anchor

---

# Release 1: Currency Fix

**Scope:** Code-only. No DB migrations.
**Risk:** Low. Fixes are additive — existing hotels continue to work identically, only new hotels with non-USD currencies benefit.
**Est. downtime:** None (rolling deploy).

## 1.1 Pre-flight checks

From your laptop:

```bash
cd ~/git/vayada
git fetch vayada
git log --oneline vayada/main -10
```

You should see recent commits including the currency fixes (ef16082 convertBetween, 4f7c350 normalize case, 885a938 addon conversion, etc.). The full list of currency-related commits:

```bash
git log --oneline vayada/main --grep="currency\|Currency\|scrambling" -20
```

## 1.2 RDS snapshot (safety net)

Take a manual snapshot before any deploy. Even though this release has no DB changes, a snapshot is cheap insurance:

```bash
aws rds create-db-snapshot \
  --region eu-west-1 \
  --db-instance-identifier vayada-database \
  --db-snapshot-identifier pre-currency-fix-$(date +%Y%m%d-%H%M)
```

Wait until `available`:

```bash
aws rds describe-db-snapshots \
  --region eu-west-1 \
  --db-snapshot-identifier pre-currency-fix-$(date +%Y%m%d-%H%M) \
  --query 'DBSnapshots[0].Status'
```

## 1.3 Deploy

Whatever your deployment mechanism is (ECS service update, GitHub Actions workflow, etc.), trigger a deploy of the three affected services from `main`:

- `pms-backend`
- `booking-engine-backend`
- `booking-engine-frontend`
- `booking-engine-frontend-admin`

**Order does not matter** for this release — all changes are backward-compatible.

## 1.4 Smoke test in production

Register a fresh test account with a non-USD currency:

1. Open an incognito window
2. Register a hotel-owner account with a throwaway email
3. In the setup wizard: pick **AUD** as the default currency
4. Add one room with base rate `100`
5. Complete the setup
6. Open the public booking page for that hotel
7. **Expected:** Room displays as `A$100` (not `$142`)
8. Make a test booking with "Pay at Property"
9. **Expected:** Booking confirmation shows `AUD 100` total
10. Log into the PMS and open the booking
11. **Expected:** Booking total shows `AUD 100`

If all three checks match → currency fix is live and working.

## 1.5 Clean up the test account

Delete the test hotel from both DBs (or leave it, it's harmless). At minimum, disable its public URL.

## 1.6 Stability window

**Let this run for 2-3 days before deploying Release 2.** This gives you time to notice any unexpected currency issues from the fix itself, without mixing in a separate change.

---

# Release 2: Multi-Hotel Support

**Scope:** Code + one-time DB migration.
**Risk:** Medium. The migration changes primary keys on `pms.hotels` and updates 12 child tables. Single-hotel users (the vast majority today) see no behavioral change; multi-hotel users become possible.
**Est. downtime:** Short (seconds for ~200 hotels). Recommend a maintenance window.

## 2.1 Pre-flight: audit existing production data

**This is critical.** The feature branch assumes every PMS hotel has a corresponding `booking_hotels` row (joined on `user_id + slug`), and that no user has multiple rows in either DB yet.

Run these read-only queries against production RDS:

### 2.1.1 Check for unexpected multi-hotel users on booking-engine

```sql
-- Connect to vayada_booking_db
SELECT user_id, COUNT(*) AS hotel_count
FROM booking_hotels
GROUP BY user_id
HAVING COUNT(*) > 1
ORDER BY hotel_count DESC;
```

**Expected:** Empty result.
**If non-empty:** Today, any user with >1 row in `booking_hotels` is a ghost — the dashboard/settings code picks `LIMIT 1` arbitrarily, so these accounts may already be showing wrong data. Review each one manually before running the migration:

- Is one of the rows obviously abandoned (no bookings, no settings changes since creation)? Delete the ghost.
- Are both rows real? Keep both — the migration will handle them, and after deploy the user will see both in the switcher.

### 2.1.2 Check for unexpected multi-hotel users on PMS

```sql
-- Connect to vayada_pms_db
SELECT user_id, COUNT(*) AS hotel_count
FROM hotels
GROUP BY user_id
HAVING COUNT(*) > 1
ORDER BY hotel_count DESC;
```

**Expected:** Empty result.
**If non-empty:** same investigation as above.

### 2.1.3 Check PMS hotels without a booking_hotels counterpart

The migration script errors out if any PMS hotel has no matching `booking_hotels` row by `(user_id, slug)`. Detect these upfront:

```sql
-- This requires cross-DB access. Easier to do via the migration
-- script's dry-run mode (next section) which runs the exact check.
```

Skip the manual SQL — use the script dry-run in step 2.2 instead.

## 2.2 Migration script dry-run

The migration lives in `pms/vayada-pms-backend/scripts/unify_hotel_ids.py`. It defaults to dry-run mode.

From your laptop, with production credentials in environment variables:

```bash
export DATABASE_URL="postgresql://vayada_pms_user:<prod_password>@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_pms_db?sslmode=require"
export BOOKING_ENGINE_DATABASE_URL="postgresql://vayada_booking_user:<prod_password>@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_booking_db?sslmode=require"

cd ~/git/vayada/pms/vayada-pms-backend
python3 -m venv /tmp/migrate-venv
/tmp/migrate-venv/bin/pip install asyncpg
/tmp/migrate-venv/bin/python scripts/unify_hotel_ids.py
```

**Read the output carefully:**

- `Total mappable hotels: N` — should match your approximate hotel count (~200)
- `PMS orphans (no booking_hotels match): 0` — MUST be 0, else stop and investigate
- `Booking orphans (no PMS match, ignored): M` — can be non-zero, these are users who started booking-admin setup but never created a PMS hotel. Not a blocker
- `Sample mapping (first 5):` — spot-check that old→new id pairs look plausible

**If PMS orphans > 0:** STOP. The script refuses to run. Investigate each orphan row manually:

```sql
-- vayada_pms_db
SELECT id, user_id, slug, name, created_at
FROM hotels
WHERE id = '<orphan_id_from_script_output>';
```

Then check if a matching row exists in `vayada_booking_db.booking_hotels` by slug or email. Possible outcomes:

- **Test/junk row** → delete the PMS hotel (cascades to any child tables, beware!)
- **Slug mismatch** between DBs (typo) → fix the slug on one side so they match
- **Missing booking_hotels row** → create it manually with the same id

After resolving, re-run the dry-run until it reports 0 orphans.

## 2.3 RDS snapshot (mandatory this time)

```bash
SNAP_ID=pre-multi-hotel-$(date +%Y%m%d-%H%M)
aws rds create-db-snapshot \
  --region eu-west-1 \
  --db-instance-identifier vayada-database \
  --db-snapshot-identifier $SNAP_ID

# Wait until available (usually 2-5 min)
while true; do
  STATUS=$(aws rds describe-db-snapshots \
    --region eu-west-1 \
    --db-snapshot-identifier $SNAP_ID \
    --query 'DBSnapshots[0].Status' --output text)
  echo "Snapshot status: $STATUS"
  [ "$STATUS" = "available" ] && break
  sleep 30
done
```

**Record the snapshot ID somewhere visible** (Slack, notebook) so the on-call can roll back without hunting for it.

## 2.4 Maintenance window

Announce a short maintenance window (10-15 minutes is more than enough). During the window:

1. **Put the app in maintenance mode** or scale backends to 0 to block writes
   - Option A: ECS service desired count → 0 for `pms-backend` + `booking-engine-backend`
   - Option B: ALB target group → change to a maintenance page target
2. **Wait 30 seconds** for in-flight requests to drain
3. Proceed to migration

## 2.5 Run the migration

From your laptop, same env vars as the dry-run, but now with `--execute`:

```bash
cd ~/git/vayada/pms/vayada-pms-backend
/tmp/migrate-venv/bin/python scripts/unify_hotel_ids.py --execute
```

**Expected output:**

```
Fetching hotels from both databases...
  Total mappable hotels: <N>
  PMS orphans (no booking_hotels match): 0
  Booking orphans (no PMS match, ignored): <M>

Mapping summary: <N> ids to change, 0 already unified (noop)

Sample mapping (first 5):
  ...

Executing migration in a single transaction...
Migration completed successfully.
```

**If the script fails:** the transaction rolls back automatically — the DB is untouched. Read the error, fix whatever caused it (probably a mapping issue), and retry. You do **not** need to restore from snapshot for script failures.

**If the script hangs:** wait a bit (up to a few minutes on 200 rows is fine). If it stays stuck, kill it (`Ctrl-C`) — the transaction rolls back. Then investigate locks:

```sql
SELECT pid, state, query FROM pg_stat_activity
WHERE datname = 'vayada_pms_db' AND state != 'idle';
```

## 2.6 Verify

Run these sanity queries:

```sql
-- vayada_pms_db
SELECT COUNT(*) FROM hotels;  -- same as before migration

-- Cross-DB spot check: pick 3 random hotel slugs
SELECT id, slug FROM hotels ORDER BY random() LIMIT 3;
```

Then check the same slugs in `vayada_booking_db`:

```sql
-- vayada_booking_db
SELECT id, slug FROM booking_hotels WHERE slug IN ('<slug1>','<slug2>','<slug3>');
```

**Expected:** the three id/slug pairs are **identical** across both DBs.

Also quickly confirm children still reference valid hotels:

```sql
-- vayada_pms_db
SELECT COUNT(*) FROM bookings WHERE hotel_id NOT IN (SELECT id FROM hotels);
SELECT COUNT(*) FROM room_types WHERE hotel_id NOT IN (SELECT id FROM hotels);
SELECT COUNT(*) FROM hotel_payment_settings WHERE hotel_id NOT IN (SELECT id FROM hotels);
```

All three should be **0**.

## 2.7 Deploy the application code

Merge `feature/multi-hotel-ids` into `main`, push, and trigger deploys for all four affected services:

- `pms-backend` (Phase 1.1/1.2 contextvar + dependency)
- `booking-engine-backend` (Phase 1.3 new POST /admin/hotels + Phase 1.5 dashboard scoping)
- `booking-engine-frontend-admin` (Phase 2.1 setup wizard update)
- `booking-engine-frontend` (no changes for this release — slug resolver was already deployed in Release 1)

**Order matters here:**

1. Deploy **backends first** (pms + booking-engine). They are backward compatible: old frontends sending no `X-Hotel-Id` still work (legacy fallback path).
2. Deploy **frontend-admin second**. Once live, new property creation goes through `POST /admin/hotels` with `bookingHotelId`.

## 2.8 Exit maintenance mode

Scale backends back to normal capacity / restore the ALB target.

## 2.9 Post-deploy smoke test

From an incognito window:

1. Log in as an **existing** production user (or your own admin account)
2. Dashboard should load normally, showing the same hotel and the same stats as before
3. Hotel-switcher in the header should show your existing hotel
4. Click "Add Property" → go through the setup wizard → create a minimal second property
5. After finish, switcher should show **both** hotels
6. Switch to the new hotel → dashboard should show empty stats (it's new)
7. Switch back to the original hotel → same stats as step 2

If all six pass → multi-hotel is live.

---

## Rollback procedures

### Release 1 (Currency Fix)

Currency fix is code-only and additive. To roll back:

1. Revert the relevant commits on `main` and redeploy:
   ```bash
   cd ~/git/vayada
   git revert <commit-hash>
   git push vayada main
   ```
2. Trigger deploy of the affected services.
3. No DB work needed.

### Release 2 (Multi-Hotel) — before code is deployed

If the migration succeeded but something feels wrong before you deploy the new code:

1. The DB is in the "new id" state
2. The old code still works because it uses `WHERE user_id` (legacy fallback path) and doesn't care about the exact id values
3. So you can simply **not deploy the code** and leave the DB alone. Multi-hotel isn't active, but nothing is broken either.

### Release 2 (Multi-Hotel) — after code is deployed

Two options depending on severity:

**Option A: Roll back code only (preferred if possible)**

1. Revert the merge of `feature/multi-hotel-ids` on `main`, redeploy backends
2. The DB stays in "new id" state. The old code uses `WHERE user_id` lookups, which still find the right row (the IDs just happen to be different values now, but the relationships are intact)
3. This is safe because the id unification doesn't break any existing query pattern — it just makes new ones possible.

**Option B: Full restore from snapshot (nuclear)**

Use only if data corruption is suspected.

```bash
# 1. Scale backends to 0
aws ecs update-service --cluster vayada --service pms-backend --desired-count 0
aws ecs update-service --cluster vayada --service booking-engine-backend --desired-count 0

# 2. Rename the current DB (so we can restore alongside it for verification)
# RDS doesn't support rename; instead, restore the snapshot to a new instance,
# verify it, then switch DNS / connection strings

aws rds restore-db-instance-from-db-snapshot \
  --region eu-west-1 \
  --db-instance-identifier vayada-database-restored \
  --db-snapshot-identifier <snap_id_from_step_2.3>

# 3. Verify the restored instance has the pre-migration data
# 4. Update SSM parameters / env vars to point to vayada-database-restored
# 5. Scale backends back up
# 6. When confident, delete the original instance and rename the restored one
```

This is an hours-long operation, not minutes. Only do it if data integrity is at stake.

---

## Checklist summary

### Release 1 (Currency Fix)

- [ ] Pull latest `main`, verify currency commits present
- [ ] Take RDS snapshot (insurance)
- [ ] Deploy pms-backend, booking-engine-backend, booking-engine-frontend, booking-engine-frontend-admin
- [ ] Smoke test: create AUD hotel, verify price consistency across booking engine, confirmation, PMS
- [ ] Delete/disable test hotel
- [ ] 2-3 day stability window

### Release 2 (Multi-Hotel)

- [ ] Run audit queries 2.1.1 and 2.1.2 — verify 0 multi-hotel users exist already
- [ ] Run migration script in dry-run mode — verify 0 PMS orphans
- [ ] Investigate any orphans or ghost rows before proceeding
- [ ] Take RDS snapshot and record snapshot id
- [ ] Announce maintenance window
- [ ] Scale backends to 0 / enable maintenance mode
- [ ] Run migration script with `--execute`
- [ ] Run verification queries 2.6
- [ ] Merge `feature/multi-hotel-ids` into `main`, push
- [ ] Deploy backends
- [ ] Deploy frontend-admin
- [ ] Exit maintenance mode
- [ ] Post-deploy smoke test: login, switcher, add property, switch
- [ ] Monitor logs for 24h

---

## Contact / notes

- Migration script is idempotent for already-unified rows: you can re-run `--execute` safely. Rows where `old_id == new_id` are no-ops.
- The script uses a single transaction — partial failure means total rollback, no cleanup needed.
- If you need to re-run the audit queries after the migration, they should return the same "no multi-hotel users" result (unless someone added a property post-deploy, which is the point).
