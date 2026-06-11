import type { AskScope } from "./ask.js";
import type { AskEvidenceToolId } from "./evidence.js";

/**
 * Deterministic pre-model guardrails per the VAY-736 runtime decision: the
 * planner classifies the question, applies tenant/resource scope policy, and
 * selects the allowed evidence tool subset before any provider call. The
 * model may choose among the planned tools; it never widens the plan.
 */

export type AskQuestionIntent =
  | "booking_performance"
  | "booking_source_mix"
  | "conversion_funnel"
  | "setup_completeness"
  | "performance_overview";

export type AskPlannedToolCall = {
  toolId: AskEvidenceToolId;
  metricKeys: string[];
};

export type AskClarificationReason =
  | "missing_organization"
  | "missing_property"
  | "missing_date_range"
  | "invalid_date_range";

export type AskExternalDataTopic =
  | "reviews"
  | "local_events"
  | "weather"
  | "market_demand"
  | "external_creators"
  | "competitor_pricing";

export type AskPlan =
  | { kind: "run_tools"; intent: AskQuestionIntent; toolPlan: AskPlannedToolCall[] }
  | {
      kind: "needs_clarification";
      reasons: AskClarificationReason[];
      followUpQuestions: string[];
    }
  | { kind: "external_data_needed"; topic: AskExternalDataTopic }
  | {
      kind: "write_action";
      /** Read intent detected alongside the write request, so the composer can still gather evidence for a `partial` answer. */
      intent: AskQuestionIntent | null;
      toolPlan: AskPlannedToolCall[];
    }
  | { kind: "cross_tenant"; reason: "organization_mismatch" | "cross_tenant_question" }
  | { kind: "unsupported"; reason: "blocked_sql" | "no_cataloged_intent" };

export type AskPlanInput = {
  question: string;
  scope: AskScope;
  /** Organization resolved from RequestContext; mismatch is a tenant denial. */
  selectedOrganizationId?: string;
};

const TOOL_METRICS: Record<AskEvidenceToolId, string[]> = {
  get_booking_performance: [
    "booking.direct_booking_share",
    "booking.gross_booking_revenue",
    "booking.average_daily_rate",
  ],
  get_booking_source_mix: ["booking.booking_source_mix", "booking.direct_booking_share"],
  get_conversion_funnel: ["booking.conversion_funnel"],
  get_setup_gaps: ["hotel_catalog.setup_completeness_score"],
  get_hotel_settings_summary: ["hotel_catalog.setup_completeness_score"],
};

const INTENT_TOOLS: Record<AskQuestionIntent, AskEvidenceToolId[]> = {
  booking_performance: ["get_booking_performance", "get_booking_source_mix"],
  booking_source_mix: ["get_booking_source_mix", "get_booking_performance"],
  conversion_funnel: ["get_conversion_funnel"],
  setup_completeness: ["get_setup_gaps", "get_hotel_settings_summary"],
  performance_overview: [
    "get_booking_performance",
    "get_booking_source_mix",
    "get_conversion_funnel",
    "get_setup_gaps",
    "get_hotel_settings_summary",
  ],
};

/**
 * Intents that read booking metric snapshots and therefore need a booking
 * property and date range. `performance_overview` includes setup tools that
 * would accept a PMS-only property, but its lead metrics are booking
 * snapshots, so it deliberately holds the stricter requirement.
 */
const BOOKING_METRIC_INTENTS: ReadonlySet<AskQuestionIntent> = new Set([
  "booking_performance",
  "booking_source_mix",
  "conversion_funnel",
  "performance_overview",
]);

const BLOCKED_SQL_PATTERN =
  /\bselect\s+\*|\bselect\s+\w+(?:\s*,\s*\w+)+\s+from\b|\binsert\s+into\b|\bdelete\s+from\b|\bdrop\s+table\b|\bsql\b|\bquery\s+the\s+database\b/i;

const CROSS_TENANT_PATTERN =
  /\b(?<!\bmy\s)(?<!\bour\s)(?:other|another)\s+(?:hotels?|propert\w+|tenants?|owners?)\b|\ball\s+hotels\b|\bbenchmark\w*\b.{0,60}\b(?:others?|all|market|competitors?|industry|peers?)\b/i;

/** Advice framing is a read question about a possible action, not a request to execute one. */
const ADVICE_PATTERN = /\bshould\s+(?:i|we)\b|\bwhat\s+if\b|\bis\s+it\s+worth\b|\bwould\s+it\b/i;

const WRITE_ACTION_PATTERNS = [
  /\b(?:change|set|update|raise|lower|adjust|increase|decrease|turn\s+(?:on|off))\b.{0,40}\b(?:rates?|prices?|pricing|settings?|availability|instant\s+booking)\b/i,
  /\bsend\b.{0,60}\b(?:message|email|guests?)\b/i,
  /\b(?:cancell?(?:ed)?|refund|mark|delete|remove)\b.{0,50}\bbookings?\b/i,
  /\b(?:add|create)\b.{0,50}\b(?:room\s+types?|discounts?|codes?|rates?|listings?|add-?ons?)\b/i,
  /\b(?:publish|unpublish|enable|disable|execute|apply)\b.{0,40}\b(?:settings?|changes?|page|listing)\b/i,
];

