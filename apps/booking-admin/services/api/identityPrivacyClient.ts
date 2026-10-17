import { getAuthBearerToken } from "@/services/auth/sessionStore";

import { ApiClient, ApiErrorResponse } from "./client";

// Identity consent and GDPR requests (VAY-2262), ported from marketplace-shared's privacy client.
// Booking Admin has no cookie banner, so the visitor cookie-consent calls are not here.
const IDENTITY_PRIVACY_API_BASE_URL =
  process.env.NEXT_PUBLIC_IDENTITY_API_URL ??
  process.env.NEXT_PUBLIC_AUTH_API_URL ??
  "https://api.localhost";

const identityPrivacyClient = new ApiClient(IDENTITY_PRIVACY_API_BASE_URL);

export const identityPrivacyEndpoints = {
  consentStatus: "/api/identity/consent/me",
  consentHistory: (limit = 50, offset = 0) =>
    `/api/identity/consent/history?limit=${limit}&offset=${offset}`,
  gdprExportRequest: "/api/identity/gdpr/export-request",
  gdprExportStatus: "/api/identity/gdpr/export-status",
  gdprExportDownload: (token: string) =>
    `/api/identity/gdpr/export-download?token=${encodeURIComponent(token)}`,
  gdprDeletionRequest: "/api/identity/gdpr/delete-request",
  gdprDeletionCancel: "/api/identity/gdpr/delete-cancel",
  gdprDeletionStatus: "/api/identity/gdpr/delete-status",
} as const;

export type ConsentStatusResponse = {
  terms_accepted: boolean;
  terms_accepted_at: string | null;
  terms_version: string | null;
  privacy_accepted: boolean;
  privacy_accepted_at: string | null;
  privacy_version: string | null;
  marketing_consent: boolean;
  marketing_consent_at: string | null;
};

export type UpdateMarketingConsentResponse = {
  marketing_consent: boolean;
  marketing_consent_at: string;
  message: string;
};

export type ConsentHistoryItem = {
  id: string;
  consent_type: string;
  consent_given: boolean;
  version: string | null;
  created_at: string;
};

export type ConsentHistoryResponse = {
  history: ConsentHistoryItem[];
  total: number;
};

export type GdprExportRequestResponse = {
  id: string;
  status: string;
  requested_at: string;
  expires_at: string | null;
  download_token: string | null;
  message: string;
};

export type GdprRequestStatusResponse = {
  id: string;
  request_type: "export" | "deletion";
  status: "pending" | "processing" | "completed" | "cancelled" | "expired";
  requested_at: string;
  processed_at: string | null;
  expires_at: string | null;
  download_token?: string | null;
};

export type GdprDeletionRequestResponse = {
  id: string;
  status: string;
  requested_at: string;
  scheduled_deletion_at: string;
  message: string;
};

export type GdprDeletionCancelResponse = {
  message: string;
  cancelled: boolean;
};

export const identityPrivacyService = {
  getConsentStatus(): Promise<ConsentStatusResponse> {
    return identityPrivacyClient.get<ConsentStatusResponse>(identityPrivacyEndpoints.consentStatus);
  },

  updateMarketingConsent(marketingConsent: boolean): Promise<UpdateMarketingConsentResponse> {
    return identityPrivacyClient.put<UpdateMarketingConsentResponse>(
      identityPrivacyEndpoints.consentStatus,
      { marketing_consent: marketingConsent },
    );
  },

  getConsentHistory(limit = 50, offset = 0): Promise<ConsentHistoryResponse> {
    return identityPrivacyClient.get<ConsentHistoryResponse>(
      identityPrivacyEndpoints.consentHistory(limit, offset),
    );
  },

  requestDataExport(): Promise<GdprExportRequestResponse> {
    return identityPrivacyClient.post<GdprExportRequestResponse>(
      identityPrivacyEndpoints.gdprExportRequest,
      {},
    );
  },

  getExportStatus(): Promise<GdprRequestStatusResponse> {
    return identityPrivacyClient.get<GdprRequestStatusResponse>(
      identityPrivacyEndpoints.gdprExportStatus,
    );
  },

  /** The export file itself; the API client only speaks JSON, so this is a plain fetch. */
  async downloadExport(token: string): Promise<Blob> {
    const bearer = getAuthBearerToken();
    const response = await fetch(
      `${IDENTITY_PRIVACY_API_BASE_URL}${identityPrivacyEndpoints.gdprExportDownload(token)}`,
      {
        headers: {
          Accept: "application/octet-stream",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ApiErrorResponse(response.status, {
        detail: text || `Export download failed: ${response.status}`,
      });
    }
    return response.blob();
  },

  requestAccountDeletion(): Promise<GdprDeletionRequestResponse> {
    return identityPrivacyClient.post<GdprDeletionRequestResponse>(
      identityPrivacyEndpoints.gdprDeletionRequest,
      {},
    );
  },

  cancelAccountDeletion(): Promise<GdprDeletionCancelResponse> {
    return identityPrivacyClient.post<GdprDeletionCancelResponse>(
      identityPrivacyEndpoints.gdprDeletionCancel,
      {},
    );
  },

  getDeletionStatus(): Promise<GdprRequestStatusResponse> {
    return identityPrivacyClient.get<GdprRequestStatusResponse>(
      identityPrivacyEndpoints.gdprDeletionStatus,
    );
  },
};
