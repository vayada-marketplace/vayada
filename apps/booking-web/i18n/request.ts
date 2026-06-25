import { getRequestConfig } from "next-intl/server";
import { hasLocale, IntlErrorCode } from "next-intl";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: await loadMessages(locale),
    // A missing translation key must never crash a checkout page. Return an
    // empty string so the `t('key') || 'fallback'` patterns in components
    // resolve to the inline fallback instead of rendering the raw key.
    getMessageFallback: () => "",
    onError: (error) => {
      if (error.code === IntlErrorCode.MISSING_MESSAGE) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(error.message);
        }
        return;
      }
      console.error(error);
    },
  };
});

async function loadMessages(locale: string): Promise<Record<string, unknown>> {
  try {
    return (await import(`../messages/${locale}.json`)).default;
  } catch (error) {
    if (locale !== "nl") throw error;
    return (await import("../messages/en.json")).default;
  }
}
