import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { agencyStayBase, agencyStayPathSlug, stayPath } from "./stayPath";

describe("stayPath", () => {
  it("leaves every path as it is on a hotel's own address", () => {
    for (const path of ["/", "/?checkIn=2026-12-01", "/book?offer=x", "/booking/VAY-1", "/#rooms"])
      expect(stayPath("", path)).toBe(path);
  });

  it("puts the stay's pages under the stay on an agency's address", () => {
    const base = "/stays/escape-villa";
    expect(stayPath(base, "/")).toBe("/stays/escape-villa");
    expect(stayPath(base, "/?checkIn=2026-12-01&adults=2")).toBe(
      "/stays/escape-villa?checkIn=2026-12-01&adults=2",
    );
    expect(stayPath(base, "/#rooms")).toBe("/stays/escape-villa#rooms");
    expect(stayPath(base, "/book?offer=x&step=extras")).toBe(
      "/stays/escape-villa/book?offer=x&step=extras",
    );
    expect(stayPath(base, "/booking/VAY-1/around")).toBe(
      "/stays/escape-villa/booking/VAY-1/around",
    );
    expect(stayPath(base, "/confirmation?booking=VAY-1&token=t")).toBe(
      "/stays/escape-villa/confirmation?booking=VAY-1&token=t",
    );
  });
});

describe("a stay's pages on its agency's address", () => {
  it("start under /stays/<slug>", () => {
    expect(agencyStayBase("escape-villa")).toBe("/stays/escape-villa");
    expect(stayPath(agencyStayBase("villa ü"), "/book?offer=x")).toBe(
      "/stays/villa%20%C3%BC/book?offer=x",
    );
  });

  it("are read back from the address, in any language", () => {
    for (const [pathname, slug] of [
      ["/stays/escape-villa", "escape-villa"],
      ["/de/stays/escape-villa/", "escape-villa"],
      ["/stays/escape-villa/book", "escape-villa"],
      ["/fr/stays/villa%20%C3%BC/booking/VAY-1/around", "villa ü"],
      ["/", null],
      ["/book", null],
      ["/booking/VAY-1", null],
      ["/stays", null],
      ["/stays/%E0%A4%A", null],
    ] as const)
      expect([pathname, agencyStayPathSlug(pathname)]).toEqual([pathname, slug]);
  });
});

// VAY-2462: a link to one of the stay's pages (its rooms, /book, its bookings) that skips
// `stayPath` would leave the agency's address for a page with no stay. Agency pages link to the
// address's own pages, and the bar's name to the address's home, so they are not the stay's; the
// server's crawl rules and the helper itself name the paths without linking to them.
const NOT_STAY_LINKS = new Set([
  "components/layout/BookingNavigation.tsx",
  "lib/agencyOverview.ts",
  "lib/stayPath.ts",
]);
const NOT_STAY_FOLDERS = ["components/agency/", "lib/server/"];
const SOURCE_FOLDERS = ["app", "components", "contexts", "lib"];
// A string or template starting with one of the stay's paths: "/", "/?…", "/#…", "/book…",
// "/booking/…", "/confirmation…", "/my-booking…".
const STAY_LITERAL =
  /([\w$.]*)\(?\s*(["'`])\/(?:(?:book|booking|confirmation|my-booking)\b|[?#]|(?=\2))/g;
// Reading the address is not linking to it.
const READS = new Set(["endsWith", "startsWith", "includes", "split", "test", "exec", "match"]);
// Comments name paths too; blanked out, keeping the lines where they are.
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

function sources(root: string, folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(root, path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the stay's links", () => {
  it("all go through stayPath", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const raw: string[] = [];
    const scanned: string[] = [];
    for (const file of SOURCE_FOLDERS.flatMap((folder) => sources(root, folder))) {
      const name = relative(root, join(root, file)).split("\\").join("/");
      if (NOT_STAY_LINKS.has(name) || NOT_STAY_FOLDERS.some((folder) => name.startsWith(folder)))
        continue;
      scanned.push(name);
      const text = readFileSync(join(root, file), "utf8").replace(COMMENTS, (comment) =>
        comment.replace(/[^\n]/g, " "),
      );
      // Booking Web compiles to ES5: no iterating matchAll.
      for (const match of Array.from(text.matchAll(STAY_LITERAL))) {
        const callee = match[1]!.split(".").pop()!;
        if (callee === "stayPath" || READS.has(callee)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        raw.push(`${name}:${line}: ${match[0].trim()}`);
      }
    }
    expect(scanned).toContain("app/[locale]/book/BookPageClient.tsx");
    expect(raw).toEqual([]);
  });
});
