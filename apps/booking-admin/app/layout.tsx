import type { Metadata } from "next";
import { uiFontFamily } from "@vayada/fonts/ui";
import "./globals.css";
import { Providers } from "./providers";

// VAY-2516: pages render per request, so each one carries its request's CSP nonce (proxy.ts).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "vayada Booking Engine - Admin",
  description: "Hotel admin dashboard for vayada Booking Engine",
  icons: {
    icon: [{ url: "/vayada-logo.png" }],
    apple: [{ url: "/vayada-logo.png" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body style={{ fontFamily: uiFontFamily }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
