/**
 * Taboola S2S Cloudflare Worker - NO KV VERSION
 * Account: 1968303 | Event: make_purchase
 *
 * Strategy: extract click-id purely from landing_page_url
 * that Fastrr already includes in every webhook payload.
 * No KV, no cookies, no storefront script needed.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    if (path === '/health' && request.method === 'GET') {
      return corsResponse({ status: 'ok', account: env.TABOOLA_ACCOUNT_ID }, 200);
    }

    if (path === '/fastrr-webhook' && request.method === 'POST') {
      return handleFastrrWebhook(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  }
};

const CLICK_ID_KEYS = [
  'click-id',
  'click_id',
  'tb_click_id',
  'taboola_click_id',
  'tblci',
  'tblclid',
  'tbclid'
];

// Main webhook handler
async function handleFastrrWebhook(request, env, ctx) {
  const rawBody = await request.text();

  // Verify signature if secret is set
  const secret = env.FASTRR_WEBHOOK_SECRET;
  if (secret && secret !== 'mysecret') {
    const sig =
      request.headers.get('x-webhook-signature') ||
      request.headers.get('x-fastrr-signature') ||
      request.headers.get('x-hub-signature-256') ||
      '';
    const valid = await verifyHmacSha256(rawBody, sig, secret);
    if (!valid) {
      console.error('Invalid signature - rejecting');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Bad JSON', { status: 400 });
  }

  const stage = (payload.latest_stage || payload.stage || '').toLowerCase();
  console.log('Webhook received | stage:', stage, '| cart_id:', payload.cart_id);
  console.log('COD fields:', {
    latest_stage: payload.latest_stage,
    stage: payload.stage,
    status: payload.status,
    payment_status: payload.payment_status,
    financial_status: payload.financial_status,
    order_status: payload.order_status,
    payment_method: payload.payment_method || payload.payment_mode
  });

  if (!isPaidOrder(payload)) {
    console.log('Not a paid order - skipping stage:', stage);
    return new Response('Skipped', { status: 200 });
  }

  const order = extractOrder(payload);
  const clickId = findClickId(payload);

  console.log(
    'Order:',
    order.orderId,
    '| revenue:',
    order.revenue,
    '| click-id:',
    clickId ? clickId.slice(0, 20) + '...' : 'NOT FOUND'
  );

  if (!clickId) {
    const d = payload.data?.data || payload.data || payload.order || payload;
    const cartAttrs = payload.cart_attributes || d.cart_attributes || {};
    const landingUrl =
      cartAttrs.tb_landing_page_url_original ||
      cartAttrs.original_landing_page_url ||
      cartAttrs.landing_page_url ||
      payload.original_landing_page_url ||
      payload.landing_page_url ||
      d.original_landing_page_url ||
      d.landing_page_url ||
      'not present';
    console.warn('No click-id | landing_page_url:', String(landingUrl).slice(0, 120));
    return new Response('No click-id - skipped', { status: 200 });
  }

  ctx.waitUntil(sendToTaboola(clickId, order, env));
  return new Response('OK', { status: 200 });
}

// Find click-id - primary strategy: parse from landing_page_url
function findClickId(payload) {
  const d = payload.data?.data || payload.data || payload.order || payload;
  const cartAttrs = payload.cart_attributes || d.cart_attributes || {};
  const noteAttrs = payload.note_attributes || d.note_attributes || {};

  // 1. Direct fields in payload root
  const direct =
    readFirstClickId(payload) ||
    readFirstClickId(d) ||
    readFirstClickId(cartAttrs) ||
    readFirstClickId(noteAttrs) ||
    readFirstClickId(payload.custom_params || {}) ||
    readFirstClickId(payload.metadata || {});

  if (isValidClickIdValue(direct)) {
    console.log('[findClickId] Found in direct fields');
    return direct;
  }

  // 2. Parse from extra[] array (Fastrr Additional Info)
  const extra = payload.extra || d.extra || [];
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (
          CLICK_ID_KEYS.includes(String(item.key || '').toLowerCase().trim()) &&
          isValidClickIdValue(item.value)
      ) {
        console.log('[findClickId] Found in extra[] array');
          return String(item.value).trim();
      }
    }
  }

  // 3. Parse landing_page_url from cart_attributes
  // This is the most reliable path - Fastrr sends this on every order.
  // When user came from Taboola ad, URL contains ?click-id=... or ?tblci=...
  const landingUrl =
    cartAttrs.tb_landing_page_url_original ||
    cartAttrs.original_landing_page_url ||
    cartAttrs.landing_page_url ||
    payload.original_landing_page_url ||
    payload.landing_page_url ||
    d.original_landing_page_url ||
    d.landing_page_url;

  if (landingUrl) {
    const fromUrl = extractClickIdFromUrl(landingUrl);
    if (fromUrl) {
      console.log('[findClickId] Extracted from landing_page_url');
      return fromUrl;
    }
    try {
      const params = new URL(landingUrl).searchParams;
      console.log(
        '[findClickId] landing_page_url present but no click-id param | params:',
        [...params.keys()].join(', ')
      );
    } catch (e) {
      console.warn('[findClickId] Could not parse landing_page_url:', e.message);
    }
  } else {
    console.log('[findClickId] No landing_page_url in payload');
  }

  return null;
}

function extractClickIdFromUrl(urlStr, depth = 0) {
  if (!urlStr || depth > 2) return null;
  try {
    const params = new URL(urlStr, 'https://fallback.local').searchParams;

    for (const key of CLICK_ID_KEYS) {
      const val = params.get(key);
      if (isValidClickIdValue(val)) return String(val).trim();
    }

    const nestedKeys = ['url', 'u', 'redirect', 'target', 'dest', 'destination'];
    for (const nk of nestedKeys) {
      const nested = params.get(nk);
      if (!nested) continue;
      const decoded = safeDecodeURIComponent(nested);
      const fromNested = extractClickIdFromUrl(decoded, depth + 1);
      if (fromNested) return fromNested;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function readFirstClickId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of CLICK_ID_KEYS) {
    if (obj[key] != null) return String(obj[key]).trim();
  }
  return null;
}

function isValidClickIdValue(value) {
  if (!value) return false;
  const normalized = String(value).trim();
  if (!normalized) return false;
  if (normalized === '{{tb_click_id}}') return false;
  return normalized.length > 20;
}

// Send to Taboola bulk S2S
async function sendToTaboola(clickId, order, env) {
  const conversion = {
    'click-id': clickId,
    timestamp: Date.now(),
    name: env.TABOOLA_EVENT_NAME || 'make_purchase',
    revenue: order.revenue,
    currency: order.currency || 'INR',
    quantity: order.quantity || 1,
    orderid: order.orderId
  };

  // Strip nulls and NaN
  Object.keys(conversion).forEach(k => {
    const v = conversion[k];
    if (v == null || (typeof v === 'number' && isNaN(v))) delete conversion[k];
  });

  const endpoint = `https://trc.taboola.com/${env.TABOOLA_ACCOUNT_ID}/log/3/bulk-s2s-action`;
  console.log('Sending to Taboola | order:', order.orderId, '| revenue:', order.revenue);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [conversion] })
    });

    if (res.status === 204) {
      console.log('Taboola accepted | order:', order.orderId);
    } else {
      console.error('Taboola status:', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('Taboola fetch error:', e.message);
  }
}

// Helpers
function isPaidOrder(payload) {
  const stage = (payload.latest_stage || payload.stage || '').toLowerCase();
  if (stage === 'order_placed' || stage === 'order placed') return true;

  const status = (
    payload.status ||
    payload.payment_status ||
    payload.financial_status ||
    payload.order_status ||
    ''
  ).toLowerCase();

  return ['paid', 'success', 'confirmed', 'completed', 'placed'].some(s =>
    status.includes(s)
  );
}

function extractOrder(payload) {
  const d = payload.data?.data || payload.data || payload.order || payload;

  const rawRevenue =
    payload.total_price ?? d.total_price ?? d.total_amount ?? d.amount ?? 0;
  const revenue = parseFloat(String(rawRevenue).replace(/[^0-9.]/g, '')) || 0;

  const items = payload.items || d.line_items || d.items || [];
  const quantity =
    items.length > 0
      ? items.reduce((sum, i) => sum + (parseInt(i.quantity) || 1), 0)
      : 1;

  return {
    orderId: payload.cart_id || d.order_id || d.order_number || d.checkout_id || null,
    revenue,
    currency: (payload.currency || d.currency || 'INR').toUpperCase(),
    quantity
  };
}

async function verifyHmacSha256(body, signature, secret) {
  if (!signature) return false;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const buf = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    const computed = Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return computed === signature.replace(/^sha256=/, '');
  } catch (e) {
    console.error('HMAC error:', e);
    return false;
  }
}

function corsResponse(data, status) {
  return new Response(data ? JSON.stringify(data) : null, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
