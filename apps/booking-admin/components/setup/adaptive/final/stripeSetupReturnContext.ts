// Only navigation hints survive the hosted return; authorization stays server-owned.
const fields = ["entryProduct", "returnProduct", "returnTo", "recovery"] as const;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function key(organizationId: string, propertyId: string) {
  return `vayada:adaptive:stripe-return:${organizationId}:${propertyId}`;
}
export function saveStripeSetupReturnContext(
  store: Store,
  organizationId: string,
  propertyId: string,
  href: string,
) {
  try {
    const url = new URL(href);
    if (url.pathname !== "/setup" || url.searchParams.get("propertyId") !== propertyId) return;
    const context = Object.fromEntries(
      fields.flatMap((field) =>
        url.searchParams.has(field) ? [[field, url.searchParams.get(field)]] : [],
      ),
    );
    store.setItem(key(organizationId, propertyId), JSON.stringify({ at: Date.now(), context }));
  } catch {
    /* Navigation hints are optional when storage is unavailable. */
  }
}
export function restoreStripeSetupReturnContext(
  store: Store,
  organizationId: string,
  propertyId: string,
  href: string,
): string | null {
  try {
    const url = new URL(href);
    if (
      url.pathname !== "/setup" ||
      url.searchParams.get("propertyId") !== propertyId ||
      !["return", "refresh"].includes(url.searchParams.get("stripe") ?? "")
    )
      return null;
    const stored = store.getItem(key(organizationId, propertyId));
    if (!stored) return null;
    store.removeItem(key(organizationId, propertyId));
    const value = JSON.parse(stored);
    if (
      !Number.isFinite(value.at) ||
      Date.now() - value.at > 3600000 ||
      Date.now() < value.at ||
      !value.context ||
      typeof value.context !== "object"
    )
      return null;
    let changed = false;
    for (const field of fields) {
      const hint = value.context[field];
      if (typeof hint !== "string" || hint.length > 2048 || url.searchParams.has(field)) continue;
      if (
        field === "returnTo" &&
        (!hint.startsWith("/") || hint.startsWith("//") || /[\\\r\n]/.test(hint))
      )
        continue;
      url.searchParams.set(field, hint);
      changed = true;
    }
    return changed ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}
