import { describe, expect, it } from "vitest";
import {
  evaluateMarketplaceCommunicationPolicy,
  parseMarketplaceCommunicationPreferences,
  parseReplaceMarketplaceCommunicationPreferences,
} from "./communicationPreferences.js";

const preferences = {
  contractVersion: "marketplace-communications.v1",
  organizationId: "a0000000-0000-4000-8000-000000000001",
  revision: 2,
  email: { state: "on", source: "settings", effectiveAt: "2026-09-16T10:00:00.000Z" },
  topics: {
    collaborationActionRequired: {
      cadence: "immediate",
      source: "settings",
      effectiveAt: "2026-09-16T10:00:00.000Z",
    },
  },
} as const;
const policyInput = {
  launchPolicy: "service_default_on",
  providerSuppressed: false,
  recipientActive: true,
  preferences,
  consentAllowed: true,
} as const;
const topicOff = {
  ...preferences,
  topics: {
    collaborationActionRequired: {
      ...preferences.topics.collaborationActionRequired,
      cadence: "off",
    },
  },
} as const;
const allBlocked = {
  ...policyInput,
  launchPolicy: "disabled",
  providerSuppressed: true,
  recipientActive: false,
  preferences: { ...topicOff, email: { ...preferences.email, state: "off" } },
  consentAllowed: false,
} as const;

describe("Marketplace communication preferences", () => {
  it("parses only the complete exact effective document", () => {
    expect(parseMarketplaceCommunicationPreferences(preferences)).toEqual(preferences);
    expect(parseMarketplaceCommunicationPreferences({ ...preferences, extra: true })).toBeNull();
    expect(parseMarketplaceCommunicationPreferences({ ...preferences, email: null })).toBeNull();
    expect(
      parseMarketplaceCommunicationPreferences({
        ...preferences,
        organizationId: preferences.organizationId.toUpperCase(),
      }),
    ).toBeNull();
    expect(
      parseMarketplaceCommunicationPreferences({
        ...preferences,
        topics: {
          collaborationActionRequired: {
            ...preferences.topics.collaborationActionRequired,
            extra: true,
          },
        },
      }),
    ).toBeNull();
  });

  it("parses only exact full replacements", () => {
    const request = {
      contractVersion: "marketplace-communications.v1",
      expectedRevision: 0,
      email: { state: "off" },
      topics: { collaborationActionRequired: { cadence: "off" } },
    };
    expect(parseReplaceMarketplaceCommunicationPreferences(request)).toEqual(request);
    expect(
      parseReplaceMarketplaceCommunicationPreferences({ ...request, expectedRevision: -1 }),
    ).toBeNull();
    expect(
      parseReplaceMarketplaceCommunicationPreferences({ ...request, expectedRevision: -0 }),
    ).toBeNull();
    expect(parseReplaceMarketplaceCommunicationPreferences({ ...request, topics: {} })).toBeNull();
  });

  it.each([
    [{}, "launch_disabled"],
    [{ launchPolicy: "service_default_on" }, "provider_suppressed"],
    [{ launchPolicy: "service_default_on", providerSuppressed: false }, "recipient_inactive"],
    [
      { launchPolicy: "service_default_on", providerSuppressed: false, recipientActive: true },
      "channel_off",
    ],
    [
      {
        launchPolicy: "service_default_on",
        providerSuppressed: false,
        recipientActive: true,
        preferences: topicOff,
      },
      "topic_off",
    ],
    [
      {
        launchPolicy: "service_default_on",
        providerSuppressed: false,
        recipientActive: true,
        preferences,
      },
      "consent_denied",
    ],
  ] as const)("keeps every higher suppression ahead of lower failures %#", (override, reason) => {
    expect(
      evaluateMarketplaceCommunicationPolicy({
        ...allBlocked,
        ...override,
      }),
    ).toEqual({ eligible: false, reason });
  });

  it("allows the approved immediate policy after every guard passes", () => {
    expect(evaluateMarketplaceCommunicationPolicy(policyInput)).toEqual({
      eligible: true,
      cadence: "immediate",
    });
  });

  it("requires explicit preference evidence under explicit-opt-in launch policy", () => {
    expect(
      evaluateMarketplaceCommunicationPolicy({
        ...policyInput,
        launchPolicy: "explicit_opt_in",
      }),
    ).toEqual({ eligible: false, reason: "consent_denied" });
  });
});
