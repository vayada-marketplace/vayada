---
sidebar_position: 2
---

# Default Subdomain

Every hotel on vayada automatically gets a booking page at:

```
https://<hotel-slug>.booking.vayada.com
```

## How it works

- When a hotel is created, it gets a unique **slug** (e.g. `hotel-alpenrose`)
- The booking engine frontend resolves the subdomain and loads the correct hotel's data
- No extra DNS or configuration is needed — it just works

## Finding a hotel's subdomain

The hotel's slug is set during onboarding. You can find it in:

- **Marketplace Admin** > Hotels > click on the hotel > look for the slug field
- **Booking Admin** > Settings > Property Info

The full booking URL is: `https://<slug>.booking.vayada.com`

## Changing a hotel's slug

:::caution
Changing a slug will break any existing links or bookmarks to the old URL. Only do this if the hotel hasn't gone live yet, or coordinate the change with them.
:::

1. Go to **Booking Admin** > the hotel's settings
2. Update the slug field
3. The old subdomain will stop working immediately
4. The new subdomain will work right away

## When to use a custom domain instead

Some hotels prefer their own domain for branding reasons. See [Custom Domain Setup](./custom-domain-setup) for how to set that up. The default subdomain will continue to work even after a custom domain is configured.
