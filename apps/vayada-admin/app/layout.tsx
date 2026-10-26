import type { Metadata } from "next";
import { uiFontFamily } from "@vayada/fonts/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vayada Admin - Authentication",
  description: "Admin authentication for vayada",
  icons: {
    icon: "/vayada-logo.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: uiFontFamily }}>{children}</body>
    </html>
  );
}
