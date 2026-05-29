import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Growth dashboard · Admin · vayada platform",
  description: "Platform-level growth analytics for vayada super-admins",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
