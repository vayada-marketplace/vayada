"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import HeroSection from "@/components/booking/HeroSection";
import StepIndicator from "@/components/booking/StepIndicator";
import BookingFooter from "@/components/layout/BookingFooter";
import { useHotel } from "@/contexts/HotelContext";
import type { BookStep } from "@/lib/bookFlow";

/** The old booking pages' frame around each /book step (VAY-2195): the hotel's hero, the step's
 * title with the step indicator, and the footer. */
export default function BookShell({
  steps,
  current,
  title,
  subtitle,
  children,
}: {
  steps: readonly BookStep[];
  current: BookStep;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const t = useTranslations("steps");
  const { hotel } = useHotel();
  const labels: Record<BookStep, string> = {
    rooms: t("rooms"),
    extras: t("addons"),
    payment: t("payment"),
  };
  return (
    <div className="min-h-screen bg-gray-50">
      <HeroSection
        heroImage={hotel.heroImage}
        heading={hotel.branding?.heroHeading || hotel.name}
        subtext={hotel.branding?.heroSubtext || hotel.description}
      />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-10 gap-4">
          <div>
            <h1 className="text-3xl font-heading text-gray-900">{title}</h1>
            {subtitle && <p className="text-gray-500 mt-1">{subtitle}</p>}
          </div>
          <StepIndicator
            steps={steps.map((step, index) => ({ number: index + 1, label: labels[step] }))}
            currentStep={steps.indexOf(current) + 1}
          />
        </div>
        {children}
      </main>
      <BookingFooter />
    </div>
  );
}
