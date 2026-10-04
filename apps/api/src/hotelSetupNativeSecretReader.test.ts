import { expect, it, vi } from "vitest";
import { createHotelSetupNativeSecretReader } from "./hotelSetupNativeSecretReader.js";

const name = "hotel-setup-command/prod/property/vayada_next_hotel_setup_property_test";
const versionId = "11111111-1111-4111-8111-111111111111";
const result = {
  Name: name,
  VersionId: versionId,
  ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-ABC123`,
  SecretString: JSON.stringify({ username: "fixture", password: "fixture" }),
};
function fixture(response: unknown = result) {
  const send = vi.fn().mockResolvedValue(response);
  return { send, read: createHotelSetupNativeSecretReader({ send }) };
}
it("pins the database-selected native name and immutable version, with no latest fallback", async () => {
  const f = fixture();
  await expect(f.read(name, versionId)).resolves.toEqual({
    username: "fixture",
    password: "fixture",
  });
  expect(f.send.mock.calls[0]![0].input).toEqual({ SecretId: name, VersionId: versionId });
  expect(f.send).toHaveBeenCalledOnce();
});
it.each([
  { ...result, Name: name + "_other" },
  { ...result, VersionId: "22222222-2222-4222-8222-222222222222" },
  { ...result, ARN: result.ARN.replace("269416271598", "111111111111") },
  { ...result, ARN: result.ARN + "x" },
  { ...result, SecretBinary: new Uint8Array([1]) },
  { ...result, SecretString: undefined },
  { ...result, SecretString: "malformed" },
])("denies unexpected secret response metadata or payload without retry", async (response) => {
  const f = fixture(response);
  await expect(f.read(name, versionId)).rejects.toThrow(/^Hotel setup native secret unavailable$/);
  expect(f.send).toHaveBeenCalledOnce();
});
it.each([
  ["oauth/token", versionId],
  [name.replace("property/", "organization/"), versionId],
  [name, "latest"],
  [name, ""],
])("denies invalid native identity before SDK access", async (reference, version) => {
  const f = fixture();
  await expect(f.read(reference, version)).rejects.toThrow("unavailable");
  expect(f.send).not.toHaveBeenCalled();
});
it("sanitizes SDK failure and never retries or reads another credential", async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce(new Error("sensitive SDK diagnostic"));
  await expect(f.read(name, versionId)).rejects.toThrow(/^Hotel setup native secret unavailable$/);
  expect(f.send).toHaveBeenCalledOnce();
});
