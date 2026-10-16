import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { uiFontFamily } from "@vayada/fonts/ui";
import "./globals.css";
import { CookieConsentProvider } from "@/context/CookieConsentContext";
import { CookieBanner, CookieSettingsModal } from "@/components/consent";

// Self-hosted Inter (packages/fonts): no build or browser contacts Google.
const uiFont = { fontFamily: uiFontFamily, "--font-sans": uiFontFamily } as CSSProperties;

export const metadata: Metadata = {
  title: "Vayada - Direct distribution for independent hotels",
  description:
    "Booking engine, PMS, creator network and AI distribution intelligence, built for independent hospitality.",
  icons: {
    icon: [
      { url: "/vayada-logo.png" },
      { url: "/vayada-logo.png", sizes: "64x64", type: "image/png" },
    ],
    apple: [{ url: "/vayada-logo.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={uiFont}>
        <CookieConsentProvider>
          {children}
          <CookieBanner />
          <CookieSettingsModal />
        </CookieConsentProvider>
      </body>
    </html>
  );
}
