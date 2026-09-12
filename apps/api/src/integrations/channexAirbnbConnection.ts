import { z } from "zod";
import { readChannexAirbnbImport } from "./channexAirbnbImport.js";
import { readChannexImportResponse } from "./channexImportResponse.js";

type Binding = {
  environment: "staging" | "production";
  groupId: string;
  externalPropertyId: string;
};
type Attempt = { state: string; sourceId: string; propertyId: string };

export function createChannexAirbnbConnectionProvider(options: {
  environment: Binding["environment"];
  apiKey: string;
  callbackOrigin: string;
  fetcher?: typeof fetch;
}) {
  const callback = new URL(options.callbackOrigin);
  if (
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.pathname !== "/" ||
    callback.search ||
    callback.hash ||
    !options.apiKey ||
    !["staging", "production"].includes(options.environment)
  )
    throw new Error("Invalid Airbnb connection configuration");
  const providerOrigin =
    options.environment === "staging" ? "https://staging.channex.io" : "https://app.channex.io";
  const fetcher = options.fetcher ?? fetch;
  function validate(binding: Binding) {
    if (
      binding.environment !== options.environment ||
      !z.uuid().safeParse(binding.groupId).success ||
      !z.uuid().safeParse(binding.externalPropertyId).success
    )
      throw new Error("Invalid Airbnb connection binding");
  }
  return {
    async createLink(binding: Binding, attempt: Attempt): Promise<string> {
      validate(binding);
      if (
        !z.uuid().safeParse(attempt.propertyId).success ||
        !z.uuid().safeParse(attempt.sourceId).success ||
        !/^[A-Za-z0-9_-]{43}$/.test(attempt.state)
      )
        throw new Error("Invalid Airbnb connection attempt");
      const redirect = new URL(
        `/setup/airbnb-return/${attempt.propertyId}/${attempt.sourceId}`,
        callback.origin,
      ).href;
      try {
        const response = await fetcher(`${providerOrigin}/api/v1/meta/airbnb/connection_link`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: { "user-api-key": options.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            connection_link: {
              group_id: binding.groupId,
              properties: [binding.externalPropertyId],
              token: attempt.state,
              redirect_uri: redirect,
              failure_redirect_uri: redirect,
              title: "Vayada onboarding",
              settings: { send_email_notifications: false },
            },
          }),
        });
        const result = (await readChannexImportResponse(response)) as {
          data?: { type?: string; attributes?: { url?: unknown } };
        };
        const raw = result?.data?.attributes?.url;
        if (
          result?.data?.type !== "connection_link" ||
          typeof raw !== "string" ||
          raw.length > 8192
        )
          throw new Error();
        const url = new URL(raw);
        if (
          url.protocol !== "https:" ||
          !["airbnb.com", "www.airbnb.com"].includes(url.hostname) ||
          url.port ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error();
        return url.href;
      } catch {
        throw new Error("Airbnb connection link could not be generated");
      }
    },
    async readListings(binding: Binding, channelId: string) {
      validate(binding);
      return readChannexAirbnbImport({ ...binding, channelId }, options);
    },
  };
}
