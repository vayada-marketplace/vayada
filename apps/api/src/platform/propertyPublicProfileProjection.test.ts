import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { projectPropertyPublicProfile } from "./propertyPublicProfileProjection.js";

const propertyId = "f8013000-0000-0000-0000-000000000001";

describe("public property profile projection", () => {
  it("re-projects the canonical public profile of a property that has a slug", async () => {
    const statements: string[] = [];
    const client = {
      async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<{ rows: T[] }> {
        statements.push(text);
        if (text.includes('property.display_name AS "displayName"')) {
          return {
            rows: [
              {
                propertyId,
                publicId: "prop_alpenrose",
                displayName: "Hotel Alpenrose",
                defaultLocale: "en",
                canonicalSlug: "hotel-alpenrose",
              },
            ] as unknown as T[],
          };
        }
        return { rows: [] };
      },
    };

    await projectPropertyPublicProfile(client, { propertyId });

    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain("property_public_profile_read_model");
    expect(statements.join("\n")).not.toContain("marketplace.");
  });

  it("does nothing for an unknown property", async () => {
    const statements: string[] = [];
    const client = {
      async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<{ rows: T[] }> {
        statements.push(text);
        return { rows: [] };
      },
    };

    await projectPropertyPublicProfile(client, { propertyId });

    expect(statements).toHaveLength(1);
  });
});
