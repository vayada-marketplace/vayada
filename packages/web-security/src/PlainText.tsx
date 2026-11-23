/**
 * VAY-2516: text vayada did not write (AI answers, guest messages shown by the assistant) appears as
 * plain text only. React escapes it, so no HTML runs; nothing becomes a link, an image or formatting;
 * line breaks stay. Never pass such text to dangerouslySetInnerHTML or a Markdown renderer.
 */
export function PlainText({ text, className }: { text: string; className?: string }) {
  return (
    <div
      dir="auto"
      className={className}
      style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
    >
      {toPlainText(text)}
    </div>
  );
}

/**
 * Removed: control characters (except tab and line break); bidi embeddings, overrides and isolates,
 * which can make text read differently from what it says; and invisible characters that can hide
 * text: zero-width space, soft hyphen, word joiners and invisible operators, Hangul fillers, the
 * Mongolian vowel separator and Unicode tag characters (U+E0000 to U+E007F). Joiners and the
 * left/right marks stay: emoji and many scripts need them.
 */
const HIDDEN_OR_REORDERING =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u115F\u1160\u180E\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]|\uDB40[\uDC00-\uDC7F]/g;

export function toPlainText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(HIDDEN_OR_REORDERING, "");
}
