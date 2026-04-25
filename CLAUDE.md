# vayada Monorepo

## Worktree Workflow

When the user pastes ticket content and says "create worktree" (or similar):

1. Extract the ticket ID from the content (e.g. VAY-123). If no ticket ID is found, generate a short kebab-case slug from the context/input (e.g. `fix-currency-display`, `add-room-photos`). Use this slug in place of the ticket ID for all subsequent steps.
2. Create a git worktree:
   ```
   git worktree add ../vayada-<TICKET-ID> -b feature/<ticket-id-lowercase>
   ```
3. Init submodules:
   ```
   git -C ../vayada-<TICKET-ID> submodule update --init --recursive
   ```
4. Tell the user to open a new terminal tab and run:
   ```
   cd ~/git/vayada-<TICKET-ID> && claude --enable-auto-mode
   ```
5. Summarize the ticket so the user can paste it into the new Claude session as context.

When the user asks to clean up a worktree:
1. `git worktree remove ../vayada-<TICKET-ID>`
2. Optionally delete the branch if merged: `git branch -d feature/<ticket-id-lowercase>`

## Local Integration Testing

Use `scripts/integrate` and `scripts/integrate-reset` to Docker-test multiple in-flight feature worktrees together in the main worktree without merging anything to main. The branch `local-integration` is a throwaway sandbox — never push it.

Both scripts must run from `~/git/vayada` (the main worktree). They will refuse to run from a feature worktree.

When the user says "integrate worktree <TICKET-ID>" / "test feature <TICKET-ID>" / "stack <TICKET-ID>" / "add <TICKET-ID> to integration" (or similar):
```
cd ~/git/vayada
./scripts/integrate <TICKET-ID>
```
Then tell the user to rebuild Docker (`docker compose up --build`) to pick up the changes. Repeat for each feature you want stacked together — conflicts surface here, which is useful signal.

When the user says "reset integration" / "wipe integration" / "clean integration" / "back to main" (or similar):
```
cd ~/git/vayada
./scripts/integrate-reset
```
This resets parent + all submodules to `origin/main` and deletes `local-integration` everywhere. Feature worktrees are untouched.

When the user says "integrate all worktrees" / "test all features" / "pull all worktrees" / "fresh stack" / "reload everything" (or similar):
```
cd ~/git/vayada
./scripts/integrate-all
```
This resets the sandbox, integrates every active feature worktree onto `local-integration`, and brings the Docker stack up with `docker compose up -d --build`. Use this for "give me a fresh integration env with everything that's currently in flight." If a single worktree's merge conflicts, the script halts before the Docker step — resolve and re-run.

Notes:
- The integrate script reads feature branches directly from each `../vayada-<TICKET>` worktree, so feature branches don't need to be pushed to origin first.
- The script refuses if the parent worktree has uncommitted changes — commit, stash, or reset first.
- Re-running `integrate <TICKET>` after the feature worktree gets new commits will pull in those new commits.

## Merge & Ship Worktree

When the user says "merge worktree" / "ship worktree" / "finish worktree" (or similar) for a given `<TICKET-ID>`:

1. **Identify changed submodules** in the worktree:
   ```
   git -C ../vayada-<TICKET-ID> diff --name-only HEAD main -- | grep /
   ```
   Cross-reference with `git -C ../vayada-<TICKET-ID> submodule status` to find which submodules have new commits on the feature branch.

2. **For each changed submodule**, merge the feature branch into its main branch:
   ```
   cd <submodule-path>                         # inside the worktree
   git checkout main
   git merge feature/<ticket-id-lowercase> --no-ff -m "Merge feature/<ticket-id-lowercase> into main"
   git push origin main
   cd -
   ```
   If the merge has conflicts, stop and ask the user to resolve them before continuing.

3. **Update the parent repo** to point to the new submodule commits:
   ```
   cd ~/git/vayada                             # back in the main worktree
   git submodule update --remote --merge        # pull latest main for each submodule
   git add -A
   git commit -m "Update submodules: merge feature/<ticket-id-lowercase>"
   git push origin main
   ```

4. **Clean up the worktree and branch**:
   ```
   git worktree remove ../vayada-<TICKET-ID>
   git branch -d feature/<ticket-id-lowercase>
   ```
   Also delete the remote feature branch in each submodule that had one:
   ```
   git -C <submodule-path> push origin --delete feature/<ticket-id-lowercase>
   ```

5. Confirm to the user that everything has been merged, pushed, and cleaned up.

## Merge & Ship ALL Worktrees

When the user says "merge all worktrees" / "ship all" / "finish all worktrees" (or similar):

1. **List all active worktrees** (excluding the main one):
   ```
   git worktree list
   ```
   Filter out the main worktree (`~/git/vayada`). The remaining entries are feature worktrees. Extract each `<TICKET-ID>` from the worktree path (e.g. `../vayada-VAY-123` → `VAY-123`).

2. **Show the user a summary** of all worktrees that will be merged and ask for confirmation before proceeding.

3. **For each worktree**, run the full "Merge & Ship Worktree" flow (steps 1–4 from above), but **defer the parent repo push** — only do the submodule merges and pushes per worktree.

4. **After all worktrees are processed**, do a single parent repo update:
   ```
   cd ~/git/vayada
   git submodule update --remote --merge
   git add -A
   git commit -m "Update submodules: merge all feature branches"
   git push origin main
   ```

5. **Clean up all worktrees and branches** that were successfully merged. Skip any that had conflicts (those should have been flagged to the user during step 3).

6. Print a final summary listing which worktrees were merged successfully and which (if any) were skipped due to conflicts.
