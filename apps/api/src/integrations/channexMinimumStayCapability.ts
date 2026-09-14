import { pricingObject } from "@vayada/domain-pms";

/** Initial ARI sends both explicit minimum-stay fields. A property mode that
 * disables either field is unsupported; this is not proof of upload execution.
 */
export async function verifyChannexMinimumStayCapability(
  externalPropertyId: string,
  get: (method: "GET", path: string) => Promise<unknown>,
) {
  const unavailable = () => {
    throw new Error("ari_restriction_capability_unavailable");
  };
  if (
    typeof externalPropertyId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(externalPropertyId)
  )
    unavailable();
  const response = await get("GET", `/api/v1/properties/${externalPropertyId}`);
  if (
    !pricingObject(response) ||
    Object.hasOwn(response, "errors") ||
    Object.hasOwn(response, "warnings") ||
    (response.meta !== undefined &&
      (!pricingObject(response.meta) ||
        (response.meta.warnings !== undefined &&
          (!Array.isArray(response.meta.warnings) || response.meta.warnings.length !== 0))))
  )
    return unavailable();
  const data = response.data;
  if (
    !pricingObject(data) ||
    data.type !== "property" ||
    data.id !== externalPropertyId ||
    !pricingObject(data.attributes)
  )
    return unavailable();
  const attributes = data.attributes;
  if (
    (attributes.id !== undefined && attributes.id !== externalPropertyId) ||
    !pricingObject(attributes.settings) ||
    attributes.settings.min_stay_type !== "both"
  )
    return unavailable();
  return { externalPropertyId, minimumStayMode: "both" as const };
}
