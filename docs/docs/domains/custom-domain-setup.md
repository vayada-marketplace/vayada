---
sidebar_position: 1
---

# Custom Domain Setup

Hotels can use their own domain (e.g. `book.hotelname.com`) instead of the default `hotelslug.booking.vayada.com` subdomain. This guide explains how to set it up.

## Overview

When a hotel wants to use a custom domain for their booking engine, there are two things that need to happen:

1. **The hotel** adds a DNS record pointing their domain to vayada
2. **We (vayada)** configure our system to recognize and serve that domain with SSL

## Step-by-Step

### 1. Ask the hotel for their desired domain

The hotel needs to decide which domain they want to use. Common options:

- `book.hotelname.com` (recommended)
- `reserve.hotelname.com`
- `booking.hotelname.com`

:::tip
We recommend using a **subdomain** like `book.hotelname.com` rather than their root domain `hotelname.com`, since the root domain likely already hosts their main website.
:::

### 2. Hotel adds a CNAME record

The hotel (or their IT person) needs to add a **CNAME** DNS record:

| Type  | Name   | Target               |
| ----- | ------ | -------------------- |
| CNAME | `book` | `booking.vayada.com` |

**How to explain this to the hotel:**

> "Please ask your domain provider (e.g. GoDaddy, Namecheap, Cloudflare) to add a CNAME record for `book` pointing to `booking.vayada.com`. If you're not sure how, we can hop on a quick call and walk you through it."

:::note
DNS changes can take up to 24–48 hours to propagate, but usually it's done within minutes.
:::

### 3. Configure the custom domain in Cloudflare

Once the hotel has added their CNAME record, we need to add the domain to our Cloudflare setup so SSL works:

1. Log in to the **Cloudflare dashboard**
2. Go to the **SSL/TLS** > **Custom Hostnames** section
3. Add the hotel's custom domain (e.g. `book.hotelname.com`)
4. Cloudflare will issue an SSL certificate automatically

### 4. Update the hotel's settings in the Booking Admin

1. Go to **[admin.booking.vayada.com](https://admin.booking.vayada.com)**
2. Find the hotel in the admin panel
3. In the hotel's **Settings** > **Domain** section, enter the custom domain
4. Save

### 5. Verify it works

1. Open the custom domain in a browser (e.g. `https://book.hotelname.com`)
2. Check that:
   - The page loads without SSL errors
   - The hotel's booking engine is displayed
   - The branding (logo, colors) is correct

## Troubleshooting

| Problem                      | Likely cause                               | Fix                                                 |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------- |
| "This site can't be reached" | DNS not propagated yet, or CNAME not added | Ask the hotel to double-check their DNS settings    |
| SSL certificate error        | Cloudflare hasn't issued the cert yet      | Wait a few minutes, then check Cloudflare dashboard |
| Wrong hotel showing          | Domain mapped to wrong hotel in admin      | Check the domain setting in Booking Admin           |
| Page loads but looks broken  | CSS/assets not loading over HTTPS          | Check Cloudflare SSL mode is set to "Full"          |

## Removing a custom domain

If a hotel no longer wants to use their custom domain:

1. Remove the domain from the hotel's settings in Booking Admin
2. Remove the custom hostname from Cloudflare
3. Ask the hotel to remove their CNAME record (optional, but tidy)
