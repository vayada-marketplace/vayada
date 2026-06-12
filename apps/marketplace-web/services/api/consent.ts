import {
  cancelAccountDeletion,
  downloadExport,
  getConsentHistory,
  getConsentStatus,
  getCookieConsent,
  getDeletionStatus,
  getExportStatus,
  requestAccountDeletion,
  requestDataExport,
  saveCookieConsent,
  updateMarketingConsent,
  type ConsentHistoryItem,
  type ConsentHistoryResponse,
  type ConsentStatusResponse,
  type CookieConsentRequest,
  type CookieConsentResponse,
  type GdprDeletionCancelResponse,
  type GdprDeletionRequestResponse,
  type GdprExportRequestResponse,
  type GdprRequestStatusResponse,
  type UpdateMarketingConsentRequest,
  type UpdateMarketingConsentResponse,
} from "@vayada/marketplace-shared/api/privacy";

export type {
  ConsentHistoryItem,
  ConsentHistoryResponse,
  ConsentStatusResponse,
  CookieConsentRequest,
  CookieConsentResponse,
  GdprDeletionCancelResponse,
  GdprDeletionRequestResponse,
  GdprExportRequestResponse,
  GdprRequestStatusResponse,
  UpdateMarketingConsentRequest,
  UpdateMarketingConsentResponse,
};

export const consentService = {
  saveCookieConsent,
  getCookieConsent: async (visitorId: string): Promise<CookieConsentResponse | null> => {
    try {
      return await getCookieConsent(visitorId);
    } catch {
      return null;
    }
  },
  getConsentStatus,
  updateMarketingConsent,
  getConsentHistory,
  requestDataExport,
  getExportStatus,
  downloadExport,
  requestAccountDeletion,
  cancelAccountDeletion,
  getDeletionStatus,
};
