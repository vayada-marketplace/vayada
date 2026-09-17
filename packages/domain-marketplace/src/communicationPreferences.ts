export const MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION = "marketplace-communications.v1" as const;
export type MarketplaceCommunicationLaunchPolicy =
  | "disabled"
  | "service_default_on"
  | "explicit_opt_in";
export type MarketplaceCommunicationPreferenceSource =
  | "policy_default"
  | "settings"
  | "signed_unsubscribe"
  | "explicit_opt_in";

type EffectiveValue<T> = {
  readonly source: MarketplaceCommunicationPreferenceSource;
  readonly effectiveAt: string;
} & T;
export type MarketplaceCommunicationPreferencesV1 = {
  readonly contractVersion: typeof MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION;
  readonly organizationId: string;
  readonly revision: number;
  readonly email: EffectiveValue<{ readonly state: "on" | "off" }>;
  readonly topics: {
    readonly collaborationActionRequired: EffectiveValue<{
      readonly cadence: "immediate" | "off";
    }>;
  };
};
export type ReplaceMarketplaceCommunicationPreferencesV1 = {
  readonly contractVersion: typeof MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION;
  readonly expectedRevision: number;
  readonly email: { readonly state: "on" | "off" };
  readonly topics: {
    readonly collaborationActionRequired: { readonly cadence: "immediate" | "off" };
  };
};

export type MarketplaceCommunicationPreferencePolicy = {
  readonly launchPolicy: MarketplaceCommunicationLaunchPolicy;
  /** Effective time of the audited launch-policy decision, not the read time. */
  readonly effectiveAt: string;
};
/**
 * Source-controlled launch gate approved with the initial v1 contract. Changing
 * this policy requires a new audited legal/privacy launch decision.
 */
export const MARKETPLACE_COMMUNICATIONS_INITIAL_POLICY = Object.freeze({
  launchPolicy: "disabled",
  effectiveAt: "2026-09-16T13:22:41.000Z",
} as const satisfies MarketplaceCommunicationPreferencePolicy);
export type MarketplaceCommunicationPreferenceScope = {
  readonly organizationId: string;
  readonly userId: string;
  readonly policy: MarketplaceCommunicationPreferencePolicy;
};
export type MarketplaceCommunicationPreferenceReadPort = {
  getCommunicationPreferences(
    scope: MarketplaceCommunicationPreferenceScope,
  ): Promise<MarketplaceCommunicationPreferencesV1>;
};
export type MarketplaceCommunicationPreferenceAudit = {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly correlationId: string | null;
  readonly requestedAt: string;
};
export type ReplaceMarketplaceCommunicationPreferencesCommand = {
  readonly organizationId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly audit: MarketplaceCommunicationPreferenceAudit;
  readonly request: ReplaceMarketplaceCommunicationPreferencesV1;
};
export type ReplaceMarketplaceCommunicationPreferencesResult =
  | { readonly ok: true; readonly preferences: MarketplaceCommunicationPreferencesV1 }
  | {
      readonly ok: false;
      readonly error:
        | { readonly code: "idempotency_conflict" | "command_in_progress" | "scope_forbidden" }
        | { readonly code: "preference_conflict"; readonly currentRevision: number };
    };
export type MarketplaceCommunicationPreferenceCommandPort = {
  replaceCommunicationPreferences(
    command: ReplaceMarketplaceCommunicationPreferencesCommand,
  ): Promise<ReplaceMarketplaceCommunicationPreferencesResult>;
};

export type MarketplaceCommunicationUnsubscribeRequestV1 = {
  readonly contractVersion: typeof MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION;
  readonly token: string;
};
export type MarketplaceCommunicationUnsubscribeClaims = {
  readonly action: "unsubscribe_topic";
  readonly channel: "email";
  readonly deliveryId: string;
  readonly expiresAt: number;
  readonly keyVersion: string;
  readonly nonce: string;
  readonly organizationId: string;
  readonly topic: "collaboration_action_required";
  readonly userId: string;
};
export type VerifiedMarketplaceCommunicationUnsubscribeToken = {
  readonly claims: MarketplaceCommunicationUnsubscribeClaims;
  /** Lowercase SHA-256 digest of the complete opaque token. */
  readonly tokenHash: string;
};
export type MarketplaceCommunicationUnsubscribeTokenPort = {
  verify(token: string, now: Date): VerifiedMarketplaceCommunicationUnsubscribeToken | null;
};
export type MarketplaceCommunicationUnsubscribeCommand =
  VerifiedMarketplaceCommunicationUnsubscribeToken & {
    readonly audit: {
      readonly requestId: string;
      readonly correlationId: string | null;
      readonly requestedAt: string;
    };
  };
