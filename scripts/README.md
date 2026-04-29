# scripts

Helper scripts for the Vayada monorepo.

## `vw` — vayada worktree helper

Bash helper for running multiple Linear tickets in parallel via git worktrees.
Each ticket gets its own worktree at `~/git/vayada-<TICKET>` on a branch named
after the ticket, with submodules initialized and `.env` files copied from the
main repo. A new Warp tab opens running Claude Code with a 2-phase prompt
(plan → implement & commit). Merging into `main` and pushing is done later
by `vw ship-all`, not by the agent.

| Command | What it does |
| --- | --- |
| `vw new <TICKET> [--install]` | Create worktree on branch `<TICKET>` off `main`, init submodules, copy `.env` files, and open a Warp tab running Claude Code on the ticket. `--install` also runs `npm install` / `pip install` in submodules. Bare numbers are auto-prefixed (`vw new 295` → `VAY-295`). |
| `vw done <TICKET>` | Move the Linear ticket to **In Review**, deinit submodules, remove the worktree, and delete the local branch. |
| `vw list` (or `vw ls`) | List all active worktrees (`git worktree list`). |
| `vw sync` | Fetch `origin/main`, fast-forward the main repo, rebase every worktree branch on `origin/main`, and re-init submodules in all worktrees (main repo included). Skips worktrees already merged or in a dirty state. |
| `vw ship-all` | Ship every worktree sequentially: commit any uncommitted submodule work on a feature branch, merge each submodule's feature branch into its `main` and push, bump submodule pointers in the parent, and push the parent branch to `origin/main`. Runs `ship-ready` at the end. |
| `vw ship-ready` | Scan all worktrees; for every branch already in `origin/main`, run `vw done`. Runs `vw sync` at the end. |

The Claude Code prompt baked into `vw new` tells the agent to commit
everything locally — feature branch + commits inside each touched submodule,
plus a "Bump submodules" commit in the parent worktree — and then stop. No
merge to main, no push, no PRs. Run `vw ship-all` from the main repo when
you're ready to ship one or more worktrees.

## `run_migration.sh`

Run database migrations against the production AWS RDS instance for a given
service. Temporarily opens the RDS security group to your public IP, runs the
service's `scripts/run_migrations.py`, then revokes the ingress rule on exit.

```sh
./scripts/run_migration.sh <pms|booking|marketplace|auth>
```

Requires AWS CLI credentials, `infra/terraform.tfvars` (DB passwords), and
Python 3 with `asyncpg`.

## Seed scripts

Populate local databases with mock data for development. All seed scripts
default to `localhost` Postgres URLs; override via `DATABASE_URL`,
`AUTH_DATABASE_URL`, `PMS_DATABASE_URL` env vars.

| Script | Purpose |
| --- | --- |
| `seed_users.py` | Seeds the shared auth DB with the admin user and mock hotel/creator accounts. **Run this first.** |
| `seed_marketplace.py` | Seeds the marketplace DB with profiles, listings, collaborations, chats, and reviews. |
| `seed_booking.py` | Seeds the booking-engine DB (hotel properties, translations) and the PMS DB (hotels, room types, sample bookings). |
| `seed_all.py` | Runs the three above in order (`users → marketplace → booking`) and prints credentials at the end. |

```sh
python scripts/seed_all.py
```

Default credentials after seeding:

- Admin: `admin@vayada.com` / `Vayada123`
- Hotels: `hotel[1-5]@mock.com` / `Test1234`
- Creators: `creator[1-4]@mock.com` / `Test1234`
