import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "vayada",
  description:
    "This address has moved. Hotels continue in Booking Admin; everything else is on vayada.com.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