export type MarketplaceCommunicationUnsubscribeResult =
  | { readonly ok: true; readonly replayed: boolean }
  | { readonly ok: false; readonly error: { readonly code: "invalid_scope" } };
export type MarketplaceCommunicationUnsubscribeCommandPort = {
  unsubscribeCommunicationTopic(
    command: MarketplaceCommunicationUnsubscribeCommand,
  ): Promise<MarketplaceCommunicationUnsubscribeResult>;
};

export function parseMarketplaceCommunicationUnsubscribeRequest(
  value: unknown,
): MarketplaceCommunicationUnsubscribeRequestV1 | null {
  const root = exact(value, ["contractVersion", "token"]);
  return root?.contractVersion === MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION &&
    typeof root.token === "string" &&
    root.token.length >= 1 &&
    root.token.length <= 4_096
    ? deepFreeze({
        contractVersion: MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION,
        token: root.token,
      })
    : null;
}

export function parseMarketplaceCommunicationUnsubscribeResult(
  value: unknown,
): MarketplaceCommunicationUnsubscribeResult | null {
  const root = record(value);
  if (!root || typeof root.ok !== "boolean") return null;
  if (root.ok) {
    return exact(root, ["ok", "replayed"]) && typeof root.replayed === "boolean"
      ? deepFreeze({ ok: true, replayed: root.replayed })
      : null;
  }
  const error = exact(root.error, ["code"]);
  return exact(root, ["ok", "error"]) && error?.code === "invalid_scope"
    ? deepFreeze({ ok: false, error: { code: "invalid_scope" } })
    : null;
}

export function resolveMarketplaceCommunicationPreferenceDefaults(
  scope: MarketplaceCommunicationPreferenceScope,
): MarketplaceCommunicationPreferencesV1 {
  if (
    !uuid(scope.organizationId) ||
    !uuid(scope.userId) ||
    !oneOf(scope.policy.launchPolicy, ["disabled", "service_default_on", "explicit_opt_in"]) ||
    !timestamp(scope.policy.effectiveAt)
  ) {
    throw new TypeError("Marketplace communication preference scope is invalid");
  }
  const enabled = scope.policy.launchPolicy === "service_default_on";
  return deepFreeze({
    contractVersion: MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION,
    organizationId: scope.organizationId,
    revision: 0,
    email: {
      state: enabled ? "on" : "off",
      source: "policy_default",
      effectiveAt: scope.policy.effectiveAt,
    },
    topics: {
      collaborationActionRequired: {
        cadence: enabled ? "immediate" : "off",
        source: "policy_default",
        effectiveAt: scope.policy.effectiveAt,
      },
    },
  });
}

/** Stable business fingerprint. Transport and audit metadata are deliberately excluded. */
export function serializeReplaceMarketplaceCommunicationPreferencesFingerprint(
  command: ReplaceMarketplaceCommunicationPreferencesCommand,
): string {
  const request = parseReplaceMarketplaceCommunicationPreferences(command.request);
  if (!uuid(command.organizationId) || !uuid(command.userId) || !request) {
    throw new TypeError("Marketplace communication preference command is invalid");
  }
  return JSON.stringify({
    organizationId: command.organizationId,
    userId: command.userId,
    request,
  });
}

export function parseReplaceMarketplaceCommunicationPreferencesResult(
  value: unknown,
): ReplaceMarketplaceCommunicationPreferencesResult | null {
  const root = record(value);
  if (!root || typeof root.ok !== "boolean") return null;
  if (root.ok) {
    const preferences = parseMarketplaceCommunicationPreferences(root.preferences);
    return exact(root, ["ok", "preferences"]) && preferences
      ? deepFreeze({ ok: true, preferences })
      : null;
  }
  const error = record(root.error);
  if (!exact(root, ["ok", "error"]) || !error || typeof error.code !== "string") return null;
  if (error.code === "preference_conflict") {
    return exact(error, ["code", "currentRevision"]) && revision(error.currentRevision)
      ? deepFreeze({
          ok: false,
          error: { code: "preference_conflict", currentRevision: error.currentRevision },
        })
      : null;
  }
  return exact(error, ["code"]) &&
    oneOf(error.code, ["idempotency_conflict", "command_in_progress", "scope_forbidden"])
    ? deepFreeze({ ok: false, error: { code: error.code } })
    : null;
}

