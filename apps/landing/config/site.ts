import { ROUTES } from "@/lib/constants/routes";

// Sign-up lives in Booking Admin, not on this marketing site.
const SIGNUP_URL = ROUTES.SIGNUP;

export const siteConfig = {
  name: "vayada",
  description:
    "Booking Engine, PMS and Channel Manager for independent hotels that want direct bookings.",
  url: "https://vayada.com",
  ogImage: "/og-image.jpg",
  links: {
    twitter: "https://twitter.com/vayada",
    github: "https://github.com/vayada",
    instagram: "https://www.instagram.com/glorioushotels/",
    linkedin: "https://linkedin.com/company/vayada",
    whatsapp: "https://wa.me/your-number",
  },
  // Note: Colors are now centralized in tailwind.config.js
  // Use Tailwind classes: primary-500, success-500, warning-500, error-500, info-500
  footer: {
    description: "Direct booking tools for independent hotels.",
    links: {
      hotels: [
        { label: "Booking Engine", href: "/booking-engine" },
        { label: "PMS", href: "/pms" },
        { label: "Pricing", href: "/pricing" },
        { label: "Sign Up", href: SIGNUP_URL },
      ],
      company: [
        { label: "About", href: "/about" },
        { label: "Contact", href: "/contact" },
      ],
    },
  },
} as const;
