# Taboola Tracking Debug Report (2026-05-26)

## Objective
Get Taboola S2S conversions tracked reliably for Shopify orders by preserving the landing page URL (with tblci/click-id) through checkout and extracting it in the Cloudflare Worker.

## Current Pipeline (Expected Flow)
1. User lands on product URL with Taboola click param (default: tblci).
2. Shopify theme snippet captures the click id and first landing URL.
3. Snippet writes cart attributes:
   - tb_click_id
   - click-id
   - click_id
   - tblci
   - taboola_click_id
   - tb_landing_page_url_original
4. Shopify order is created. Order fields should include the landing URL or cart attributes.
5. Webhook (Fastrr/Shiprocket) hits the Cloudflare Worker.
6. Worker extracts click id from landing_page_url or Shopify Admin API order fields.
7. Worker sends bulk S2S conversion to Taboola.

## Changes Made in This Repo
### Shopify snippet (theme)
File: shopify-click-id-snippet.html
- Captures tblci and other aliases.
- Saves the first landing URL to localStorage.
- Writes cart attributes for click id and landing URL.
- Verifies /cart.js contains the saved attributes and retries if needed.

### Cloudflare Worker
File: src/index.js
- Prefers landing page URL from Shopify order fields before falling back to click-id fields.
- Expanded Shopify lookup candidates (order_id, api_order_id, shopify_order_id, checkout_id, cart_id).
- Added diagnostic logs for Shopify Admin API availability and when an order is returned but click-id is missing.

### Wrangler config
File: wrangler.toml
- Added SHOPIFY_SHOP_DOMAIN = "uismgu-m5.myshopify.com".
- Admin token stored via Wrangler secret (value not in repo).

### README updates
File: README.md
- Clarified Shopify Admin API setup and landing URL fallback logic.

## Observed Logs (Key Samples)
### Successful extraction
- [findClickId] Extracted from landing_page_url
- Sending to Taboola | order: <cart_id> | revenue: <amount>
- Taboola accepted | order: <cart_id>

### Failing extraction (common issue)
- [findClickId] landing_page_url present but no click-id param | params: 
- Order: <cart_id> | revenue: <amount> | click-id: NOT FOUND
- No click-id | landing_page_url: https://satmi.in/

This means the landing URL stored in the order has already been reduced to the homepage, so no click id remains to extract.

## What Changed (Likely)
No code changes in this repo explain the landing URL being reduced to the homepage. The change is more likely in the browsing or checkout flow:
- The full landing URL is not preserved into the Shopify order.
- The checkout session may be created after a redirect or app flow that strips query params.
- A “Buy Now” or headless checkout path may bypass cart attributes.
- Shopify landing_page_url fields can be overwritten or normalized in some sessions.

## Why Tracking Fails for Some Orders
- The worker only sees what Shopify stores on the order. If the landing URL is stored as https://satmi.in/, the click id is already gone.
- This is not a rate-limit error; logs show normal processing, but the URL does not contain click params.
- Webhook logic is not the root cause; it cannot reconstruct a missing click id.

## What We Verified
- The Taboola bulk S2S endpoint is correct and returns 204 when accepted.
- When landing_page_url includes tblci, tracking works and Taboola accepts.
- Shopify Admin API fallback is configured and working (token stored via Wrangler secret).

## Most Likely Culprits
1. Checkout flow bypasses cart attribute propagation (e.g., headless checkout or app).
2. Redirects strip query params before checkout session is created.
3. Shopify order fields are storing only the domain or a normalized landing URL.

## Recommended Next Checks
1. On the product page, open the browser console and verify:
   - localStorage.tb_first_landing_url
   - /cart.js contains attributes.tb_landing_page_url_original
2. Use tblci as the primary test param (Taboola default) unless you configured a custom param in Taboola.
3. Check whether the order was placed via a standard Shopify checkout or a custom/fast checkout path.
4. Inspect Shopify Admin order fields (landing_site_ref, landing_site, referring_site, source_url, custom_attributes).

## Why the Webhook Does Not Need Changes
The webhook only reads the payload or the Shopify Admin API order record. If Shopify stores the landing URL as https://satmi.in/, the webhook cannot recover the click id.

## Summary
Tracking works when the landing URL with tblci survives into the Shopify order record. The current blocker is that some orders are losing the full landing URL before the order is created, resulting in the homepage only. Fixing this requires preserving the landing URL earlier in the checkout flow, not changing the webhook.
