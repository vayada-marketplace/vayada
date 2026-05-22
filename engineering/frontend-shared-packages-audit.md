# Frontend Shared Packages — Audit

Step 1 of VAY-466. Identifies concrete duplication across the 7 frontend apps so extraction can be ordered by **duplication × low coupling** rather than by guess.

Snapshot: 2026-05-22.

## Method

For each app under `apps/*-web|admin|dashboard|landing`, surveyed:

- Top-level config files (`tsconfig`, `postcss`, `tailwind`, `next.config`).
- `lib/` contents (`utils/`, `constants/`, `types/`, app-specific).
- `services/api/` and `services/auth/`.
- `components/` top-level subdirectories.

Concrete byte-level diffs were taken for the highest-confidence candidates.

## Tier 1 — Trivial extractions (100% identical, zero coupling)

These can move out without introducing a `@vayada/*` workspace package — they're root-level config that each app `extends`. No Docker change required.

| File                | Apps  | Diff status          | Target                                                                                           |
| ------------------- | ----- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `tsconfig.json`     | All 7 | Byte-identical       | Root `tsconfig.base.json`; each app's tsconfig becomes `{"extends": "../../tsconfig.base.json"}` |
| `postcss.config.js` | All 7 | Whitespace-only diff | Single root `postcss.config.js` (Next.js resolves up the tree)                                   |

Recommended **first extraction** for VAY-466: `tsconfig.json`. Smallest possible diff, zero package machinery, validates the pattern.

## Tier 2 — Byte-identical duplicate files between specific apps

These are concrete duplicates that prove the "split apps drift independently" risk is real today.

| File                           | Apps                     | Status                           |
| ------------------------------ | ------------------------ | -------------------------------- |
| `services/api/client.ts`       | marketplace-web, landing | Identical (246 lines, zero diff) |
| `lib/parseBookingAmenities.ts` | booking-admin, pms-web   | Identical                        |

Both are the strongest signal in the audit. `client.ts` between marketplace-web and landing especially: landing was split from marketplace-web and the API client never diverged.

## Tier 3 — Same filename, probable content overlap

Concrete duplicates likely 80–100% the same; need a per-file diff before extraction.

| File                                                     | Apps                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `lib/utils/getCurrencySymbol.ts`                         | marketplace-web, marketplace-admin, landing                                  |
| `lib/utils/accessControl.ts`                             | marketplace-web, landing                                                     |
| `lib/utils/months.ts`                                    | marketplace-web, landing                                                     |
| `lib/utils/profileStatus.ts`                             | marketplace-web, landing                                                     |
| `lib/utils/colors.ts`                                    | booking-web, booking-admin                                                   |
| `lib/utils/setupStatus.ts`                               | booking-admin, pms-web                                                       |
| `lib/utils/uploadImage.ts`                               | marketplace-admin, booking-admin                                             |
| `lib/constants/options.ts`                               | marketplace-web, marketplace-admin, booking-admin, pms-web, landing (5 apps) |
| `lib/constants/booking.ts`                               | marketplace-admin, booking-web                                               |
| `lib/constants/countries.ts`                             | booking-web, pms-web                                                         |
| `lib/constants/branding.ts`                              | marketplace-admin, booking-admin                                             |
| `lib/constants/{colors,content,routes,sections,storage}` | marketplace-web, landing                                                     |

## Tier 4 — Structural duplication (bigger payoff, more risk)

Same subdirectory exists across many apps; content varies by per-app theme/design tokens. Worth extracting but needs careful design:

| Subdir                | Apps                                                                                      | Notes                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `components/ui/`      | marketplace-web, marketplace-admin, booking-admin, landing                                | Likely shadcn-style primitives. Strongest candidate for a `@vayada/ui` package.                 |
| `components/auth/`    | marketplace-web, marketplace-admin, booking-admin, pms-web, affiliate-dashboard (5 apps)  | Login / register forms. Share if the auth flow is consistent; otherwise a hook + headless API.  |
| `components/layout/`  | marketplace-web, marketplace-admin, booking-web, booking-admin, pms-web, landing (6 apps) | Navigation/Footer; CLAUDE.md notes marketplace ↔ landing duplication is intentionally deferred. |
| `components/consent/` | marketplace-web, landing                                                                  | GDPR/cookie banner — clearly shared.                                                            |
| `components/landing/` | marketplace-web, landing                                                                  | Effectively the same surface.                                                                   |

## Tier 5 — Setup wizard (biggest single duplication target)

`booking-admin/components/setup/` and `marketplace-admin/components/setup/` are a forked-and-drifted copy of the same hotel-configuration wizard. Both consume the same component names with the same exported types (`RoomType`, `SetupAddon`, `LastMinuteConfig`) and helpers (`createEmptyRoom`, `createEmptyAddon`, `createEmptyLastMinuteConfig`) — the interface was already designed for reuse; the implementations got copied and diverged.

Usage:

- `apps/booking-admin/app/setup/page.tsx` — hotel configures itself.
- `apps/marketplace-admin/app/dashboard/invite-codes/page.tsx` — Vayada admin pre-configures via invite code.

| Step             | booking-admin | marketplace-admin | diff lines |
| ---------------- | ------------- | ----------------- | ---------- |
| `RoomsStep`      | 2299          | 1654              | 1009       |
| `PropertyStep`   | 590           | 589               | 186        |
| `PoliciesStep`   | 574           | 518               | 159        |
| `AddonsStep`     | 467           | 458               | 140        |
| `BrandMediaStep` | 371           | 391               | 64         |
| `LastMinuteStep` | 262           | 262               | 12         |
| `BenefitsStep`   | 162           | 162               | 12         |

