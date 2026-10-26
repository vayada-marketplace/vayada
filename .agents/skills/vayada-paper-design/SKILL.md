---
name: vayada-paper-design
description: Use when a Vayada task touches the Paper design files. That means reading the current screens, drawing a new screen or visible layout change before building it (design first), or updating the "(current)" files after a release. Covers connecting to Paper, the file list, the rules and the capture pipeline.
---

# Paper design files for Vayada

Vayada's screens live in Paper (paper.design, the "vayada team"). Paper is the design reference for new UI work and should always match what is live.

## When this applies

1. **Design first:** for **new screens** and **visible layout changes**.
   - Draw the change in Paper and get Flamur's approval before building it.
   - Small fixes skip this: text, colours, spacing tweaks, bug fixes that keep the layout. (Decision by Flamur, 2026-10-14.)
2. **Keep Paper current:** after every release that changes what users see, update the matching boards in the "(current)" files. The coordinator runs this as one step per release.
3. **Reference only:** reading boards to understand the current design needs nothing special. Follow the rules below.

## Connecting

- Paper is an MCP server named `paper`. It is served by the Paper desktop app on Flamur's Mac at `http://127.0.0.1:29979/mcp`.
- It's registered at user scope for Claude Code and Codex by `~/toolbox/setup.sh`, so the tools are `mcp__paper__*`.
- It only works while the Paper app is open and logged into the **vayada team**.
- Before any other Paper call, load the guide: `get_guide({ topic: "paper-mcp-instructions" })`.
- If the tools are missing or answer "Could not find Paper" or "Open a Paper file", ask the coordinator. Flamur may need to open Paper, or run `/mcp` and reconnect `paper`.
  - Fallback client: `~/.local/share/vayada-testing/evidence/vay2124-paper-design-baseline-20261011/tools/pmcp.py` (`pmcp.py list` / `pmcp.py call TOOL '<json>'`).

## Files (vayada team)

| File                                | ID                           | Use                                             |
| ----------------------------------- | ---------------------------- | ----------------------------------------------- |
| Vayada – PMS (current)              | `01M4P6883NWXQ3NZQH72641281` | Live pms-web screens                            |
| Vayada – Marketplace (current)      | `01M4PD3M0GG33VB5PFSHM16AVA` | Live marketplace-web screens, incl. setup       |
| Vayada – Booking admin (current)    | `01M4PCG09QJZDYNPSHBHFQ2N9Y` | Live booking-admin screens                      |
| Vayada – Booking page (current)     | `01M4P9PCY5DXXM903P18YPF8Q4` | Live booking-web screens (1440 + 390)           |
| Vayada – Admin (current)            | `01M4PCN47ESSNZK0D63W2C5PCT` | Live vayada-admin screens                       |
| Vayada – Landing (current)          | `01M4PCN7MDRBQR91JD3GTE9SBA` | Live landing screens                            |
| Vayada – Design system (current)    | `01M4P7X8T4JMNWQBB5QX5M00MF` | Colours, type, components, tokens               |
| Vayada – Hotel onboarding (current) | `01M4SXTNVMQVNXK813D1ZAVVYB` | Sign up → setup → after setup, in journey order |
| Vayada – Prices tab redesign        | `01M4P4VKZMJ4N5EFSEAR36YBEG` | Approved design (VAY-2125). Never edit.         |

`list_resources` shows every file, with `open` and `active` flags for the tabs open in the app.

## Rules

- **One Paper file open at a time.** Each open tab holds 2–5 GB of RAM on a 16 GB Mac; seven open tabs crashed it once.
  - Check `list_resources` before `open_file` or `create_file`, and use the file that is already open when it's the right one.
  - The MCP cannot close tabs. When you're done, tell the coordinator which file to close so Flamur can close the tab. Never quit Paper.
- **Made-up data only.** Use e2e mocks or invented content (e.g. "Hotel Alpenrose, Munich", `@example.com`). Never real hotels, guests, bookings, emails or payment data, and never copy from logged-in production pages.
- **Never edit an approved design.** To show a variant, duplicate the artboard and change the copy.
- **Never delete boards without approval.** When replacing a "(current)" board, keep its name and position, and record old → new node ids in your evidence folder.
- **Naming:** one artboard per screen, named after its route. Use `–` for a tab and `·` for a state, e.g. `/rooms/[id] – Prices · no prices yet`. Desktop boards are 1440 wide; guest-facing booking-web screens also get a 390 version.
- Call `finish_working_on_nodes` when you finish. Take a screenshot of each board you wrote and compare it with its reference.

## Design-first workflow (new screens and visible layout changes)

1. Find the current board(s) in the matching "(current)" file. If the screen is new, start from the closest existing screen and the Design system file.
2. Draw the proposal in **"Vayada – Proposals"**, one page per ticket named `VAY-NNN <short title>`.
   - Create that file the first time it's needed, and only then.
   - Duplicate the current boards, then change them. Use the design-system colours and fonts and the real copy you plan to ship.
3. Put screenshots of the proposal boards (plus the Paper link) in your SUPERSET_WORKER_PLAN or Linear comment, and **STOP for Flamur's approval**. Approval can come with changes; update the boards and ask again.
4. Build to match the approved boards. In the PR description, include the board names and before/after screenshots of the real app.
5. After the release, the coordinator copies the shipped screen into the "(current)" file (next section). The proposal page stays as the record.

## Keeping the "(current)" files up to date (one step per release)

After each release that changes visible UI:

1. List the changed routes and states from the release's merged PRs. A PR that changes visible UI should name its screens in its description.
2. Capture them at the released commit with the existing pipeline, on the cloud worker, with mocked data and a frozen clock. Tools:
   - `~/.local/share/vayada-testing/evidence/vay2124-paper-design-baseline-20261011/tools/`: `capture.ts`, `serialize.js`, `to_paper.py`, `paper_write.py`, `app_tokens.py`.
   - `~/.local/share/vayada-testing/evidence/vay2146-paper-gaps-20261012/tools/`: `write_states.py`, `layout_rows.py`, `fix_ledger.py`, `find_strays.py`, `compare_manifest.py` and `ledger.json`, the board ledger.
   - `~/.local/share/vayada-testing/evidence/vay2151-onboarding-paper-20261013/workspace-zz-paper/`: the Playwright capture helper (`capture.ts`, `serialize.js`). It goes under `tests/e2e/zz-paper/` in a workspace and is never committed.
3. Compare each capture with the existing board. Replace only boards whose visible content changed, keeping name and position, and update the ledger. Add boards for new screens or states in the right row.
4. Open only the file you're updating, and report which file to close.

## Paper quirks (save yourself a retry)

`write_html` reports success but creates nothing (`createdNodes: []`) in two cases:

- the top-level element is `position:absolute`. Insert it unpositioned, then `update_styles` the position;
- the frame is empty and unpainted. Add a 1px placeholder child and delete it afterwards.

Other behaviour:

- `create_artboard` ignores `left`/`top`. Move the board afterwards with `update_styles` and check with `get_node_info` (worldX/worldY).
- A new file has no design tokens; run the token setup (`app_tokens.ensure`) before writing boards.
- `create_page` inserts the page after the active one; fix the order with `rename_pages`.
- Quote font names containing digits (`'Source Sans 3'`). Edge spaces in text are trimmed, so use NBSP.
- `get_screenshot` caps at 2000 px. `export` writes full-size PNGs to `~/Downloads`; move them to your evidence folder right away.
- "disconnected from the server", "Could not find Paper" and "Open a Paper file" are usually transient: retry with a 15 s backoff.
- Write in chunks of about 250 layers.
