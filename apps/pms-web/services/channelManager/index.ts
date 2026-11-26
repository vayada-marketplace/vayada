import type { ChannelManagerView } from "@vayada/domain-pms-channex";

import {
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "@/services/api/pmsOperationsClient";

export type {
  ChannelManagerChannel,
  ChannelManagerMarkup,
  ChannelManagerProblem,
  ChannelManagerRoom,
  ChannelManagerView,
} from "@vayada/domain-pms-channex";

const base = (propertyId: string) => `/api/pms/properties/${encodeURIComponent(propertyId)}`;

/** VAY-2606: the read-only Channel manager page, for account admins and staff with the Channel manager permission. */
export function getChannelManagerView(propertyId: string, signal?: AbortSignal) {
  return pmsOperationsClient.get<ChannelManagerView>(`${base(propertyId)}/channel-manager`, {
    ...pmsOperationsRequestOptions,
    signal,
  });
}

/** Marks a problem as seen (account admins only). It doesn't fix it; the problem stays until it's resolved. */
export function markChannelProblemSeen(propertyId: string, problemId: string) {
  return pmsOperationsClient.post<{ ok: true }>(
    `${base(propertyId)}/channex/alerts/${encodeURIComponent(problemId)}/acknowledge`,
    { round: 0 },
    pmsOperationsRequestOptions,
  );
}
