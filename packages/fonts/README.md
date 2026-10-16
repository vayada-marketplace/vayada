# @vayada/fonts

Self-hosted web fonts for the Next.js apps, loaded with `next/font/local`. No build and no browser
contacts Google Fonts (VAY-2216, VAY-2243, VAY-2225).

| Import                | What                                                                      | Used by                                                        |
| --------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `@vayada/fonts/brand` | `BRAND_FONT_PAIRINGS`, `brandFontPairing(id)`: the Design Studio pairings | booking-web (guests), Design Studio previews in the staff apps |
| `@vayada/fonts/ui`    | `uiFontFamily`: Inter, the apps' UI font                                  | root layouts of every Next.js app                              |

The values are CSS `font-family` strings. Set them with `style={{ fontFamily }}` (or as a CSS
variable).

## Files

`files/` holds the exact woff2 files Google Fonts served to next/font/google (same CSS query,
same browser string), so pages look the same as before. `files/SOURCES.txt` lists each file's
SHA-256 and Google URL. Each family is split into character subsets (latin, latin-ext, cyrillic,
...): every subset is its own `localFont` call with its `unicode-range`, and `fontStack()` chains
them in the order browsers tried Google's faces. Then comes next/font/google's metric-adjusted
fallback face from `src/fallbacks.css` (local Arial or Times New Roman, sized like the font): it
shows until a file arrives and for characters no subset covers. next/font/local would size that
fallback differently, so the calls turn theirs off.

`src/*.generated.ts`, `src/fallbacks.css`, `files/` and `licences/` are written by the sync
script (it needs the repo's node_modules). Change the script, not them:

```bash
node packages/fonts/scripts/sync-google-fonts.mjs
```

It is the only step that talks to Google, so run it on purpose (a new family or weight, or a new
upstream version), and check the screenshots of the affected pages.

## Licences

All families are under the SIL Open Font License 1.1, which allows bundling and redistributing
them with software. Each family's licence, with its copyright notice, is in `licences/`.
