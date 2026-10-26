const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...corsHeaders }
  });
}

function corsFor(origin, allowedOrigin) {
  if (origin !== allowedOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function text(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength)
    : "";
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function stockToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я]/g, "");
}

function stockSize(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[Хх]/g, "X")
    .replace(/XXL/g, "2XL");
}

async function checkStock(items, env) {
  const trackedItems = items.filter((item) =>
    item.inventoryBrandId === "godderob" || item.brand.toLowerCase() === "godderob"
  );
  if (!trackedItems.length) return "available";
  if (trackedItems.some((item) => !item.inventorySlug || !item.inventoryTone || !item.inventorySize)) {
    return "unavailable";
  }

  const feedUrl = env.STOCK_FEED_URL || "https://mikitatrv.github.io/goel/data/godderob-availability.json";
  const response = await fetch(feedUrl, {
    headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" }
  });
  if (!response.ok) throw new Error("Availability feed unavailable");

  const feed = await response.json();
  if (![1, 2].includes(feed.schemaVersion) || !Array.isArray(feed.managedVariants) || !feed.availableSizes) {
    throw new Error("Invalid availability feed");
  }
  if (feed.schemaVersion === 2 && (!feed.maxOrderable || typeof feed.maxOrderable !== "object")) {
    throw new Error("Availability feed has no order limits");
  }

  const requested = new Map();
  for (const item of trackedItems) {
    const slug = item.inventorySlug;
    const tone = stockToken(item.inventoryTone);
    const size = stockSize(item.inventorySize);
    const key = JSON.stringify([slug, tone, size]);
    requested.set(key, { slug, tone, size, quantity: (requested.get(key)?.quantity || 0) + item.quantity });
  }

  for (const item of requested.values()) {
    if (!feed.managedVariants.includes(`${item.slug}|${item.tone}`)) {
      if (item.quantity > 1) return "unavailable";
      continue;
    }
    const sizesByTone = feed.availableSizes[item.slug] || {};
    const matchedTone = Object.entries(sizesByTone).find(([feedTone]) => stockToken(feedTone) === item.tone);
    const availableSizes = matchedTone?.[1] || [];
    if (!Array.isArray(availableSizes) || !availableSizes.some((size) => stockSize(size) === item.size)) {
      return "unavailable";
    }
    if (feed.schemaVersion === 1) {
      if (item.quantity > 1) return "unavailable";
      continue;
    }

    const maxOrderable = Object.entries(feed.maxOrderable[item.slug]?.[matchedTone[0]] || {})
      .find(([size]) => stockSize(size) === item.size)?.[1];
    if (!Number.isInteger(maxOrderable) || item.quantity > maxOrderable) return "unavailable";
  }
  return "available";
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = corsFor(origin, env.ALLOWED_ORIGIN || "");
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!corsHeaders["Access-Control-Allow-Origin"]) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST" || url.pathname !== "/order") {
      return jsonResponse({ error: "Not found" }, 404, corsHeaders);
    }
    if (!corsHeaders["Access-Control-Allow-Origin"]) {
      return jsonResponse({ error: "Origin not allowed" }, 403, {});
    }
    if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
      return jsonResponse({ error: "JSON required" }, 415, corsHeaders);
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return jsonResponse({ error: "Order notifications are not configured" }, 503, corsHeaders);
    }

    let body;
    try {
      const raw = await request.text();
      if (raw.length > 12000) return jsonResponse({ error: "Request too large" }, 413, corsHeaders);
      body = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: "Invalid request" }, 400, corsHeaders);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "Invalid request" }, 400, corsHeaders);
    }

    if (text(body.website, 200)) {
      return jsonResponse({ ok: true }, 200, corsHeaders);
    }
    const startedAt = Number(body.startedAt);
    if (!Number.isFinite(startedAt) || Date.now() - startedAt < 1000 || Date.now() - startedAt > 60 * 60 * 1000) {
      return jsonResponse({ error: "Invalid submission time" }, 400, corsHeaders);
    }

    const incomingItems = Array.isArray(body.items) ? body.items : [{
      brand: body.brand,
      product: body.product,
      model: body.model,
      color: body.color,
      size: body.size,
      price: body.price,
      quantity: 1
    }];
    if (!incomingItems.length || incomingItems.length > 25) {
      return jsonResponse({ error: "Invalid items" }, 400, corsHeaders);
    }
    const items = incomingItems.map((item) => ({
      brand: text(item?.brand, 100),
      inventoryBrandId: text(item?.inventoryBrandId, 100),
      inventorySlug: text(item?.inventorySlug, 100),
      inventoryTone: text(item?.inventoryTone, 100),
      inventorySize: text(item?.inventorySize, 40),
      product: text(item?.product, 160),
      model: text(item?.model, 100),
      color: text(item?.color, 100),
      size: text(item?.size, 80),
      price: text(item?.price, 80),
      quantity: Number(item?.quantity ?? 1)
    }));
    if (items.some((item) => !item.brand || !item.product || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99)) {
      return jsonResponse({ error: "Invalid items" }, 400, corsHeaders);
    }
    const order = {
      customerName: text(body.customerName, 80),
      phone: text(body.phone, 32),
      delivery: text(body.delivery, 500),
      comment: text(body.comment, 500),
      page: text(body.page, 500)
    };
    if (
      order.customerName.length < 2 ||
      order.phone.replace(/[^\d+]/g, "").length < 6 ||
      order.delivery.length < 5 ||
      body.consent !== true
    ) {
      return jsonResponse({ error: "Please complete the required fields" }, 400, corsHeaders);
    }

    let stockStatus;
    try {
      stockStatus = await checkStock(items, env);
    } catch (error) {
      console.error("Could not verify order stock", error);
      return jsonResponse({ error: "Stock verification unavailable" }, 503, corsHeaders);
    }
    if (stockStatus === "unavailable") {
      return jsonResponse({ error: "insufficient_stock" }, 409, corsHeaders);
    }

    const lines = [
      "<b>Новая заявка с сайта GO’EL</b>",
      "",
      ...items.flatMap((item, index) => [
        `<b>${index + 1}. ${escapeHtml(item.brand)} — ${escapeHtml(item.product)}</b>`,
        item.model ? `<b>Модель:</b> ${escapeHtml(item.model)}` : "",
        `<b>Цвет:</b> ${escapeHtml(item.color || "не указан")}`,
        `<b>Размер:</b> ${escapeHtml(item.size || "не указан")}`,
        `<b>Количество:</b> ${item.quantity}`,
        `<b>Цена за шт.:</b> ${escapeHtml(item.price || "не указана")}`,
        ""
      ]),
      `<b>Покупатель:</b> ${escapeHtml(order.customerName)}`,
      `<b>Телефон:</b> ${escapeHtml(order.phone)}`,
      `<b>Доставка:</b> ${escapeHtml(order.delivery)}`,
      order.comment ? `<b>Комментарий:</b> ${escapeHtml(order.comment)}` : "",
      order.page ? `<b>Страница:</b> ${escapeHtml(order.page)}` : ""
    ].filter(Boolean);

    let telegramResponse;
    try {
      telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: lines.join("\n"),
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      });
    } catch {
      return jsonResponse({ error: "Notification service unavailable" }, 502, corsHeaders);
    }

    let telegramResult;
    try {
      telegramResult = await telegramResponse.json();
    } catch {
      telegramResult = null;
    }
    if (!telegramResponse.ok || !telegramResult?.ok) {
      console.error("Telegram sendMessage failed", telegramResponse.status, telegramResult?.description || "unknown error");
      return jsonResponse({ error: "Could not send order notification" }, 502, corsHeaders);
    }
    return jsonResponse({ ok: true }, 200, corsHeaders);
  }
};
