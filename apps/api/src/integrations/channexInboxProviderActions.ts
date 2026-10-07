import type { PmsInboxProviderAction } from "../domains/pmsInbox.js";
import type { AirbnbInquiryEvidence } from "../domains/airbnbInquiryEvidence.js";
import type { PmsInboxDeliveryProviderResult } from "../domains/pmsInboxDelivery.js";
import { createChannexThreadAction } from "./channexMessageDelivery.js";
import { createChannexInquiryPreapproval } from "./channexInquiryPreapproval.js";

export function createChannexInboxProviderActions(
  config: Parameters<typeof createChannexThreadAction>[0],
) {
  const threadAction = createChannexThreadAction(config);
  const inquiryAction = createChannexInquiryPreapproval(config);
  return async (
    input: {
      action: PmsInboxProviderAction;
      providerConversationId: string;
      inquiry?: AirbnbInquiryEvidence;
    },
    reconcileOnly = false,
  ): Promise<PmsInboxDeliveryProviderResult> => {
    if (input.action !== "airbnb_preapprove")
      return threadAction({ ...input, action: input.action });
    if (!input.inquiry || input.inquiry.threadId !== input.providerConversationId)
      return { ok: false, failure: "invalid_delivery_payload" };
    const { eventId, providerPropertyId, threadId, listingId, contextDigest } = input.inquiry;
    const scope = { eventId, providerPropertyId, threadId, listingId, contextDigest };
    const result = await (reconcileOnly
      ? inquiryAction.read(scope)
      : inquiryAction.preapprove(scope));
    if (result.ok && result.state === "preapproved")
      return { ok: true, providerReference: eventId };
    if (reconcileOnly || (!result.ok && result.failure === "decision_outcome_unknown"))
      return { ok: false, failure: "ambiguous_provider_outcome" };
    return {
      ok: false,
      failure:
        result.ok || ["provider_rejected", "already_resolved"].includes(result.failure)
          ? "provider_rejected"
          : "invalid_delivery_payload",
    };
  };
}
