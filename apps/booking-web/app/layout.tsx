import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Book Your Stay",
  description: "Book your perfect hotel stay.",
  icons: {
    icon: [{ url: "/vayada-logo.png" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
