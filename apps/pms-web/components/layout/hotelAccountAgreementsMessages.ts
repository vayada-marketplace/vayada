import type { HotelAccountAgreementsMessages } from "@vayada/product-onboarding/HotelAccountAgreementsBanner";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** VAY-2246: the agreements banner's words from the PMS catalogs; {placeholders} stay for links. The PMS has
 * no page that shows the acceptance later, so the confirmation doesn't point anywhere. */
export function hotelAccountAgreementsMessages(t: Translate): HotelAccountAgreementsMessages {
  return {
    title: t("agreements.banner.title"),
    body: t("agreements.banner.body"),
    yourAccount: t("agreements.banner.yourAccount"),
    hotelTerms: t("agreements.banner.hotelTerms"),
    meta: t("agreements.banner.meta"),
    read: t("agreements.banner.read"),
    accept: t("agreements.banner.accept"),
    accepting: t("agreements.banner.accepting"),
    failed: t("agreements.banner.failed"),
    accepted: t("agreements.banner.accepted"),
    acceptedWhere: "",
    acceptedWhereLink: "",
    dismiss: t("agreements.banner.dismiss"),
  };
}
