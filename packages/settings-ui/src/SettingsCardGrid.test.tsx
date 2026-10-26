import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";
import { SettingsCardGrid } from "./SettingsCardGrid";

const Icon = ({ className }: { className?: string }) => <svg className={className} />;

describe("SettingsCardGrid", () => {
  it("links every card with a page and marks the rest as coming soon", () => {
    const markup = renderToStaticMarkup(
      <SettingsCardGrid
        featured={{
          title: "Feature Hub",
          description: "Modules",
          icon: Icon,
          href: "/settings/feature-hub",
        }}
        cards={[
          { title: "Property", description: "Timezone", icon: Icon, href: "/settings/property" },
          { title: "Account", description: "Email", icon: Icon },
        ]}
        openLabel="Open"
        comingSoonLabel="Coming soon"
      />,
    );

    expect(markup).toContain('href="/settings/feature-hub"');
    expect(markup).toContain('href="/settings/property"');
    expect(markup.match(/>Open</g)).toHaveLength(2);
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("Coming soon");
    expect(markup).toContain("lg:grid-cols-3");
  });
});

describe("SettingsBreadcrumb", () => {
  it("leads back to the card grid and marks the current page", () => {
    const markup = renderToStaticMarkup(
      <SettingsBreadcrumb settingsLabel="Settings" ariaLabel="Breadcrumb" current="Property" />,
    );

    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain('href="/settings"');
    expect(markup).toMatch(/aria-current="page"[^>]*>Property</);
  });
});
