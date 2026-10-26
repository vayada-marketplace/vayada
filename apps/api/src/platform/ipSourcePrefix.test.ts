import { describe, expect, it } from "vitest";

import { sourcePrefix } from "./ipSourcePrefix.js";

describe("sourcePrefix", () => {
  it("keeps IPv4 addresses as they are", () => {
    expect(sourcePrefix("192.0.2.1")).toBe("192.0.2.1");
  });

  it("groups IPv6 sources by /64", () => {
    expect(sourcePrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(sourcePrefix("2001:DB8:ABCD:12:ffff::1")).toBe("2001:db8:abcd:12::/64");
    expect(sourcePrefix("2001:db8:abcd:13::1")).toBe("2001:db8:abcd:13::/64");
  });

  it("maps IPv4-mapped IPv6 addresses back to the IPv4 address", () => {
    for (const ip of [
      "::ffff:192.0.2.1",
      "0:0:0:0:0:FFFF:C000:0201",
      "0000:0000:0000:0000:0000:ffff:192.0.2.1",
      "::FFFF:C000:201",
    ])
      expect(sourcePrefix(ip)).toBe("192.0.2.1");
  });
});
