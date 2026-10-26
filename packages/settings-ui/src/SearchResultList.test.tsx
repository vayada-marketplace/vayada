import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SearchResultList, type SearchResult } from "./SearchResultList";

const results: SearchResult[] = [
  { id: "dashboard", label: "Dashboard", category: "Pages", kind: "dashboard", href: "/" },
  {
    id: "payments",
    label: "Payment Settings",
    description: "Guest payment methods and bank transfer details",
    category: "Settings",
    kind: "setting",
    href: "/settings/payments",
  },
  { id: "rules", label: "Booking rules", category: "Settings", kind: "setting", href: "/rules" },
];

const render = (activeIndex: number) =>
  renderToStaticMarkup(
    <SearchResultList
      id="search"
      label="Pages and settings"
      results={results}
      categoryLabel={(category) => category.toUpperCase()}
      activeIndex={activeIndex}
      onActiveChange={() => {}}
    />,
  );

describe("SearchResultList", () => {
  it("starts each category run with one header and shows descriptions", () => {
    const markup = render(0);
    expect(markup.match(/>PAGES</g)).toHaveLength(1);
    expect(markup.match(/>SETTINGS</g)).toHaveLength(1);
    expect(markup).toContain("Guest payment methods and bank transfer details");
    expect(markup).toContain('href="/settings/payments"');
  });

  it("marks only the active option and gives it the Enter hint", () => {
    const markup = render(1);
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toMatch(/id="search-1"[^>]*aria-selected="true"/);
    expect(markup.match(/↵/g)).toHaveLength(1);
  });

  it("draws the tile colour of each kind", () => {
    const markup = render(0);
    expect(markup).toContain("bg-violet-50 text-violet-500");
    expect(markup).toContain("bg-amber-50 text-amber-500");
  });
});
