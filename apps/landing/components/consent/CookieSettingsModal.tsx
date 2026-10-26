"use client";
import { CookieSettingsModal as CookieSettingsModalView } from "./CookieSettingsModalView";
import { useCookieConsent } from "@/context/CookieConsentContext";
export function CookieSettingsModal() {
  return <CookieSettingsModalView controls={useCookieConsent()} privacyHref="/privacy" />;
}
export default CookieSettingsModal;
