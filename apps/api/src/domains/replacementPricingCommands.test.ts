import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createReplacementPricingCommands } from "./replacementPricingCommands.js";

describe("replacement pricing authority pool", () => {
  it("fails closed without a dedicated authority pool", async () => {
    const general = { connect: vi.fn() } as unknown as Pool;
    const commands = createReplacementPricingCommands(general, null, null);
    const propertyId = "15430000-0000-4000-8000-000000000001";

    await expect(commands.readAuthority(propertyId)).rejects.toThrow(
      "Pricing authority database unavailable",
    );
    await expect(commands.chooseAuthority(propertyId, {})).rejects.toThrow(
      "Pricing authority database unavailable",
    );
    expect(general.connect).not.toHaveBeenCalled();
  });
});
