import { describe, expect, it } from "vitest";
import {
  evaluateMarketplaceCommunicationPolicy,
  parseMarketplaceCommunicationPreferences,
  parseMarketplaceCommunicationUnsubscribeRequest,
  parseMarketplaceCommunicationUnsubscribeResult,
  parseReplaceMarketplaceCommunicationPreferences,
  parseReplaceMarketplaceCommunicationPreferencesResult,
  resolveMarketplaceCommunicationPreferenceDefaults,
  serializeReplaceMarketplaceCommunicationPreferencesFingerprint,
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
  it("parses only the exact public unsubscribe envelope and port result", () => {
    const request = {
      contractVersion: "marketplace-communications.v1",
      token: "opaque-token",
    };
    expect(parseMarketplaceCommunicationUnsubscribeRequest(request)).toEqual(request);
    expect(parseMarketplaceCommunicationUnsubscribeRequest({ ...request, extra: true })).toBeNull();
    expect(parseMarketplaceCommunicationUnsubscribeRequest({ ...request, token: "" })).toBeNull();
    expect(parseMarketplaceCommunicationUnsubscribeRequest({ token: request.token })).toBeNull();
    expect(parseMarketplaceCommunicationUnsubscribeResult({ ok: true, replayed: false })).toEqual({
      ok: true,
      replayed: false,
    });
    expect(
      parseMarketplaceCommunicationUnsubscribeResult({
        ok: false,
        error: { code: "invalid_scope" },
      }),
    ).toEqual({ ok: false, error: { code: "invalid_scope" } });
    expect(
      parseMarketplaceCommunicationUnsubscribeResult({ ok: false, error: { code: "missing" } }),
    ).toBeNull();
  });

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

  it.each([
    ["service_default_on", "on", "immediate"],
    ["disabled", "off", "off"],
    ["explicit_opt_in", "off", "off"],
  ] as const)("resolves audited %s defaults", (launchPolicy, state, cadence) => {
    expect(
      resolveMarketplaceCommunicationPreferenceDefaults({
        organizationId: preferences.organizationId,
        userId: "a0000000-0000-4000-8000-000000000002",
        policy: { launchPolicy, effectiveAt: "2026-09-01T00:00:00.000Z" },
      }),
    ).toMatchObject({
      organizationId: preferences.organizationId,
      revision: 0,
      email: { state, source: "policy_default", effectiveAt: "2026-09-01T00:00:00.000Z" },
      topics: { collaborationActionRequired: { cadence, source: "policy_default" } },
    });
  });

  it("fingerprints only canonical business input", () => {
    const command = {
      organizationId: preferences.organizationId,
      userId: "a0000000-0000-4000-8000-000000000002",
      idempotencyKey: "request-key",
      audit: {
        actorUserId: "a0000000-0000-4000-8000-000000000002",
        requestId: "request-1",
        correlationId: null,
        requestedAt: "2026-09-16T10:00:00.000Z",
      },
      request: {
        contractVersion: "marketplace-communications.v1",
        expectedRevision: 0,
        email: { state: "off" },
        topics: { collaborationActionRequired: { cadence: "off" } },
      },
    } as const;
    expect(serializeReplaceMarketplaceCommunicationPreferencesFingerprint(command)).toBe(
      serializeReplaceMarketplaceCommunicationPreferencesFingerprint({
        ...command,
        idempotencyKey: "another-key",
        audit: { ...command.audit, requestId: "request-2" },
      }),
    );
  });

  it("parses only complete stored command results", () => {
    expect(
      parseReplaceMarketplaceCommunicationPreferencesResult({ ok: true, preferences }),
    ).toEqual({ ok: true, preferences });
    expect(
      parseReplaceMarketplaceCommunicationPreferencesResult({
        ok: false,
        error: { code: "preference_conflict", currentRevision: 2 },
      }),
    ).toEqual({ ok: false, error: { code: "preference_conflict", currentRevision: 2 } });
    expect(
      parseReplaceMarketplaceCommunicationPreferencesResult({
        ok: false,
        error: { code: "preference_conflict" },
      }),
    ).toBeNull();
  });
});
