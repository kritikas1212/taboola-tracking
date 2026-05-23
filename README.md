# Taboola S2S Worker (Fastrr / Shiprocket Webhook)

Cloudflare Worker that receives order webhooks and sends Taboola S2S conversions.

This project uses a no-KV strategy. Reliability comes from saving click-id on the cart
and extracting it from multiple payload locations with robust URL fallback parsing.

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
3. Set webhook secret (recommended):
   wrangler secret put FASTRR_WEBHOOK_SECRET
4. Deploy:
   wrangler deploy

## Endpoints
- POST /fastrr-webhook
- GET /health

## Shopify click-id capture (required)
Copy the contents of shopify-click-id-snippet.html into your Shopify theme inside <head>.

What the snippet does:
- Captures click-id aliases (click-id, click_id, tb_click_id, tblci, tblclid, tbclid)
- Stores first landing URL in localStorage (tb_first_landing_url)
- Writes stable cart attributes:
  - tb_click_id
  - tb_landing_page_url_original
- Retries /cart/update.js writes for better reliability

## Webhook requirements
For reliable conversion tracking, each paid-order webhook should contain click-id in at least one of these locations:
- payload.tb_click_id / payload.click-id / payload.click_id
- payload.cart_attributes.tb_click_id
- payload.note_attributes.tb_click_id
- payload.extra[].key in (tb_click_id, click-id, click_id, tblci, tblclid)
- payload.cart_attributes.tb_landing_page_url_original or landing_page_url with click-id params

If click-id is missing, the worker intentionally skips conversion.

## Fastrr / Shiprocket webhook config
- Webhook Type: Real Time
- API Endpoint: https://taboola-s2s.<your-subdomain>.workers.dev/fastrr-webhook
- Stage: Production
- Headers: Content-Type: application/json
- Signature Header: one of x-webhook-signature / x-fastrr-signature / x-hub-signature-256
- Additional Info mapping: include tb_click_id when available

## Local test
Run:
  wrangler dev

Health check:
  curl http://localhost:8787/health

Test with direct click-id:
  curl -X POST http://localhost:8787/fastrr-webhook \
    -H "Content-Type: application/json" \
    -d '{
      "latest_stage": "order_placed",
      "status": "paid",
      "tb_click_id": "GiC3sJdfEHXrroWoRIMZNc-HmQGs4UllzePkXl8h7XSOfSDOqFUoqNjkqZDk_6u1ATCn214",
      "cart_id": "TEST-1001",
      "total_price": 1299,
      "currency": "INR",
      "items": [{"quantity": 1}]
    }'

Test with click-id only in landing URL:
  curl -X POST http://localhost:8787/fastrr-webhook \
    -H "Content-Type: application/json" \
    -d '{
      "latest_stage": "order_placed",
      "status": "paid",
      "cart_id": "TEST-1002",
      "total_price": 1299,
      "currency": "INR",
      "cart_attributes": {
        "tb_landing_page_url_original": "https://example.com/?utm_source=taboola&tblci=GiC3sJdfEHXrroWoRIMZNc-HmQGs4UllzePkXl8h7XSOfSDOqFUoqNjkqZDk_6u1ATCn214"
      },
      "items": [{"quantity": 1}]
    }'

## Troubleshooting
- Logs show "No click-id - skipped": click-id did not arrive in payload and could not be parsed.
- Logs show "Invalid signature - rejecting": webhook secret/header mismatch.
- Non-204 response from Taboola: inspect worker logs for Taboola response body.
