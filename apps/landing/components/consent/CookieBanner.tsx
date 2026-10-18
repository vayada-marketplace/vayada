"use client";
import { CookieBanner as CookieBannerView } from "./CookieBannerView";
import { useCookieConsent } from "@/context/CookieConsentContext";
export function CookieBanner() {
  return <CookieBannerView controls={useCookieConsent()} privacyHref="/privacy" />;
}
export default CookieBanner;
