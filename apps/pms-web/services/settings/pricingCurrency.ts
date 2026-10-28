import type { PmsPricingCurrencyChangeBlocker } from "@vayada/domain-pms";
import { ApiErrorResponse } from "../api/client";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "../api/pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";

/** VAY-2390 P5: the property's pricing currency, which guests are charged in, as the Owner's
 * protected change needs it: its revision and the currencies it may change to. */
export type PricingCurrencyState = {
  propertyId: string;
  currency: string;
  revision: number;
  supported: string[];
};

export type PricingCurrencyChangeOutcome =
  | { kind: "changed"; currency: string }
  | { kind: "blocked"; blockers: PmsPricingCurrencyChangeBlocker[] }
  | { kind: "stale" };

const endpoint = (id: string) => `/api/pms/properties/${encodeURIComponent(id)}/pricing-source`;

export const pricingCurrencyService = {
  async load(): Promise<PricingCurrencyState> {
    const propertyId = await resolveSelectedPmsPropertyId("loading the property currency");
    const [source, capabilities] = await Promise.all([
      pmsOperationsClient.get<{
        pricingCurrency: { currency: string; pricingCurrencyRevision: number };
      }>(endpoint(propertyId), pmsOperationsRequestOptions),
      pmsOperationsClient.get<{ supportedCurrencies: { code: string }[] }>(
        `${endpoint(propertyId)}/currency-capabilities`,
        pmsOperationsRequestOptions,
      ),
    ]);
    return {
      propertyId,
      currency: source.pricingCurrency.currency,
      revision: source.pricingCurrency.pricingCurrencyRevision,
      supported: capabilities.supportedCurrencies.map(({ code }) => code),
    };
  },

  /** A refusal for upcoming bookings, channels or older records comes back as `blocked`, with
   * nothing changed; another change since the state was read comes back as `stale`. */
  async change(
    state: PricingCurrencyState,
    currency: string,
    key: string,
  ): Promise<PricingCurrencyChangeOutcome> {
    try {
      const response = await pmsOperationsClient.put<{ pricingCurrency: { currency: string } }>(
        `${endpoint(state.propertyId)}/currency-change`,
        { expectedPricingCurrencyRevision: state.revision, currency },
        {
          ...pmsOperationsRequestOptions,
          headers: { ...pmsOperationsRequestOptions.headers, "Idempotency-Key": key },
        },
      );
      return { kind: "changed", currency: response.pricingCurrency.currency };
    } catch (error) {
      if (error instanceof ApiErrorResponse && error.status === 409) {
        const body = error.data as { code?: unknown; blockers?: unknown };
        if (body.code === "pricing_currency_change_blocked" && Array.isArray(body.blockers))
          return { kind: "blocked", blockers: body.blockers as PmsPricingCurrencyChangeBlocker[] };
        if (body.code === "pricing_currency_revision_conflict") return { kind: "stale" };
      }
      throw error;
    }
  },
};
