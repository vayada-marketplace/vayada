import { describe, expect, it } from "vitest";

import { getStatusClasses, getStatusStyle, STATUS_STYLES } from "./colors";

describe("collaboration status colours", () => {
  it("shows active in accepted's green and rejected in declined's red", () => {
    expect(getStatusClasses("active")).toBe(getStatusClasses("accepted"));
    expect(getStatusClasses("Rejected")).toBe(getStatusClasses("declined"));
    expect(getStatusStyle("active")).toEqual(STATUS_STYLES.accepted);
    expect(getStatusStyle("rejected")).toEqual(STATUS_STYLES.declined);
  });

  it("shows an unknown status in neutral grey, not pending yellow", () => {
    expect(getStatusClasses("on_hold")).toBe("bg-gray-100 text-gray-500");
    expect(getStatusStyle("on_hold")).toEqual(STATUS_STYLES.cancelled);
  });
});
