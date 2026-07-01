import { unsupportedPmsNextStackFeature } from "../api/unsupported";

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
  connect: (_domain: string) =>
    unsupportedPmsNextStackFeature<CustomDomainConnectResponse>("Custom domain connection"),

  disconnect: () => unsupportedPmsNextStackFeature<{ removed: string }>("Custom domain removal"),

  getStatus: () => unsupportedPmsNextStackFeature<CustomDomainStatus>("Custom domain status"),
};
