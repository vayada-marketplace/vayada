"use client";

import type { ComponentType } from "react";
import Link from "next/link";
import { cn } from "./cn";

export interface SettingsCardLink {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** Cards without a page show "Coming soon" and are not links. */
  href?: string;
}

interface SettingsCardGridProps {
  /** The wide card on top (Feature Hub). */
  featured: SettingsCardLink & { href: string };
  cards: SettingsCardLink[];
  openLabel: string;
  comingSoonLabel: string;
  className?: string;
}

const cardClass = "flex h-full flex-col rounded-2xl border bg-white p-5 transition-colors md:p-6";

/** The Settings landing page of Booking Admin and the PMS: a wide card on top, then 3 per row. */
export function SettingsCardGrid({
  featured,
  cards,
  openLabel,
  comingSoonLabel,
  className,
}: SettingsCardGridProps) {
  const labels = { openLabel, comingSoonLabel };
  return (
    <div className={className}>
      <Link
        href={featured.href}
        className={cn(
          cardClass,
          "border-primary-200 bg-primary-50/60 hover:border-primary-300 hover:bg-primary-50",
        )}
      >
        <CardBody card={featured} wide {...labels} />
      </Link>
      <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <li key={card.title}>
            {card.href ? (
              <Link
                href={card.href}
                className={cn(
                  cardClass,
                  "border-gray-200 hover:border-primary-200 hover:bg-primary-50/40",
                )}
              >
                <CardBody card={card} {...labels} />
              </Link>
            ) : (
              <div aria-disabled="true" className={cn(cardClass, "border-gray-200 opacity-70")}>
                <CardBody card={card} {...labels} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CardBody({
  card,
  wide = false,
  openLabel,
  comingSoonLabel,
}: {
  card: SettingsCardLink;
  wide?: boolean;
  openLabel: string;
  comingSoonLabel: string;
}) {
  const Icon = card.icon;
  return (
    <>
      <span className="flex items-center gap-4">
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
            wide ? "bg-white text-primary-600" : "bg-primary-50 text-primary-600",
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <span className="text-[15px] font-semibold text-gray-900">{card.title}</span>
      </span>
      <span className="mt-4 block flex-1 text-[13px] leading-5 text-gray-600">
        {card.description}
      </span>
      {card.href ? (
        <span className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-primary-600">
          {openLabel}
          <ArrowRightIcon />
        </span>
      ) : (
        <span className="mt-4 inline-flex w-fit rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-600">
          {comingSoonLabel}
        </span>
      )}
    </>
  );
}

// Heroicons 24/outline arrow-right, inlined so the package needs no icon dependency.
function ArrowRightIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden="true"
      data-slot="icon"
      className="h-3.5 w-3.5"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
    </svg>
  );
}
