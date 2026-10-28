/** VAY-2390: the currency guests see first on the booking page when it isn't the pricing currency, with the booking
 * page's own display rate to it, for the PMS Prices footer ("They see ≈ US$73 first"). The rates are the booking
 * page's (VAY-2114: ExchangeRate-API, cached, last good rate kept), never a second provider. Null when guests start
 * in the pricing currency, the currency selector is off, or there is no rate: the footer then says nothing. */
export type PricingGuestDisplayRate = Readonly<{ base: string; currency: string; rate: number }>;
export type PricingGuestDisplayRateReadPort = {
  read(propertyId: string): Promise<PricingGuestDisplayRate | null>;
};

type QueryPool = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
type DisplayRates = {
  rates(base: string, targets: readonly string[]): Promise<Record<string, number>>;
};

export function createPricingGuestDisplayRateReader(config: {
  pool: QueryPool;
  displayRates: DisplayRates;
}): PricingGuestDisplayRateReadPort {
  return {
    async read(propertyId) {
      // As the booking page: Localization's guest display currency, unless the selector is off.
      const result = await config.pool.query(
        `SELECT pricing.currency::text AS base, settings.default_currency::text AS currency
         FROM pms.property_pricing_settings pricing
         JOIN booking.booking_settings settings ON settings.property_id = pricing.property_id
         WHERE pricing.property_id = $1::uuid AND settings.show_currency_selector IS NOT FALSE`,
        [propertyId],
      );
      const row = result.rows[0] as { base: string | null; currency: string | null } | undefined;
      const base = row?.base;
      const currency = row?.currency;
      if (!base || !currency || !/^[A-Z]{3}$/.test(currency) || currency === base) return null;
      const rate = (await config.displayRates.rates(base, [currency]))[currency];
      return rate !== undefined && Number.isFinite(rate) && rate > 0
        ? { base, currency, rate }
        : null;
    },
  };
}
