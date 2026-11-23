import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlainText, toPlainText } from "./PlainText";

const char = (code: number) => String.fromCharCode(code);

describe("PlainText", () => {
  it("shows HTML as text instead of running it", () => {
    const markup = renderToStaticMarkup(
      <PlainText text={'<img src=x onerror="alert(1)"><script>alert(2)</script>'} />,
    );
    expect(markup).toContain("&lt;img src=x onerror=");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toMatch(/<img|<script/);
  });

  it("makes no links or images out of URLs and Markdown", () => {
    const markup = renderToStaticMarkup(
      <PlainText text="See https://evil.example/x and [click](https://evil.example) ![](https://evil.example/p.png)" />,
    );
    expect(markup).toContain("[click](https://evil.example)");
    expect(markup).not.toMatch(/<a\b|<img\b|href=/);
  });

  it("keeps line breaks and sets the text direction from the text", () => {
    const markup = renderToStaticMarkup(<PlainText text={"Hi Anna,\r\n\r\nSee you tonight."} />);
    expect(markup).toContain("Hi Anna,\n\nSee you tonight.");
    expect(markup).toContain("white-space:pre-wrap");
    expect(markup).toContain('dir="auto"');
  });
});

describe("toPlainText", () => {
  it("removes bidi overrides, isolates, zero-width spaces and control characters", () => {
    const text = `Pay ${char(0x202e)}0001${char(0x202c)} EUR${char(0x200b)} now${char(0x2066)}!${char(0x2069)}${char(0x7)}${char(0xfeff)}`;
    expect(toPlainText(text)).toBe("Pay 0001 EUR now!");
  });

  it("removes characters that hide text: soft hyphens, Hangul fillers and Unicode tags", () => {
    const tag = (code: number) => char(0xdb40) + char(0xdc00 + code);
    const hidden = `${tag(0x69)}${tag(0x67)}${tag(0x6e)}${tag(0x6f)}${tag(0x72)}${tag(0x65)}`;
    const text = `Ap${char(0xad)}prove${char(0x3164)}${char(0x115f)}${char(0x180e)}${hidden}`;
    expect(toPlainText(text)).toBe("Approve");
  });

  it("keeps tabs, line breaks, joiners and left/right marks", () => {
    const family = `${char(0xd83d)}${char(0xdc69)}${char(0x200d)}${char(0xd83d)}${char(0xdc67)}`;
    const text = `a\tb\nc ${family} ${char(0x200c)}${char(0x200e)}${char(0x200f)}`;
    expect(toPlainText(text)).toBe(text);
  });
});
