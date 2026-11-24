import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n", async () => {
  const en = (await import("../../messages/en.json")).default as Record<string, string>;
  return {
    useTranslation: () => ({
      t: (key: string, params?: Record<string, string>) =>
        Object.entries(params ?? {}).reduce(
          (text, [name, value]) => text.replace(`{${name}}`, value),
          en[key] ?? key,
        ),
      locale: "en",
    }),
  };
});

import type { CustomDomainStatus } from "@/services/settings";
import CustomDomainCard from "./CustomDomainCard";

const base: CustomDomainStatus = {
  hotelId: "hotel-1",
  propertyId: "property-1",
  configured: true,
  domain: "booking.hotel.example",
  status: "failed",
  sslStatus: "failed",
  dnsRecords: [
    {
      type: "CNAME",
      name: "booking.hotel.example",
      host: "booking",
      value: "custom.booking.vayada.com",
      status: "failed",
    },
  ],
  verificationErrors: ["No CNAME record found for booking.hotel.example."],
  verificationIssue: { code: "dns_record_missing", foundTarget: null },
  checkedAt: "2026-11-20T20:00:00.000Z",
  updatedAt: "2026-11-20T20:00:00.000Z",
};

function render(domainStatus: CustomDomainStatus | null, saving = false) {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      <CustomDomainCard
        bookingUrl="hotel.next-booking.vayada.com"
        domainInput=""
        domainStatus={domainStatus}
        saving={saving}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onDomainInputChange={() => {}}
        onRefresh={() => {}}
      />,
    );
  });
  return JSON.stringify(view.toJSON());
}

describe("custom domain card (VAY-2568)", () => {
  it("names the missing record exactly instead of verifying forever", () => {
    const text = render(base);

    expect(text).toContain("Not verified");
    expect(text).not.toContain("Verifying...");
    expect(text).toContain("We can't find a CNAME record for booking.hotel.example yet.");
    expect(text).toContain("DNS record for your domain");
    expect(text).toContain('"booking"');
    expect(text).toContain("custom.booking.vayada.com");
    expect(text).toContain("Last checked");
  });

  it("names the wrong target the hotel's record points to", () => {
    const text = render({
      ...base,
      verificationIssue: { code: "dns_record_wrong_target", foundTarget: "hotel.example" },
    });

    expect(text).toContain("The CNAME record for booking.hotel.example points to hotel.example.");
  });

  it("says Verifying... only while the certificate is being issued", () => {
    const text = render({
      ...base,
      status: "pending",
      sslStatus: "pending",
      verificationIssue: { code: "certificate_pending", foundTarget: null },
    });

    expect(text).toContain("Verifying...");
    expect(text).toContain("Your DNS record is correct.");
  });

  it("says Vayada is finishing the setup once the domain is ready but not routed yet", () => {
    const text = render({
      ...base,
      status: "pending",
      sslStatus: "pending",
      verificationIssue: { code: "routing_pending", foundTarget: null },
    });

    expect(text).toContain("Setting up");
    expect(text).not.toContain("Verifying...");
    expect(text).toContain("Vayada is finishing the setup on our side; press Refresh later");
  });

  it("says the check could not run, without claiming to verify", () => {
    const text = render({
      ...base,
      status: "pending",
      sslStatus: "pending",
      verificationIssue: { code: "check_unavailable", foundTarget: null },
    });

    expect(text).toContain("Not checked");
    expect(text).not.toContain("Verifying...");
    expect(text).toContain("We couldn't check your domain right now.");
  });

  it("shows a verified domain as connected, and Checking... while a check runs", () => {
    const verified = render({
      ...base,
      status: "verified",
      sslStatus: "active",
      verificationIssue: null,
      verificationErrors: [],
    });
    expect(verified).toContain("Connected");
    expect(verified).not.toContain("DNS record for your domain");
    expect(verified).not.toContain("We can't find");

    expect(render(base, true)).toContain("Checking...");
  });

  describe("the ownership record (VAY-2579)", () => {
    const proof = {
      type: "TXT" as const,
      name: "_vayada.booking.hotel.example",
      host: "_vayada.booking",
      value: "vayada-domain-verification=0123456789abcdef0123456789abcdef",
      status: "failed" as const,
    };
    const withProof = (code: "ownership_record_missing" | "ownership_record_mismatch") =>
      render({
        ...base,
        dnsRecords: [{ ...base.dnsRecords[0], status: "verified" }, proof],
        verificationIssue: { code, foundTarget: null },
      });

    it("shows both records to add, the TXT one with its name and value", () => {
      const text = withProof("ownership_record_missing");

      expect(text).toContain("DNS records for your domain");
      expect(text).toContain('"CNAME"');
      expect(text).toContain('"TXT"');
      expect(text).toContain('"_vayada.booking"');
      expect(text).toContain('"Value"');
      expect(text).toContain("vayada-domain-verification=0123456789abcdef0123456789abcdef");
      expect(text).toContain("Not verified");
      expect(text).toContain(
        "Add the TXT record below too, so we know booking.hotel.example is yours.",
      );
    });

    it("asks for both records at once while the CNAME is missing too", () => {
      const text = render({
        ...base,
        dnsRecords: [base.dnsRecords[0], { ...proof, status: "pending" }],
      });

      expect(text).toContain(
        "We can't find a CNAME record for booking.hotel.example yet. Add both records below",
      );
    });

    it("says the domain belongs to another hotel when the record holds another code", () => {
      const text = withProof("ownership_record_mismatch");

      expect(text).toContain("This domain belongs to another hotel");
      expect(text).toContain("the TXT record for booking.hotel.example holds another hotel's code");
    });
  });

  it("keeps the general DNS setup help before a domain is connected", () => {
    const text = render({
      ...base,
      configured: false,
      domain: null,
      status: "not_configured",
      sslStatus: "not_configured",
      dnsRecords: [],
      verificationErrors: [],
      verificationIssue: null,
      checkedAt: null,
    });

    expect(text).toContain("Not connected");
    expect(text).toContain("DNS setup");
    expect(text).not.toContain("Last checked");
  });
});
