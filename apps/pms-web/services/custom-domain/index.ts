import { apiClient } from "../api/client";

export interface CustomDomainConnectResponse {
  domain: string;
  status: string;
  ssl_status: string;
}

export interface CustomDomainStatus {
  configured: boolean;
  domain?: string;
  status?: string;
  ssl_status?: string;
  verification_errors?: string[];
}

export const customDomainService = {
  connect: (domain: string) =>
    apiClient.post<CustomDomainConnectResponse>("/admin/settings/custom-domain", { domain }),

  disconnect: () => apiClient.delete<{ removed: string }>("/admin/settings/custom-domain"),

  getStatus: () => apiClient.get<CustomDomainStatus>("/admin/settings/custom-domain/status"),
};
