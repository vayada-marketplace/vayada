import { describe, expect, it, vi } from "vitest";

import {
  normalizePropertyDescription,
  propertyDescriptionLength,
  savePropertyDescription,
} from "./propertyDescription";

const profile = (revision: number, shortDescription: string | null) => ({
  propertyId: "property-1",
  profileRevision: revision,
  publicProfile: { locale: "en", shortDescription, longDescription: null, media: [] },
});

describe("property description", () => {
  it("follows setup's 50–500 character rule", () => {
    expect(normalizePropertyDescription("Too short.")).toBeNull();
    expect(normalizePropertyDescription("")).toBeNull();
    expect(normalizePropertyDescription("x".repeat(501))).toBeNull();
    // 480 characters, but 520 UTF-16 units: the profile API would reject it.
    expect(normalizePropertyDescription("x".repeat(440) + "🏔".repeat(40))).toBeNull();
    const text = "A family-run alpine hotel in the heart of Munich, near the old town.";
    expect(normalizePropertyDescription(`  ${text}  `)).toBe(text);
    expect(propertyDescriptionLength(`  ${text}  `)).toBe(text.length);
  });

  it("saves against the current profile revision", async () => {
    const api = {
      getPublicPropertyProfile: vi.fn().mockResolvedValue(profile(7, "Old text")),
      updatePublicPropertyProfile: vi.fn().mockResolvedValue(profile(8, "New text")),
    };
    await expect(savePropertyDescription(api, "property-1", "New text")).resolves.toBe("New text");
    expect(api.updatePublicPropertyProfile).toHaveBeenCalledWith("property-1", {
      expectedProfileRevision: 7,
      patch: { shortDescription: "New text" },
    });
  });

  it("writes nothing when the text is unchanged", async () => {
    const api = {
      getPublicPropertyProfile: vi.fn().mockResolvedValue(profile(7, "Same text")),
      updatePublicPropertyProfile: vi.fn(),
    };
    await expect(savePropertyDescription(api, "property-1", "Same text")).resolves.toBe(
      "Same text",
    );
    expect(api.updatePublicPropertyProfile).not.toHaveBeenCalled();
  });
});
