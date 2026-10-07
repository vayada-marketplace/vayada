import { expect, it, vi } from "vitest";
import {
  hotelSetupBootstrapStagingSecret,
  runHotelSetupPropertyBootstrap,
} from "./hotelSetupPropertyBootstrap.js";
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

it.each([
  ["property_profile", { logoPassword: "p".repeat(48) }],
  ["property_logo", { logoPassword: "p".repeat(48) }],
  ["launch_settings", {}],
  ["currency_ready", {}],
] as const)("stages %s with the password only for actor-bound purposes", (operation, expected) => {
  expect(hotelSetupBootstrapStagingSecret(operation, "p".repeat(48))).toEqual(expected);
});