const EXTERNAL_DATA_TOPICS: { topic: AskExternalDataTopic; pattern: RegExp }[] = [
  { topic: "reviews", pattern: /\breviews?\b/i },
  { topic: "local_events", pattern: /\blocal\s+events?\b/i },
  { topic: "weather", pattern: /\bweather\b/i },
  {
    topic: "market_demand",
    pattern: /\bmarket\s+(?:demand|data|rates?)\b|\bpredict\s+demand\b/i,
  },
  { topic: "external_creators", pattern: /\boutside\s+vayada\b/i },
  {
    topic: "competitor_pricing",
    pattern: /\bcompetit|\bnearby\b|\bparity\b|booking\.com/i,
  },
];

const OVERVIEW_PATTERN =
  /\btop\s+(?:\d+|one|two|three|four|five)\b|\boverall\b|\boverview\b|\bwhat\s+(?:happened|changed)\b|\bwhat\s+should\s+i\s+(?:do|fix|improve)\b|\bthings\s+to\s+fix\b|\bhealth\s*check\b/i;

const FUNNEL_PATTERN =
  /\bfunnel\b|\bconversion\b|\bpage\s*views?\b|\bcheckout\b|\bdrop-?off\b|\babandon/i;

const SOURCE_MIX_PATTERN =
  /\bsources?\b|\bchannels?\b|\bota\b|\bsource\s+mix\b|\bwhere\b.{0,40}\bbookings?\b.{0,20}\b(?:from|come)\b/i;

const SETUP_PATTERN =
  /\bsetup\b|\bsettings?\b|\bcomplete(?:ness)?\b|\bincomplete\b|\bmissing\b.{0,40}\b(?:fields?|items?|data|info)\b|\bblocking\b|\bconfigured?\b/i;

const PERFORMANCE_PATTERN =
  /\bdirect\b|\brevenue\b|\badr\b|\baverage\s+daily\s+rate\b|\bbooking\s+share\b|\bbookings?\b|\broom\s+types?\b|\bperformance\b|\brates?\b|\bprices?\b|\bpricing\b/i;

export function planAskQuestion(input: AskPlanInput): AskPlan {
  const question = input.question.trim();

  if (BLOCKED_SQL_PATTERN.test(question)) {
    return { kind: "unsupported", reason: "blocked_sql" };
  }
  if (
    input.selectedOrganizationId &&
    input.scope.organizationId &&
    input.scope.organizationId !== input.selectedOrganizationId
  ) {
    return { kind: "cross_tenant", reason: "organization_mismatch" };
  }
  if (CROSS_TENANT_PATTERN.test(question)) {
    return { kind: "cross_tenant", reason: "cross_tenant_question" };
  }
  if (
    !ADVICE_PATTERN.test(question) &&
    WRITE_ACTION_PATTERNS.some((pattern) => pattern.test(question))
  ) {
    const intent = classifyIntent(question);
    return { kind: "write_action", intent, toolPlan: intent ? toolPlan(intent) : [] };
  }
  const externalTopic = EXTERNAL_DATA_TOPICS.find(({ pattern }) => pattern.test(question));
  if (externalTopic) return { kind: "external_data_needed", topic: externalTopic.topic };

  const intent = classifyIntent(question);
  if (!intent) return { kind: "unsupported", reason: "no_cataloged_intent" };

  const clarification = validateScope(intent, input.scope);
  if (clarification) return clarification;

  return { kind: "run_tools", intent, toolPlan: toolPlan(intent) };
}

function toolPlan(intent: AskQuestionIntent): AskPlannedToolCall[] {
  return INTENT_TOOLS[intent].map((toolId) => ({ toolId, metricKeys: TOOL_METRICS[toolId] }));
}

function classifyIntent(question: string): AskQuestionIntent | null {
  if (OVERVIEW_PATTERN.test(question)) return "performance_overview";
  if (FUNNEL_PATTERN.test(question)) return "conversion_funnel";
  if (SETUP_PATTERN.test(question)) return "setup_completeness";
  if (SOURCE_MIX_PATTERN.test(question)) return "booking_source_mix";
  if (PERFORMANCE_PATTERN.test(question)) return "booking_performance";
  return null;
}

function validateScope(intent: AskQuestionIntent, scope: AskScope): AskPlan | null {
  const reasons: AskClarificationReason[] = [];
  const followUpQuestions: string[] = [];

  if (!scope.organizationId) {
    reasons.push("missing_organization");
    followUpQuestions.push("Which organization should I analyze?");
  }

  const needsBookingProperty = BOOKING_METRIC_INTENTS.has(intent);
  if (needsBookingProperty && !scope.bookingHotelId) {
    reasons.push("missing_property");
    followUpQuestions.push("Which hotel should I analyze?");
  }
  if (!needsBookingProperty && !scope.bookingHotelId && !scope.pmsHotelId) {
    reasons.push("missing_property");
    followUpQuestions.push("Which property should I check?");
  }

  if (needsBookingProperty) {
    if (!scope.dateRange) {
      reasons.push("missing_date_range");
      followUpQuestions.push("Which date range should I analyze?");
    } else if (!isValidDateRange(scope.dateRange)) {
      reasons.push("invalid_date_range");
      followUpQuestions.push(
        "That date range looks invalid — which from/to dates should I analyze?",
      );
    }
  } else if (scope.dateRange && !isValidDateRange(scope.dateRange)) {
    reasons.push("invalid_date_range");
    followUpQuestions.push("That date range looks invalid — which from/to dates should I use?");
  }

  if (reasons.length === 0) return null;
  return { kind: "needs_clarification", reasons, followUpQuestions };
}

function isValidDateRange(dateRange: NonNullable<AskScope["dateRange"]>): boolean {
  return isIsoDate(dateRange.from) && isIsoDate(dateRange.to) && dateRange.from <= dateRange.to;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
