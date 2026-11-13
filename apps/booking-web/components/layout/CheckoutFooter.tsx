"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import FindBookingModal from "@/components/booking/FindBookingModal";
import { useHotel } from "@/contexts/HotelContext";
import { openAnalyticsChoices } from "@/services/api/analyticsConsent";

/** VAY-2495 (Timo's boards): the phone checkout's slim footer on "Your details": the hotel's name,
 * Contact (its phone, WhatsApp and email open below it), Find my booking and Privacy choices, and
 * "Powered by vayada", white on the brand colour. Wide screens keep the full footer. */
export default function CheckoutFooter() {
  const { hotel } = useHotel();
  const t = useTranslations("common");
  const tNav = useTranslations("nav");
  const tm = useTranslations("myBooking");
  const ta = useTranslations("analyticsConsent");
  const [findBookingOpen, setFindBookingOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const contactId = useId();
  const { phone, whatsapp, email } = hotel.contact;
  // The same links as the Contact menu (wa.me takes the digits only, VAY-2473).
  const contacts = [
    phone?.trim() && {
      label: tNav("phone"),
      value: phone,
      href: `tel:${phone.replace(/\s+/g, "")}`,
    },
    whatsapp?.trim() && {
      label: tNav("whatsapp"),
      value: whatsapp,
      href: `https://wa.me/${whatsapp.replace(/\D/g, "")}`,
    },
    email?.trim() && { label: tNav("email"), value: email, href: `mailto:${email}` },
  ].filter((contact): contact is { label: string; value: string; href: string } => !!contact);
  const link = "underline underline-offset-4 transition-opacity hover:opacity-80";
  return (
    <footer className="bg-primary-600 px-6 pb-8 pt-7 text-white lg:hidden">
      <p className="text-[22px] font-bold leading-tight">{hotel.name}</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[15px]">
        {contacts.length > 0 && (
          <button
            type="button"
            className={link}
            aria-expanded={contactOpen}
            aria-controls={contactId}
            onClick={() => setContactOpen((open) => !open)}
          >
            {t("contact")}
          </button>
        )}
        <button type="button" className={link} onClick={() => setFindBookingOpen(true)}>
          {tm("findBooking")}
        </button>
        {/* Reopens the analytics prompt (VAY-2419), as the full footer's link does. */}
        <button
          type="button"
          className={link}
          onClick={(event) => openAnalyticsChoices(event.currentTarget)}
        >
          {ta("settings")}
        </button>
      </div>
      {contactOpen && (
        <ul id={contactId} className="mt-3 space-y-1 text-[15px]">
          {contacts.map((contact) => (
            <li key={contact.href}>
              <a
                href={contact.href}
                className={link}
                {...(contact.href.startsWith("https:") && {
                  target: "_blank",
                  rel: "noopener noreferrer",
                })}
              >
                {contact.label}: {contact.value}
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[13px]">
        {t("poweredBy")} <span className="font-semibold">vayada</span>
      </p>
      <FindBookingModal open={findBookingOpen} onClose={() => setFindBookingOpen(false)} />
    </footer>
  );
}