~4700 lines of wizard code with ~1500 lines of accumulated drift. Bugs fixed on one side don't propagate. **This is the largest single concentration of avoidable duplication in the frontend codebase.**

`booking-admin` has 2 steps `marketplace-admin` doesn't import (`PmsStep`, `PromoCodesStep`); those are app-specific by design (PMS auth, hotel-owned promo codes).

Target package: `@vayada/hotel-setup-wizard` exporting the shared 7 steps + types + helpers. Consumers pass app-specific behavior (submit handler, initial data source) as props. The two extra booking-admin steps stay in booking-admin.

Risk: highest of any tier, because the components have drifted — extraction needs a careful merge of the drift, not a blind move. But the size of the drift is exactly why this is worth doing soon: another month of independent edits and the merge gets harder.

## Non-duplications worth noting

- **`apps/pms-web/app/setup/page.tsx`** — 30-line redirect that bounces hotel admins to `booking-admin /setup` when PMS isn't set up. Not duplication; leave it.
- **`apps/*/(app)/settings/page.tsx`** — each app's settings page is unique to that app's surface area; nothing to share.
- **`apps/marketplace-web/app/settings/`** — GDPR-specific pages (privacy, data-export, delete-account, newsletter). Could theoretically share with `affiliate-dashboard` later, but small payoff today.

## Recurring observation: marketplace-web ≈ landing

`landing` was split out of `marketplace-web` and the two still share:

- `tsconfig.json` (Tier 1 — universal)
- `services/api/client.ts` (Tier 2 — byte-identical)
- `lib/utils/{accessControl, getCurrencySymbol, months, profileStatus}.ts` (Tier 3)
- `lib/constants/{colors, content, options, routes, sections, storage}.ts` (Tier 3)
- `components/consent/`, `components/landing/`, `components/ui/` (Tier 4)

A `@vayada/marketplace-shared` package would absorb almost all of this. **This is the highest-value single package extraction in the audit.**

## Recommended extraction order

1. **`tsconfig.json` → `tsconfig.base.json` at root.** No package needed. Validates the "extend from root" pattern.
2. **`postcss.config.js` → single root file.** Same pattern.
3. **`packages/marketplace-shared`** — absorb the marketplace-web ↔ landing duplication. First real workspace package. Validates the Docker workspace-deps problem on a single app pair.
4. **`packages/hotel-setup-wizard`** — extract the 7 shared wizard steps + types + helpers used by both `booking-admin /setup` and `marketplace-admin /dashboard/invite-codes`. **Highest-leverage extraction**: ~4700 lines of duplicate, actively drifting code. Must reconcile the drift during extraction (not a blind move).
5. **`packages/booking-shared`** for booking-web ↔ booking-admin overlap (`lib/utils/colors.ts`, `lib/constants/booking.ts`).
6. **`packages/ui`** — shadcn-style primitives from `components/ui/`. Touches 4 apps; biggest design-token coupling.
7. **`packages/auth-ui`** — login/register UI if forms can be unified. Touches 5 apps.
8. **`packages/common-utils`** — pure utilities that appear in 3+ apps and have no app-specific logic (`getCurrencySymbol`, `months`, etc.).

Each step is one PR. Steps 1–2 don't change the Docker build at all. Step 3 is where the Docker workspace-deps problem must be solved; once solved, 4–8 are mechanical.

Step 4 (setup wizard) is the highest-leverage by line count and drift cost. Order 1→2→3 first only because each successive step needs the previous problem solved (Docker workspace-deps in step 3). Once that pattern is in place, step 4 is the biggest single payoff.

## Out of scope for the audit

- Diffing app-by-app content for Tier 3 files. That belongs in the extraction PR.
- Component-level deduplication inside `components/marketplace/`, `components/booking-flow/`, etc. — those are app-specific by design.
- Backend duplication (FastAPI apps). Separate concern.

## Update — dependency-graph complications discovered during step 4

While starting the setup-wizard extraction, the audit's "just move the 7 step files" framing turned out to undersell the work. Each extraction has a dependency tail:

- **Setup wizard steps** import from `@/lib/parseBookingAmenities` (booking-admin only), `@/lib/utils` barrel (booking-admin only), `@/components/ui/ToggleSwitch` (booking-admin only), `@/lib/constants/options`, `@/lib/constants/branding`, `@/lib/utils/uploadImage`, `@/lib/utils/getCurrencySymbol`. Each of those has its own per-app version with drift. Moving the wizard requires moving (or refactoring against props) the whole dependency subgraph.
- **`getCurrencySymbol`** is byte-identical between marketplace-web and landing but differs from marketplace-admin (Unicode escapes vs literal chars; marketplace-admin lacks the `CURRENCY_OPTIONS` export the longer version provides). Extraction means deciding which characters/escapes win and where `CURRENCY_OPTIONS` stays.
- **`lib/constants/options.ts`** (5 apps): each app likely has subtly different option arrays. Extraction-as-canonical requires understanding which options are actually needed where.

These are real product decisions, not mechanical moves. The audit's "Tier 3/4/5 extractions are mechanical after step 3" claim was too optimistic — they're each individually a small reconciliation project.

Implication for ordering: steps 5+ should each get their own Linear ticket with the dependency graph noted, the drift decisions surfaced, and a deliberate canonical-winner pick before the actual extraction. Bundling them into one session is how silent feature regressions happen.
