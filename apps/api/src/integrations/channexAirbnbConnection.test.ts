import { expect, it, vi } from "vitest";
import { createChannexAirbnbConnectionProvider } from "./channexAirbnbConnection.js";
const id = "10090000-0000-4000-8000-000000000001";
const binding = { environment: "staging" as const, groupId: id, externalPropertyId: id };
const attempt = { propertyId: id, sourceId: id, state: "x".repeat(43) };
const config = {
  environment: "staging" as const,
  apiKey: "synthetic-key",
  callbackOrigin: "https://marketplace.example.test",
};
const response = (url = "https://www.airbnb.com/oauth2/auth?synthetic=true") =>
  Response.json({ data: { type: "connection_link", attributes: { url } } });
it("requests one link with fixed destinations and only the resolved property", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
  const provider = createChannexAirbnbConnectionProvider({ ...config, fetcher });
  expect(await provider.createLink(binding, attempt)).toContain("https://www.airbnb.com/");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://staging.channex.io/api/v1/meta/airbnb/connection_link");
  expect(init).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: { "user-api-key": "synthetic-key" },
  });
  expect(JSON.parse(String(init?.body))).toEqual({
    connection_link: {
      group_id: id,
      properties: [id],
      token: attempt.state,
      redirect_uri: `${config.callbackOrigin}/setup/airbnb-return/${id}/${id}`,
      failure_redirect_uri: `${config.callbackOrigin}/setup/airbnb-return/${id}/${id}`,
      title: "Vayada onboarding",
      settings: { send_email_notifications: false },
    },
  });
});
it.each([
  "https://airbnb.com.evil.test/",
  "https://www.airbnb.com@evil.test/",
  "http://www.airbnb.com/",
  "javascript:alert(1)",
  "https://www.airbnb.com:8443/",
  "https://user@www.airbnb.com/",
])("rejects unsafe provider redirect %s", async (url) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(url));
  await expect(
    createChannexAirbnbConnectionProvider({ ...config, fetcher }).createLink(binding, attempt),
  ).rejects.toThrow("could not be generated");
});
it("rejects mixed environments and invalid IDs before sending a key", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const provider = createChannexAirbnbConnectionProvider({ ...config, fetcher });
  await expect(
    provider.createLink({ ...binding, environment: "production" }, attempt),
  ).rejects.toThrow("binding");
  await expect(
    provider.createLink(binding, { ...attempt, propertyId: "../other" }),
  ).rejects.toThrow("attempt");
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  "http://marketplace.example.test",
  "https://marketplace.example.test/other",
  "https://user@marketplace.example.test",
  "https://marketplace.example.test?next=other",
])("rejects non-origin callback configuration", (callbackOrigin) => {
  expect(() => createChannexAirbnbConnectionProvider({ ...config, callbackOrigin })).toThrow(
    "configuration",
  );
});
it("sanitizes transport errors", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("synthetic-key private-detail"));
  await expect(
    createChannexAirbnbConnectionProvider({ ...config, fetcher }).createLink(binding, attempt),
  ).rejects.toThrow(/^Airbnb connection link could not be generated$/);
});
