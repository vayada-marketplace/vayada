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
