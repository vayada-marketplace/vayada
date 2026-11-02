"use client";

import { ArrowRightIcon } from "@heroicons/react/24/outline";
import Image from "next/image";

import { SETUP_STEPS } from "./SetupFrame";

/**
 * VAY-2451 welcome card, before step 1: the four steps with their times and "Start setup". Timo's mockup also
 * had a Booking.com/Airbnb link import and a WhatsApp help line; both wait (no import by link yet, no number).
 */
export function SetupWelcome({ onStart }: { onStart: () => void }) {
  const minutes = SETUP_STEPS.reduce((total, step) => total + step.minutes, 0);
  return (
    <main className="flex min-h-[100dvh] flex-col items-center bg-gray-50 px-4 py-6 text-gray-950 min-[720px]:px-6 min-[720px]:py-10">
      <Image
        src="/vayada-logo.png"
        alt="vayada"
        width={36}
        height={32}
        priority
        className="h-8 w-auto"
      />
      <section
        aria-labelledby="setup-welcome-heading"
        className="mt-10 w-full max-w-[560px] rounded-[20px] border border-gray-200 bg-white px-5 py-6 min-[720px]:p-10"
      >
        <h1
          id="setup-welcome-heading"
          className="text-[32px] font-bold leading-tight tracking-tight"
        >
          Welcome to vayada
        </h1>
        <p className="mt-2.5 text-base leading-6 text-gray-600">
          {`Let's get your property ready for direct bookings. ${SETUP_STEPS.length} short steps, about ${minutes} minutes. Everything saves as you go, so you can stop anytime.`}
        </p>
        <ol className="mt-7 flex flex-col gap-1">
          {SETUP_STEPS.map((step, index) => (
            <li key={step.id} className="flex items-center gap-3.5 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-50 text-sm font-semibold text-primary-600">
                {index + 1}
              </span>
              <span className="flex flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{step.label}</span>
                <span className="text-[13px] text-gray-500">{step.description}</span>
              </span>
              <span className="text-[13px] text-gray-500">{`${step.minutes} min`}</span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={onStart}
          className="mt-6 inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-primary-600 text-base font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
        >
          Start setup
          <ArrowRightIcon className="h-[18px] w-[18px] stroke-2" aria-hidden="true" />
        </button>
      </section>
    </main>
  );
}
