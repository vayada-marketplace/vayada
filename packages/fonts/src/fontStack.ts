type NextFont = { style: { fontFamily: string } };

/**
 * One CSS font-family value from a family's per-subset next/font/local fonts, in the order the
 * browser tried Google's faces (latin first), then next/font/google's metric-adjusted fallback
 * (fallbacks.css) and the generic family. The subset fonts have no fallback of their own, so a
 * fallback never covers characters that a later subset has.
 */
export function fontStack(fonts: NextFont[], fallback: string, generic: string | null) {
  return [...fonts.map((font) => font.style.fontFamily), `"${fallback}"`, generic]
    .filter(Boolean)
    .join(", ");
}
