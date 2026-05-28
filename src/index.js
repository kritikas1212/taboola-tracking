/**
 * Taboola S2S Cloudflare Worker
 * Account: 1968303 | Event: make_purchase
 *
 * Supports:
 * - Shiprocket tracking webhooks
 * - Legacy Fastrr webhooks
 * - Shopify cart attribute recovery for click-id attribution
 *
 * Shiprocket webhooks do not include click-id directly, so the worker tries
 * direct payload fields first, then order detail lookups, then Shopify fallbacks.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    if (path === '/health' && request.method === 'GET') {
      return corsResponse({ status: 'ok', account: env.TABOOLA_ACCOUNT_ID }, 200);
    }

    if (path === '/store-cid' && request.method === 'POST') {
      return handleStoreCid(request, env);
    }

    if (path === '/shiprocket-webhook' && request.method === 'POST') {
      return handleShipmentWebhook(request, env, ctx, 'shiprocket');
    }

    if (path === '/shiprocket-order-created' && request.method === 'POST') {
      return handleShipmentWebhook(request, env, ctx, 'shiprocket-order-created');
    }

    if (path === '/fastrr-webhook' && request.method === 'POST') {
      return handleShipmentWebhook(request, env, ctx, 'fastrr');
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

const SHIPROCKET_DELIVERED_STATUSES = [
  'DELIVERED',
  'DELIVERY COMPLETED',
  'POD GENERATED',
  'CLOSED'
];

const SHOPIFY_API_VERSION = '2024-07';
const SHIPROCKET_AUTH_URL = 'https://apiv2.shiprocket.in/v1/external/auth/login';
const SHIPROCKET_ORDER_URL = 'https://apiv2.shiprocket.in/v1/external/orders/show';

let shiprocketTokenCache = {
  token: null,
  expiresAt: 0
};

// Main webhook handler
async function handleShipmentWebhook(request, env, ctx, source) {
  const rawBody = await request.text();

  if (source === 'shiprocket') {
    const secret = getEnvValue(env, ['SHIPROCKET_WEBHOOK_SECRET', 'SHIPROCKET_WEBHOOK_TOKEN']);
    if (secret) {
      const received =
        request.headers.get('anx-api-key') ||
        request.headers.get('Anx-Api-Key') ||
        request.headers.get('x-api-key') ||
        request.headers.get('x-webhook-token') ||
        '';

      if (!received || received !== secret) {
        console.error('Invalid Shiprocket webhook token - rejecting');
        return new Response('Unauthorized', { status: 401 });
      }
    }
  } else {
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
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Bad JSON', { status: 400 });
  }

  if (source === 'shiprocket') {
    const status = normalizeShiprocketStatus(payload);
    console.log('Shiprocket webhook received | status:', status, '| sr_order_id:', payload.sr_order_id, '| order_id:', payload.order_id);

    if (!isShiprocketConversionStatus(payload)) {
      console.log('Shiprocket status is not a conversion event - skipping');
      return new Response('Skipped', { status: 200 });
    }

    const shiprocketOrder = await fetchShiprocketOrderDetails(payload, env);
    const order = extractOrder(payload, shiprocketOrder);
    const clickId =
      findClickId(payload) ||
      extractClickIdFromShiprocketOrder(shiprocketOrder) ||
      findClickIdFromReferrer(request) ||
      (await findClickIdFromKV(payload, env)) ||
      (await findClickIdFromShopify(payload, env));

    console.log(
      'Shiprocket order:',
      order.orderId,
      '| revenue:',
      order.revenue,
      '| click-id:',
      clickId ? clickId.slice(0, 20) + '...' : 'NOT FOUND'
    );

    if (!clickId) {
      console.warn('No click-id found for Shiprocket event - skipped');
      return new Response('No click-id - skipped', { status: 200 });
    }

    ctx.waitUntil(sendToTaboola(clickId, order, env));
    return new Response('OK', { status: 200 });
  }

  if (source === 'shiprocket-order-created') {
    const order = extractOrder(payload);
    const clickId =
      findClickId(payload) ||
      findClickIdFromReferrer(request) ||
      extractClickIdFromShiprocketOrder(payload) ||
      (await findClickIdFromKV(payload, env)) ||
      (await findClickIdFromShopify(payload, env));

    console.log(
      'Shiprocket order-created received | order:',
      order.orderId,
      '| revenue:',
      order.revenue,
      '| click-id:',
      clickId ? clickId.slice(0, 20) + '...' : 'NOT FOUND'
    );

    if (!clickId) {
      console.warn('No click-id found for Shiprocket order-created event - skipped');
      return new Response('No click-id - skipped', { status: 200 });
    }

    ctx.waitUntil(sendToTaboola(clickId, order, env));
    return new Response('OK', { status: 200 });
  }

  const stage = (payload.latest_stage || payload.stage || '').toLowerCase();
  console.log('Fastrr webhook received | stage:', stage, '| cart_id:', payload.cart_id);
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
  const clickId =
    findClickId(payload) ||
    findClickIdFromReferrer(request) ||
    (await findClickIdFromKV(payload, env)) ||
    (await findClickIdFromShopify(payload, env));

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

async function handleStoreCid(request, env) {
  if (!env.CID_STORE) {
    return new Response('KV not configured', { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response('Bad JSON', { status: 400 });
  }

  const cartId = normalizeCartToken(body?.cart_id);
  const clickId = String(body?.click_id || '').trim();
  const landing = String(body?.landing || '').trim();

  if (!cartId || !clickId || clickId.length < 10) {
    return new Response('Missing fields', { status: 400 });
  }

  const value = JSON.stringify({ clickId, landing, storedAt: Date.now() });
  await env.CID_STORE.put(`cart:${cartId}`, value, { expirationTtl: 259200 });

  console.log('[store-cid] Stored | cart:', cartId, '| cid:', clickId.slice(0, 20) + '...');
  return corsResponse({ ok: true }, 200);
}

function normalizeShiprocketStatus(payload) {
  return String(payload.current_status || payload.shipment_status || payload.status || '')
    .trim()
    .toUpperCase();
}

function isShiprocketConversionStatus(payload) {
  const status = normalizeShiprocketStatus(payload);
  if (SHIPROCKET_DELIVERED_STATUSES.includes(status)) return true;
  return /DELIVER|COMPLET|POD/.test(status);
}

function normalizeShiprocketOrderId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeCartToken(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.split(/[?#]/)[0].trim() || null;
}

async function fetchShiprocketOrderDetails(payload, env) {
  const orderId = normalizeShiprocketOrderId(payload.sr_order_id || payload.order_id || payload.id);
  if (!orderId) return null;

  const token = await getShiprocketAuthToken(env);
  if (!token) return null;

  try {
    const res = await fetch(`${SHIPROCKET_ORDER_URL}/${orderId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      console.warn('[Shiprocket] order lookup failed | status:', res.status);
      return null;
    }

    const data = await res.json();
    return data?.data || data?.order || data || null;
  } catch (e) {
    console.warn('[Shiprocket] order lookup error:', e.message);
    return null;
  }
}

async function getShiprocketAuthToken(env) {
  const cachedToken = shiprocketTokenCache.token;
  if (cachedToken && Date.now() < shiprocketTokenCache.expiresAt) {
    return cachedToken;
  }

  const email = getEnvValue(env, ['SHIPROCKET_EMAIL', 'SHIPROCKET_API_EMAIL', 'SHIPROCKET_LOGIN_EMAIL']);
  const password = getEnvValue(env, ['SHIPROCKET_PASSWORD', 'SHIPROCKET_API_PASSWORD', 'SHIPROCKET_LOGIN_PASSWORD']);

  if (!email || !password) return null;

  try {
    const res = await fetch(SHIPROCKET_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!res.ok) {
      console.warn('[Shiprocket] auth failed | status:', res.status);
      return null;
    }

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {}

    const token =
      data?.token ||
      data?.data?.token ||
      data?.auth_token ||
      data?.data?.auth_token ||
      data?.access_token ||
      text.trim().replace(/^"|"$/g, '') ||
      null;

    if (!token || token.length < 10) {
      console.warn('[Shiprocket] auth response did not include a token');
      return null;
    }

    shiprocketTokenCache = {
      token,
      expiresAt: Date.now() + 9 * 24 * 60 * 60 * 1000
    };

    return token;
  } catch (e) {
    console.warn('[Shiprocket] auth error:', e.message);
    return null;
  }
}

function extractClickIdFromShiprocketOrder(order) {
  if (!order) return null;

  const directCandidates = [
    order.order_tag,
    order.comment,
    order.api_order_id,
    order.channel_order_id,
    order.reseller_name,
    order.invoice_no,
    order.invoice_number
  ];

  for (const value of directCandidates) {
    const fromValue = readClickIdValue(value);
    if (fromValue) return fromValue;
  }

  const nestedCandidates = [
    order.extra_info,
    order.others,
    order.shipments,
    order.awb_data,
    order.custom_fields,
    order.additional_info
  ];

  for (const candidate of nestedCandidates) {
    const fromCandidate = readFirstClickId(candidate) || readClickIdFromObject(candidate);
    if (fromCandidate) return fromCandidate;
  }

  return null;
}

function readClickIdFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'string') {
      const fromValue = readClickIdValue(value);
      if (fromValue) return fromValue;
    }
  }
  return null;
}

function readClickIdValue(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (isValidClickIdValue(trimmed)) return trimmed;

  const parsed = extractClickIdFromUrl(trimmed);
  return parsed;
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

  const note = payload.note || payload.order_note || d.note || d.order_note || '';
  if (typeof note === 'string' && note.includes('tb_click_id=')) {
    const noteMatch = note.match(/tb_click_id=([^|&\s]+)/);
    if (noteMatch && isValidClickIdValue(noteMatch[1])) {
      console.log('[findClickId] Extracted from order note');
      return noteMatch[1];
    }
  }

  return null;
}

function findClickIdFromReferrer(request) {
  const referrer =
    request.headers.get('referer') ||
    request.headers.get('referrer') ||
    request.headers.get('x-referer') ||
    request.headers.get('x-referrer') ||
    request.headers.get('x-original-url') ||
    request.headers.get('x-forwarded-url') ||
    request.headers.get('x-forwarded-uri');

  if (!referrer) return null;

  const fromReferrer = extractClickIdFromUrl(referrer);
  if (fromReferrer) {
    console.log('[findClickId] Extracted from referrer header');
    return fromReferrer;
  }

  console.log('[findClickId] Referrer header present but no click-id param');
  return null;
}

async function findClickIdFromKV(payload, env) {
  if (!env.CID_STORE) return null;

  const d = payload.data?.data || payload.data || payload.order || payload;
  const cartIds = [
    payload.cart_id,
    payload.cart,
    payload.cart_token,
    payload.checkout_id,
    d.cart_id,
    d.cart,
    d.cart_token,
    d.checkout_id
  ]
    .map(normalizeCartToken)
    .filter(Boolean);

  if (!cartIds.length) return null;

  try {
    for (const cartId of cartIds) {
      const stored = await env.CID_STORE.get(`cart:${cartId}`);
      if (!stored) continue;

      const parsed = JSON.parse(stored);
      if (parsed?.clickId && parsed.clickId.length > 10) {
        console.log('[findClickId] Recovered from KV store | cart:', cartId);
        return parsed.clickId;
      }
    }
  } catch (e) {
    console.warn('[findClickId] KV lookup error:', e.message);
  }

  return null;
}

async function findClickIdFromShopify(payload, env) {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN;
  const adminToken = env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!shopDomain || !adminToken) {
    console.log('[findClickId] Shopify Admin API fallback unavailable - missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN');
    return null;
  }

  const d = payload.data?.data || payload.data || payload.order || payload;
  const candidates = [];

  const orderName = normalizeShopifyOrderName(
    payload.order_number ||
      payload.order_name ||
      payload.name ||
      payload.order?.name ||
      d.order_number ||
      d.order_name ||
      d.name
  );
  if (orderName) candidates.push({ type: 'name', value: orderName });

  const orderId = normalizeShopifyOrderId(
    payload.order_id ||
      payload.api_order_id ||
      payload.shopify_order_id ||
      payload.checkout_id ||
      payload.id ||
      d.order_id ||
      d.api_order_id ||
      d.shopify_order_id ||
      d.checkout_id ||
      d.id
  );
  if (orderId) candidates.push({ type: 'id', value: orderId });

  const cartId = normalizeShopifyOrderId(payload.cart_id || payload.cart || d.cart_id || d.cart);
  if (cartId) candidates.push({ type: 'cart_id', value: cartId });

  if (!candidates.length) {
    console.log('[findClickId] Shopify fallback skipped - no lookup candidate');
    return null;
  }

  for (const candidate of candidates) {
    const result =
      candidate.type === 'id'
        ? await fetchShopifyOrderById(shopDomain, adminToken, candidate.value)
        : candidate.type === 'name'
          ? await fetchShopifyOrderByName(shopDomain, adminToken, candidate.value)
          : await fetchShopifyOrderByCartId(shopDomain, adminToken, candidate.value);

    if (result?.clickId) {
      console.log('[findClickId] Extracted from Shopify Admin API | source:', candidate.type);
      return result.clickId;
    }

    if (result) {
      console.log(
        '[findClickId] Shopify Admin API returned order but no click-id | source:',
        candidate.type,
        '| landing_page_url:',
        String(result.landingPageUrl || result.landing_site_ref || result.landing_site || result.referring_site || '').slice(0, 180)
      );
    }
  }

  console.log('[findClickId] Shopify Admin API fallback did not find click-id');
  return null;
}

function extractShopifyOrderInfo(order) {
  if (!order) return null;
  return {
    clickId: extractClickIdFromShopifyOrder(order),
    landingPageUrl: extractLandingPageUrlFromShopifyOrder(order),
    landing_site_ref: order.landing_site_ref,
    landing_site: order.landing_site,
    referring_site: order.referring_site,
    cart_token: order.cart_token,
    checkout_id: order.checkout_id,
    cart_id: order.cart_id
  };
}

async function fetchShopifyOrderById(shopDomain, adminToken, id) {
  try {
    const res = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders/${id}.json`, {
      headers: {
        'X-Shopify-Access-Token': adminToken,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) return null;
    const data = await res.json();
    return extractShopifyOrderInfo(data?.order || data);
  } catch (e) {
    console.warn('[findClickId] Shopify order-by-id lookup failed:', e.message);
    return null;
  }
}

async function fetchShopifyOrderByName(shopDomain, adminToken, orderName) {
  try {
    const query = `name:${orderName}`;
    const res = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=5&name=${encodeURIComponent(orderName)}`,
      {
        headers: {
          'X-Shopify-Access-Token': adminToken,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const orders = Array.isArray(data?.orders) ? data.orders : [];

    const match = orders.find(order => normalizeShopifyOrderName(order?.name) === orderName) || orders[0];
    return match ? extractShopifyOrderInfo(match) : null;
  } catch (e) {
    console.warn('[findClickId] Shopify order-by-name lookup failed:', e.message);
    return null;
  }
}

async function fetchShopifyOrderByCartId(shopDomain, adminToken, cartId) {
  cartId = normalizeCartToken(cartId);
  if (!cartId) return null;

  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=10&cart_token=${encodeURIComponent(cartId)}`,
      {
        headers: {
          'X-Shopify-Access-Token': adminToken,
          'Content-Type': 'application/json'
        }
      }
    );

    if (res.ok) {
      const data = await res.json();
      const orders = Array.isArray(data?.orders) ? data.orders : [];
      if (orders.length > 0) {
        console.log('[findClickId] Shopify cart_token lookup matched');
        return extractShopifyOrderInfo(orders[0]);
      }
    }
  } catch (e) {
    console.warn('[findClickId] Shopify cart_token lookup failed:', e.message);
  }

  try {
    const res = await fetch(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=50&created_at_min=${getRecentTimestamp(2)}`,
      {
        headers: {
          'X-Shopify-Access-Token': adminToken,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const orders = Array.isArray(data?.orders) ? data.orders : [];

    const match = orders.find(order => {
      const orderCartToken = String(order?.cart_token || '');
      const orderCheckoutId = String(order?.checkout_id || '');
      if (orderCartToken && orderCartToken.includes(String(cartId))) return true;
      if (orderCheckoutId && orderCheckoutId.includes(String(cartId))) return true;

      const noteAttrs = order?.note_attributes || [];
      return noteAttrs.some(attr => {
        const name = String(attr?.name || '').toLowerCase();
        const value = String(attr?.value || '');
        return value.includes(String(cartId)) || (name.includes('cart') && value.includes(String(cartId)));
      });
    });

    return match ? extractShopifyOrderInfo(match) : null;
  } catch (e) {
    console.warn('[findClickId] Shopify recent orders lookup failed:', e.message);
    return null;
  }
}

function getRecentTimestamp(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function extractClickIdFromShopifyOrder(order) {
  if (!order) return null;

  const landingPageUrl = extractLandingPageUrlFromShopifyOrder(order);
  if (landingPageUrl) {
    const fromLandingPage = extractClickIdFromUrl(landingPageUrl);
    if (fromLandingPage) {
      return fromLandingPage;
    }
  }

  const noteAttributes = order.note_attributes || order.noteAttributes || [];
  if (Array.isArray(noteAttributes)) {
    for (const item of noteAttributes) {
      const key = String(item?.name || item?.key || '').toLowerCase().trim();
      const value = item?.value;
      if (CLICK_ID_KEYS.includes(key) && isValidClickIdValue(value)) {
        return String(value).trim();
      }
    }
  }

  const cartAttributes = order.custom_attributes || order.cart_attributes || [];
  if (Array.isArray(cartAttributes)) {
    for (const item of cartAttributes) {
      const key = String(item?.name || item?.key || '').toLowerCase().trim();
      const value = item?.value;
      if (CLICK_ID_KEYS.includes(key) && isValidClickIdValue(value)) {
        return String(value).trim();
      }
    }
  }

  const direct =
    order.tb_click_id ||
    order['click-id'] ||
    order.click_id ||
    order.clickId ||
    order.taboola_click_id;
  return isValidClickIdValue(direct) ? String(direct).trim() : null;
}

function extractLandingPageUrlFromShopifyOrder(order) {
  if (!order) return null;

  const directFields = [
    order.landing_page_url,
    order.landingPageUrl,
    order.landing_site_ref,
    order.landing_site,
    order.referring_site,
    order.source_url,
    order.original_landing_page_url,
    order.tb_landing_page_url_original
  ];

  for (const value of directFields) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const noteAttributes = order.note_attributes || order.noteAttributes || [];
  if (Array.isArray(noteAttributes)) {
    for (const item of noteAttributes) {
      const key = String(item?.name || item?.key || '').toLowerCase().trim();
      const value = item?.value;
      if ((key === 'landing_page_url' || key === 'landing_site' || key === 'landing_site_ref') && typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }

  const cartAttributes = order.custom_attributes || order.cart_attributes || [];
  if (Array.isArray(cartAttributes)) {
    for (const item of cartAttributes) {
      const key = String(item?.name || item?.key || '').toLowerCase().trim();
      const value = item?.value;
      if ((key === 'landing_page_url' || key === 'landing_site' || key === 'landing_site_ref') && typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }

  return null;
}


function normalizeShopifyOrderName(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.startsWith('#') ? normalized.slice(1) : normalized;
}

function normalizeShopifyOrderId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
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
    payload.total_price ?? d.total_price ?? d.total_amount ?? d.amount ?? d.total ?? d.net_total ?? 0;
  const revenue = parseFloat(String(rawRevenue).replace(/[^0-9.]/g, '')) || 0;

  const items = payload.items || d.line_items || d.products || d.items || [];
  const quantity =
    items.length > 0
      ? items.reduce((sum, i) => sum + (parseInt(i.quantity) || 1), 0)
      : 1;

  return {
    orderId:
      payload.sr_order_id ||
      payload.order_id ||
      payload.cart_id ||
      d.id ||
      d.order_id ||
      d.order_number ||
      d.checkout_id ||
      null,
    revenue,
    currency: (payload.currency || d.currency || d.currency_code || 'INR').toUpperCase(),
    quantity
  };
}

function getEnvValue(env, keys) {
  for (const key of keys) {
    if (env[key]) return env[key];
  }
  return null;
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
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-webhook-token, x-webhook-signature, x-fastrr-signature, x-hub-signature-256'
    }
  });
}
