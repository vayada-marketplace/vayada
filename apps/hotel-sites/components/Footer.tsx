import type { HotelSite } from "@/sites/types";

export function Footer({ site }: { site: HotelSite }) {
  const { footer } = site;
  const contacts: { label: string; href: string }[] = [];
  if (footer.phone)
    contacts.push({ label: footer.phone, href: `tel:${footer.phone.replace(/[^+\d]/g, "")}` });
  if (footer.whatsappUrl) contacts.push({ label: "WhatsApp", href: footer.whatsappUrl });
  if (footer.email) contacts.push({ label: footer.email, href: `mailto:${footer.email}` });
  if (footer.instagramUrl) contacts.push({ label: "Instagram", href: footer.instagramUrl });
  return (
    <footer id="contact" className="footer">
      <div className="footer-inner">
        <h2>{footer.headline}</h2>
        <a href={site.bookingUrl} className="button-light">
          {footer.cta}
        </a>
        {contacts.length > 0 && (
          <address className="footer-contact">
            {contacts.map((contact) => (
              <a key={contact.href} href={contact.href}>
                {contact.label}
              </a>
            ))}
          </address>
        )}
        <div className="footer-meta">
          <span>{site.name}</span>
          <span>
            {site.address.locality}, {site.address.country}
          </span>
        </div>
      </div>
    </footer>
  );
}
