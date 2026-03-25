# Vayada Monorepo

## Worktree Workflow

When the user pastes ticket content and says "create worktree" (or similar):

1. Extract the ticket ID from the content (e.g. VAY-123)
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
