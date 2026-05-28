# Taboola S2S Worker for Shiprocket

Cloudflare Worker that receives Shiprocket shipment webhooks and sends Taboola S2S conversions.

The important constraint from Shiprocket’s docs is that the webhook payload does not include Taboola click-id by default. For attribution to work, the worker now prefers the Shopify order record and extracts the landing page URL from there first, then pulls a Taboola click-id out of that URL. If Shopify does not expose a usable landing page URL, it falls back to the click-id fields already copied into order data.

## Prereqs
- Node.js 18+
- Cloudflare account
- Wrangler CLI: npm install -g wrangler

## Setup
1. Log in to Cloudflare:
   wrangler login
2. Configure variables in wrangler.toml:
   - TABOOLA_ACCOUNT_ID
   - TABOOLA_EVENT_NAME
   - DEFAULT_CURRENCY
3. If you want the Shiprocket order lookup fallback, set these secrets:
  - `SHIPROCKET_EMAIL`
  - `SHIPROCKET_PASSWORD`
4. Optional webhook protection:
  - `SHIPROCKET_WEBHOOK_SECRET` or `SHIPROCKET_WEBHOOK_TOKEN`
  - Shiprocket sends this as `anx-api-key`
5. If you want the Shopify Admin API fallback, set these too:
  - `SHOPIFY_SHOP_DOMAIN` in `wrangler.toml`
  - `SHOPIFY_ADMIN_ACCESS_TOKEN` as a Wrangler secret:
    - `wrangler secret put SHOPIFY_ADMIN_ACCESS_TOKEN`
6. If you want the KV bridge (recommended for checkout flows that drop params):
   - Create a KV namespace and bind it as `CID_STORE` in `wrangler.toml`
   - Example:
     - `wrangler kv:namespace create CID_STORE`
7. Deploy:
   wrangler deploy

## Endpoints
- POST /shiprocket-webhook
- POST /shiprocket-order-created
- POST /fastrr-webhook  (legacy alias)
- GET /health

## Shopify click-id capture (required)
Copy the contents of shopify-click-id-snippet.html into your Shopify theme inside <head>.

What the snippet does:
- Captures click-id aliases (click-id, click_id, tb_click_id, tblci, tblclid, tbclid)
- Stores first landing URL in localStorage (tb_first_landing_url)
- Writes stable cart attributes for backward compatibility:
  - tb_click_id
  - click-id
  - click_id
  - tblci
  - taboola_click_id
  - tb_landing_page_url_original
- Retries /cart/update.js writes for better reliability

What still has to happen upstream:
- Shopify must retain the order landing page fields. The worker checks `landing_site_ref`, `landing_site`, `landing_page_url`, `referring_site`, `source_url`, and related note/custom attributes through the Admin API.
- If that landing page URL contains a Taboola id, the worker extracts it and uses that for attribution.
- If the landing page URL does not contain a Taboola id, the worker still tries the older click-id fields in Shiprocket or Shopify order data.
- If neither source contains a usable id, the worker intentionally skips the conversion.

## Shiprocket Webhook Payload
The worker expects the Shiprocket webhook shape from your docs. The fields it uses are:
- `awb`
- `courier_name`
- `current_status`
- `current_status_id`
- `shipment_status`
- `shipment_status_id`
- `current_timestamp`
- `order_id`
- `sr_order_id`
- `awb_assigned_date`
- `pickup_scheduled_date`
- `etd`
- `scans[]`
- `is_return`
- `channel_id`
- `pod_status`
- `pod`
- `qc_image`
- `qc_failure_reason`

For conversion tracking, the worker only fires Taboola when the shipment looks delivered or completed. In other words, `IN TRANSIT` is skipped; `DELIVERED` or equivalent is accepted.

The code also tries to recover the purchase value from the Shiprocket order detail endpoint, using `sr_order_id` or `order_id` when available.

If you want tracking to fire shortly after the order is placed, call `/shiprocket-order-created` from your order-creation flow. Use `/shiprocket-webhook` only as the later shipment-status fallback.

## Shiprocket webhook config
- Webhook Type: Real Time
- API Endpoint: `https://taboola-s2s.<your-subdomain>.workers.dev/shiprocket-webhook`
- Headers: `Content-Type: application/json`
- Optional security token header: `anx-api-key`
- Respond with HTTP 200 only

Do not use `shiprocket`, `kartrocket`, `sr`, or `kr` in the webhook URL if Shiprocket blocks those substrings in your account.

## Local test
Run:
  wrangler dev

Health check:
  curl http://localhost:8787/health

Test with direct click-id:
  curl -X POST http://localhost:8787/shiprocket-webhook \
    -H "Content-Type: application/json" \
    -d '{
      "awb": "19041424751540",
      "courier_name": "Delhivery Surface",
      "current_status": "DELIVERED",
      "current_status_id": 30,
      "shipment_status": "DELIVERED",
      "shipment_status_id": 30,
      "order_id": "1373900_150876814",
      "sr_order_id": 348456385,
      "tb_click_id": "GiC3sJdfEHXrroWoRIMZNc-HmQGs4UllzePkXl8h7XSOfSDOqFUoqNjkqZDk_6u1ATCn214",
      "total": 1299,
      "currency": "INR",
      "scans": [{"date":"2023-05-23 11:43:46","status":"DEL","activity":"Delivered to customer","location":"Mumbai","sr-status":"DELIVERED","sr-status-label":"DELIVERED"}]
    }'

If you are debugging click-id recovery from Shiprocket order details, set `SHIPROCKET_EMAIL` and `SHIPROCKET_PASSWORD` as secrets and put the click-id in the order field your upstream flow preserves.

To test immediate post-purchase tracking, POST the order payload to `/shiprocket-order-created` right after the order is created and confirm Taboola receives the conversion.

## Troubleshooting
- Logs show "No click-id - skipped": click-id did not arrive in payload and could not be parsed.
- Logs show "Invalid signature - rejecting": webhook secret/header mismatch.
- Non-204 response from Taboola: inspect worker logs for Taboola response body.
