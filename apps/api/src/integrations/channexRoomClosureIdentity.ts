/** Fresh provider-owned proof for the initial room-without-OTA-binding mode.
 * Lists must be complete; unknown shapes or extra provider rates fail closed.
 */
export async function verifyChannexRoomClosureIdentity(
  read: (path: string) => Promise<unknown>,
  scope: { propertyId: string; roomId: string; rateIds: string[] },
): Promise<void> {
  type Item = {
    id: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, { data?: { id?: string } }>;
  };
  async function list(kind: string): Promise<Item[]> {
    const query = new URLSearchParams({
      "filter[property_id]": scope.propertyId,
      "pagination[limit]": "100",
    });
    const body = (await read(`/api/v1/${kind}?${query}`)) as {
      data?: Item[];
      meta?: { total?: number };
    } | null;
    if (
      !Array.isArray(body?.data) ||
      body.meta?.total !== body.data.length ||
      body.data.some((item) => !item || typeof item.id !== "string")
    )
      throw new Error("channex_closure_identity_incomplete");
    return body.data;
  }
  const rates = await list("rate_plans");
  if (
    rates.some(
      (rate) =>
        rate.relationships?.property?.data?.id !== scope.propertyId ||
        typeof rate.relationships?.room_type?.data?.id !== "string",
    )
  )
    throw new Error("channex_closure_identity_incomplete");
  const roomRates = rates.filter(
    (rate) => rate.relationships?.room_type?.data?.id === scope.roomId,
  );
  if (
    roomRates.length !== scope.rateIds.length ||
    roomRates.some(
      (rate) =>
        rate.relationships?.property?.data?.id !== scope.propertyId ||
        !scope.rateIds.includes(rate.id),
    ) ||
    !scope.rateIds.every((id) => roomRates.some((rate) => rate.id === id))
  )
    throw new Error("channex_closure_provider_identity_mismatch");
  const channels = await list("channels");
  const identities = new Set([scope.roomId, ...scope.rateIds]);
  function referencesRoom(value: unknown): boolean {
    if (typeof value === "string") return identities.has(value);
    if (Array.isArray(value)) return value.some(referencesRoom);
    if (value && typeof value === "object")
      return Object.entries(value).some(
        ([key, item]) => identities.has(key) || referencesRoom(item),
      );
    return false;
  }
  if (
    channels.some(
      (channel) =>
        !Array.isArray(channel.attributes?.rate_plans) ||
        channel.attributes.rate_plans.some(
          (mapping: unknown) =>
            !mapping ||
            typeof mapping !== "object" ||
            typeof (mapping as { rate_plan_id?: unknown }).rate_plan_id !== "string",
        ) ||
        referencesRoom(channel),
    )
  )
    throw new Error("channex_closure_ota_binding_unsupported");
}
