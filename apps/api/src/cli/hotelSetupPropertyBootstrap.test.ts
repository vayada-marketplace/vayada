import { expect, it, vi } from "vitest";
import { runHotelSetupPropertyBootstrap } from "./hotelSetupPropertyBootstrap.js";
import * as staging from "../hotelSetupPropertyRoleStaging.js";
import * as activation from "../hotelSetupPropertyRoleActivation.js";

it("refuses execution outside the fixed operational root before staging or activation", async () => {
  const stage = vi.spyOn(staging, "stageHotelSetupPropertyRole");
  const activate = vi.spyOn(activation, "activateVerifiedHotelSetupPropertyRole");
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(await runHotelSetupPropertyBootstrap({})).toBe(1);
    expect(stage).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        status: "FAIL",
        code: "hotel_setup_property_bootstrap_inspection_required",
      }),
    );
  } finally {
    vi.restoreAllMocks();
  }
});
