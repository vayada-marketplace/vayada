# scripts

Helper scripts for the Vayada monorepo.

## `vw` — vayada worktree helper

Bash helper for running multiple Linear tickets in parallel via git worktrees.
Each ticket gets its own worktree at `~/git/vayada-<TICKET>` on a branch named
after the ticket, with submodules initialized and `.env` files copied from the
main repo. A new Warp tab opens running the configured agent with a 2-phase prompt
(plan → implement & commit). Merging into `main` and pushing is done later
by `vw ship-all`, not by the agent.

| Command | What it does |
| --- | --- |
| `vw new <TICKET> [--install]` | Create worktree on branch `<TICKET>` off `main`, init submodules, copy `.env` files, and open a Warp tab running the configured agent on the ticket. `--install` also runs `npm install` / `pip install` in submodules. Bare numbers are auto-prefixed (`vw new 295` → `VAY-295`). |
| `vw launch <TICKET>` | Re-open the configured agent in an existing worktree with the standard ticket prompt. Useful if the initial terminal/agent launch failed after `vw new` created the worktree. |
| `vw done <TICKET>` | Move the Linear ticket to **In Review**, deinit submodules, remove the worktree, and delete the local branch. |
| `vw list` (or `vw ls`) | List all active worktrees (`git worktree list`). |
| `vw sync` | Fetch `origin/main`, fast-forward the main repo, rebase every worktree branch on `origin/main`, and re-init submodules in all worktrees (main repo included). Skips worktrees already merged or in a dirty state. |
| `vw ship-all` | Ship every worktree sequentially: commit any uncommitted submodule work on a feature branch, merge each submodule's feature branch into its `main` and push, bump submodule pointers in the parent, and push the parent branch to `origin/main`. Runs `ship-ready` at the end. |
| `vw ship-ready` | Scan all worktrees; for every branch already in `origin/main`, run `vw done`. Runs `vw sync` at the end. |

The prompt baked into `vw new` tells the agent to commit
everything locally — feature branch + commits inside each touched submodule,
plus a "Bump submodules" commit in the parent worktree — and then stop. No
merge to main, no push, no PRs. Run `vw ship-all` from the main repo when
you're ready to ship one or more worktrees.

Agent launch is configurable through environment variables:

```sh
# Default behavior:
# - Codex when Warp is logged in as flamur.maliqi@nomerra.com
# - Codex launches through the codex-personal shell alias
# - Claude otherwise
vw new VAY-295

# One-time setup for the Vayada Linear account used by vw Codex sessions
vw linear-login

# Force Codex regardless of Warp account
VW_AGENT_CMD=codex-personal VW_AGENT_NAME=Codex vw new VAY-295

# Force Claude regardless of Warp account
VW_AGENT_CMD='claude --permission-mode auto' VW_AGENT_NAME=Claude vw new VAY-295

# Put the prompt in a specific position if your agent command needs it
VW_AGENT_CMD='codex-personal exec {prompt}' VW_AGENT_NAME=Codex vw new VAY-295

# Disable automatic agent launch for sync/ship failure recovery
VW_NO_AUTO_AGENT=1 vw ship-all
```

Defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VW_AGENT_CMD` | auto-detected | Command run with the generated prompt appended as the final argument. Include `{prompt}` to place the prompt manually. If unset, `vw` uses Codex for `VW_CODEX_WARP_EMAIL`, otherwise Claude. |
| `VW_AGENT_NAME` | inferred from `VW_AGENT_CMD` | Label used in `vw` log output. |
| `VW_CODEX_WARP_EMAIL` | `flamur.maliqi@nomerra.com` | Warp account email that should default to Codex. |
| `VW_CODEX_AGENT_CMD` | `codex-personal` | Codex command used by auto-detection. |
| `VW_CODEX_HOME` | `~/.codex-vayada` | Isolated Codex home used only when launching the raw `codex` binary instead of the `codex-personal` alias. |
| `VW_CODEX_LINEAR_EMAIL` | `f.maliqi@vayada.com` | Linear account the generated `vw` prompt requires before touching tickets. |
| `VW_CLAUDE_AGENT_CMD` | `claude --permission-mode auto` | Claude command used by auto-detection. |
| `VW_WARP_EMAIL` | unset | Override detected Warp email, mainly for testing. |
| `VW_WARP_SQLITE_PATH` | Warp stable SQLite path | Override Warp account database path. |
| `VW_TERMINAL_APP` | `Warp` | macOS terminal app opened via AppleScript. |
| `VW_NO_AUTO_AGENT` | unset | Set to `1` to disable automatic agent launch during failure recovery. Legacy `VW_NO_AUTO_CLAUDE=1` still works. |

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