export function parseMarketplaceCommunicationPreferences(
  value: unknown,
): MarketplaceCommunicationPreferencesV1 | null {
  const root = exact(value, ["contractVersion", "organizationId", "revision", "email", "topics"]);
  const email = exact(root?.email, ["state", "source", "effectiveAt"]);
  const topics = exact(root?.topics, ["collaborationActionRequired"]);
  const topic = exact(topics?.collaborationActionRequired, ["cadence", "source", "effectiveAt"]);
  if (
    root?.contractVersion !== MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION ||
    !uuid(root.organizationId) ||
    !revision(root.revision) ||
    !oneOf(email?.state, ["on", "off"]) ||
    !source(email?.source) ||
    !timestamp(email?.effectiveAt) ||
    !oneOf(topic?.cadence, ["immediate", "off"]) ||
    !source(topic?.source) ||
    !timestamp(topic?.effectiveAt)
  )
    return null;
  return deepFreeze({
    contractVersion: MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION,
    organizationId: root.organizationId,
    revision: root.revision,
    email,
    topics: { collaborationActionRequired: topic },
  }) as MarketplaceCommunicationPreferencesV1;
}

export function parseReplaceMarketplaceCommunicationPreferences(
  value: unknown,
): ReplaceMarketplaceCommunicationPreferencesV1 | null {
  const root = exact(value, ["contractVersion", "expectedRevision", "email", "topics"]);
  const email = exact(root?.email, ["state"]);
  const topics = exact(root?.topics, ["collaborationActionRequired"]);
  const topic = exact(topics?.collaborationActionRequired, ["cadence"]);
  return root?.contractVersion === MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION &&
    revision(root.expectedRevision) &&
    oneOf(email?.state, ["on", "off"]) &&
    oneOf(topic?.cadence, ["immediate", "off"])
    ? deepFreeze({
        contractVersion: MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION,
        expectedRevision: root.expectedRevision,
        email: { state: email.state },
        topics: { collaborationActionRequired: { cadence: topic.cadence } },
      })
    : null;
}

export type MarketplaceCommunicationPolicyResult =
  | { readonly eligible: true; readonly cadence: "immediate" }
  | {
      readonly eligible: false;
      readonly reason:
        | "launch_disabled"
        | "provider_suppressed"
        | "recipient_inactive"
        | "channel_off"
        | "topic_off"
        | "consent_denied";
    };

export function evaluateMarketplaceCommunicationPolicy(input: {
  readonly launchPolicy: MarketplaceCommunicationLaunchPolicy;
  readonly providerSuppressed: boolean;
  readonly recipientActive: boolean;
  readonly preferences: MarketplaceCommunicationPreferencesV1;
  readonly consentAllowed: boolean;
}): MarketplaceCommunicationPolicyResult {
  if (input.launchPolicy === "disabled") return { eligible: false, reason: "launch_disabled" };
  if (input.providerSuppressed) return { eligible: false, reason: "provider_suppressed" };
  if (!input.recipientActive) return { eligible: false, reason: "recipient_inactive" };
  if (input.preferences.email.state === "off") return { eligible: false, reason: "channel_off" };
  if (input.preferences.topics.collaborationActionRequired.cadence === "off")
    return { eligible: false, reason: "topic_off" };
  if (
    input.launchPolicy === "explicit_opt_in" &&
    (input.preferences.email.source !== "explicit_opt_in" ||
      input.preferences.topics.collaborationActionRequired.source !== "explicit_opt_in")
  )
    return { eligible: false, reason: "consent_denied" };
  if (!input.consentAllowed) return { eligible: false, reason: "consent_denied" };
  return { eligible: true, cadence: "immediate" };
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    ownKeys.length !== keys.length ||
    !ownKeys.every((key) => typeof key === "string" && keys.includes(key)) ||
    !keys.every((key) => Object.hasOwn(descriptors, key) && "value" in descriptors[key]!)
  )
    return null;
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(descriptors).every(
      (key) => typeof key === "string" && "value" in descriptors[key]!,
    )
    ? Object.fromEntries(
        Reflect.ownKeys(descriptors).map((key) => [key, descriptors[String(key)]!.value]),
      )
    : null;
}
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && allowed.includes(value as T);
const source = (value: unknown): value is MarketplaceCommunicationPreferenceSource =>
  oneOf(value, ["policy_default", "settings", "signed_unsubscribe", "explicit_opt_in"]);
const revision = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  !Object.is(value, -0) &&
  value >= 0 &&
  value <= 2_147_483_647;
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
