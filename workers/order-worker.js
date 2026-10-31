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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

const orderStatuses = new Set(["received", "confirmed", "preparing", "shipped", "delivered", "cancelled"]);
const orderStatusProgression = ["received", "confirmed", "preparing", "shipped", "delivered"];
const orderStatusActions = {
  confirmed: "✅ Подтвердить заказ",
  preparing: "📦 Начать сборку",
  shipped: "🚚 Передать в доставку",
  delivered: "✅ Подтвердить доставку"
};
const orderStatusLabels = {
  received: "Заявка получена",
  confirmed: "Заказ подтверждён",
  preparing: "Собираем заказ",
  shipped: "Передан в доставку",
  delivered: "Заказ доставлен",
  cancelled: "Заказ отменён"
};
const orderRetentionSeconds = 60 * 60 * 24 * 180;
const trackingAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function trackingKey(code) {
  return `order:${code}`;
}

function makeTrackingCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const compact = Array.from(bytes, (byte) => trackingAlphabet[byte & 31]).join("");
  return `GOEL-${compact.slice(0, 4)}-${compact.slice(4)}`;
}

async function readJson(request, maxLength = 12000) {
  const raw = await request.text();
  if (raw.length > maxLength) throw new Error("Request too large");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid request");
  }
}

function publicOrder(order) {
  return {
    code: order.code,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    brand: order.brand,
    product: order.product,
    model: order.model,
    color: order.color,
    size: order.size,
    quantity: order.quantity,
    items: order.items || []
  };
}

function statusKeyboard(code, status) {
  const currentIndex = orderStatusProgression.indexOf(status);
  const nextStatus = currentIndex >= 0 ? orderStatusProgression[currentIndex + 1] : null;
  if (!nextStatus) return { inline_keyboard: [] };
  return {
    inline_keyboard: [[{
      text: orderStatusActions[nextStatus],
      callback_data: `status:${code}:${nextStatus}`
    }]]
  };
}

async function telegramRequest(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.description || `Telegram ${method} failed`);
  }
  return result.result;
}

async function editTelegramStatusKeyboard(env, callback, code, status) {
  try {
    await telegramRequest(env, "editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: statusKeyboard(code, status)
    });
  } catch (error) {
    if (!String(error.message).toLowerCase().includes("message is not modified")) throw error;
  }
}

async function handleTelegramWebhook(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {});
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.ORDER_TRACKING) {
    return jsonResponse({ error: "Telegram status buttons are not configured" }, 503, {});
  }
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return jsonResponse({ error: "Unauthorized" }, 403, {});
  }

  let update;
  try {
    update = await readJson(request, 10000);
  } catch (error) {
    return jsonResponse({ error: error.message }, error.message === "Request too large" ? 413 : 400, {});
  }
  const callback = update?.callback_query;
  if (!callback) return jsonResponse({ ok: true }, 200, {});

  const chatId = String(callback.message?.chat?.id ?? "");
  const senderId = String(callback.from?.id ?? "");
  if (chatId !== String(env.TELEGRAM_CHAT_ID) || senderId !== String(env.TELEGRAM_CHAT_ID)) {
    await telegramRequest(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Нет доступа к обновлению статуса.",
      show_alert: true
    }).catch((error) => console.error("Could not reject Telegram status callback", error));
    return jsonResponse({ ok: true }, 200, {});
  }

  const match = /^status:(GOEL-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}):(confirmed|preparing|shipped|delivered)$/.exec(callback.data || "");
  if (!match) {
    await telegramRequest(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Кнопка больше не действует.",
      show_alert: true
    }).catch((error) => console.error("Could not answer stale Telegram callback", error));
    return jsonResponse({ ok: true }, 200, {});
  }

  const [, code, requestedStatus] = match;
  const order = await env.ORDER_TRACKING.get(trackingKey(code), "json");
  if (!order) {
    await telegramRequest(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Заказ не найден.",
      show_alert: true
    }).catch((error) => console.error("Could not answer missing Telegram order", error));
    return jsonResponse({ ok: true }, 200, {});
  }

  const currentIndex = orderStatusProgression.indexOf(order.status);
  const nextStatus = currentIndex >= 0 ? orderStatusProgression[currentIndex + 1] : null;
  const isReplay = order.status === requestedStatus;
  if (!isReplay && nextStatus !== requestedStatus) {
    await telegramRequest(env, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Текущий статус: ${orderStatusLabels[order.status] || order.status}.`,
      show_alert: true
    });
    await editTelegramStatusKeyboard(env, callback, code, order.status);
    return jsonResponse({ ok: true }, 200, {});
  }

  if (!isReplay) {
    const updatedAt = new Date().toISOString();
    order.status = requestedStatus;
    order.updatedAt = updatedAt;
    order.statusHistory = [...(order.statusHistory || []), { status: requestedStatus, at: updatedAt }].slice(-20);
    await env.ORDER_TRACKING.put(trackingKey(code), JSON.stringify(order), { expirationTtl: orderRetentionSeconds });
  }

  await telegramRequest(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: isReplay ? `Уже обновлено: ${orderStatusLabels[requestedStatus]}.` : `Статус обновлён: ${orderStatusLabels[requestedStatus]}.`
  });
  await editTelegramStatusKeyboard(env, callback, code, order.status);
  return jsonResponse({ ok: true }, 200, {});
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

async function checkStock(body, env) {
  const slug = text(body.inventorySlug, 100);
  const tone = text(body.inventoryTone, 100);
  const quantity = Number(body.quantity ?? 1);
  const isGodderob = text(body.brand, 100).toLowerCase() === "godderob";
  if (!slug || !tone) return isGodderob || quantity > 1 ? "unavailable" : "available";

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

  const normalizedTone = stockToken(tone);
  const managedKey = `${slug}|${normalizedTone}`;
  if (!feed.managedVariants.includes(managedKey)) return quantity === 1 ? "available" : "unavailable";

  const sizesByTone = feed.availableSizes[slug] || {};
  const matchedTone = Object.entries(sizesByTone).find(([feedTone]) => stockToken(feedTone) === normalizedTone);
  const availableSizes = matchedTone?.[1] || [];
  const requestedSize = stockSize(body.size);
  if (!Array.isArray(availableSizes) || !availableSizes.some((size) => stockSize(size) === requestedSize)) {
    return "unavailable";
  }
  if (feed.schemaVersion === 1) return quantity === 1 ? "available" : "unavailable";

  const maxOrderable = Object.entries(feed.maxOrderable[slug]?.[matchedTone[0]] || {})
    .find(([size]) => stockSize(size) === requestedSize)?.[1];
  return Number.isInteger(maxOrderable) && maxOrderable >= quantity ? "available" : "unavailable";
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

    if (url.pathname === "/telegram-webhook") {
      return handleTelegramWebhook(request, env);
    }
    if (url.pathname === "/track") {
      if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
      if (!corsHeaders["Access-Control-Allow-Origin"]) return jsonResponse({ error: "Origin not allowed" }, 403, {});
      if (!env.ORDER_TRACKING) return jsonResponse({ error: "Order tracking is not configured" }, 503, corsHeaders);

      const code = text(url.searchParams.get("code"), 20).toUpperCase();
      if (!/^GOEL-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(code)) {
        return jsonResponse({ error: "invalid_code" }, 400, corsHeaders);
      }
      const order = await env.ORDER_TRACKING.get(trackingKey(code), "json");
      if (!order) return jsonResponse({ error: "order_not_found" }, 404, corsHeaders);
      return jsonResponse({ ok: true, order: publicOrder(order) }, 200, corsHeaders);
    }

    if (url.pathname === "/status") {
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
      if (!env.ORDER_ADMIN_TOKEN) return jsonResponse({ error: "Status updates are not configured" }, 503, corsHeaders);
      if (request.headers.get("Authorization") !== `Bearer ${env.ORDER_ADMIN_TOKEN}`) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      if (!env.ORDER_TRACKING) return jsonResponse({ error: "Order tracking is not configured" }, 503, corsHeaders);
      if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
        return jsonResponse({ error: "JSON required" }, 415, corsHeaders);
      }

      let body;
      try {
        body = await readJson(request, 2000);
      } catch (error) {
        return jsonResponse({ error: error.message }, error.message === "Request too large" ? 413 : 400, corsHeaders);
      }
      const code = text(body?.code, 20).toUpperCase();
      const status = text(body?.status, 20).toLowerCase();
      if (!/^GOEL-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(code) || !orderStatuses.has(status)) {
        return jsonResponse({ error: "Invalid order code or status" }, 400, corsHeaders);
      }
      const order = await env.ORDER_TRACKING.get(trackingKey(code), "json");
      if (!order) return jsonResponse({ error: "order_not_found" }, 404, corsHeaders);
      if (order.status !== status) {
        const updatedAt = new Date().toISOString();
        order.status = status;
        order.updatedAt = updatedAt;
        order.statusHistory = [...(order.statusHistory || []), { status, at: updatedAt }].slice(-20);
        await env.ORDER_TRACKING.put(trackingKey(code), JSON.stringify(order), { expirationTtl: orderRetentionSeconds });
      }
      return jsonResponse({ ok: true, order: publicOrder(order) }, 200, corsHeaders);
    }

    if (url.pathname !== "/order" || request.method !== "POST") return jsonResponse({ error: "Not found" }, 404, corsHeaders);
    if (!corsHeaders["Access-Control-Allow-Origin"]) return jsonResponse({ error: "Origin not allowed" }, 403, {});
    if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
      return jsonResponse({ error: "JSON required" }, 415, corsHeaders);
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return jsonResponse({ error: "Order notifications are not configured" }, 503, corsHeaders);
    }
    if (!env.ORDER_TRACKING) return jsonResponse({ error: "Order tracking is not configured" }, 503, corsHeaders);

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return jsonResponse({ error: error.message }, error.message === "Request too large" ? 413 : 400, corsHeaders);
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

    const isCartOrder = Array.isArray(body.items);
    const sourceItems = isCartOrder ? body.items : [body];
    if (!sourceItems.length || sourceItems.length > 20 || sourceItems.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      return jsonResponse({ error: "Invalid order items" }, 400, corsHeaders);
    }
    const items = sourceItems.map((item) => ({
      brand: text(item.brand, 100),
      product: text(item.product, 160),
      model: text(item.model, 100),
      color: text(item.color, 100),
      size: text(item.size, 80),
      price: text(item.price, 80),
      inventoryBrandId: text(item.inventoryBrandId, 100),
      inventorySlug: text(item.inventorySlug, 100),
      inventoryTone: text(item.inventoryTone, 100),
      quantity: Number(item.quantity ?? 1)
    }));
    if (items.some((item) => !item.brand || !item.product || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > (isCartOrder ? 99 : 3))) {
      return jsonResponse({ error: "Invalid order items" }, 400, corsHeaders);
    }
    const order = {
      items,
      brand: [...new Set(items.map((item) => item.brand))].join(", "),
      product: items.map((item) => item.product).join(", ").slice(0, 1000),
      model: items.length === 1 ? items[0].model : "",
      color: items.length === 1 ? items[0].color : "",
      size: items.length === 1 ? items[0].size : "",
      price: items.length === 1 ? items[0].price : "",
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
      body.consent !== true ||
      !items.length
    ) {
      return jsonResponse({ error: "Please complete the required fields" }, 400, corsHeaders);
    }
    order.quantity = items.reduce((total, item) => total + item.quantity, 0);
    if (order.quantity > 99) return jsonResponse({ error: "Invalid order quantity" }, 400, corsHeaders);

    try {
      for (const item of items) {
        const isManagedGodderob = item.inventoryBrandId.toLowerCase() === "godderob" || item.brand.toLowerCase() === "godderob";
        if (!isManagedGodderob && !item.inventorySlug && !item.inventoryTone) continue;
        const stockStatus = await checkStock({
          brand: isManagedGodderob ? "godderob" : item.brand,
          inventorySlug: item.inventorySlug,
          inventoryTone: item.inventoryTone,
          size: item.size,
          quantity: item.quantity
        }, env);
        if (stockStatus === "unavailable") {
          return jsonResponse({ error: isCartOrder ? "insufficient_stock" : "item_unavailable" }, 409, corsHeaders);
        }
      }
    } catch (error) {
      console.error("Could not verify order stock", error);
      return jsonResponse({ error: "Stock verification unavailable" }, 503, corsHeaders);
    }

    const code = makeTrackingCode();
    const createdAt = new Date().toISOString();
    const trackingRecord = {
      code,
      status: "received",
      createdAt,
      updatedAt: createdAt,
      statusHistory: [{ status: "received", at: createdAt }],
      brand: order.brand,
      product: order.product,
      model: order.model,
      color: order.color,
      size: order.size,
      quantity: order.quantity,
      items: order.items.map(({ brand, product, model, color, size, quantity }) => ({ brand, product, model, color, size, quantity }))
    };
    try {
      await env.ORDER_TRACKING.put(trackingKey(code), JSON.stringify(trackingRecord), { expirationTtl: orderRetentionSeconds });
    } catch (error) {
      console.error("Could not save order tracking record", error);
      return jsonResponse({ error: "Order tracking is temporarily unavailable" }, 503, corsHeaders);
    }

    const lines = [
      "<b>Новая заявка с сайта GO’EL</b>",
      "",
      `<b>Код отслеживания:</b> ${escapeHtml(code)}`,
      ...order.items.flatMap((item, index) => [
        `<b>${index + 1}. ${escapeHtml(item.brand)} — ${escapeHtml(item.product)}</b>`,
        item.model ? `<b>Модель:</b> ${escapeHtml(item.model)}` : "",
        `<b>Цвет:</b> ${escapeHtml(item.color || "не указан")}`,
        `<b>Размер:</b> ${escapeHtml(item.size || "не указан")}`,
        `<b>Количество:</b> ${item.quantity}`,
        `<b>Цена:</b> ${escapeHtml(item.price || "не указана")}`,
        ""
      ]),
      `<b>Покупатель:</b> ${escapeHtml(order.customerName)}`,
      `<b>Телефон:</b> ${escapeHtml(order.phone)}`,
      `<b>Доставка:</b> ${escapeHtml(order.delivery)}`,
      order.comment ? `<b>Комментарий:</b> ${escapeHtml(order.comment)}` : "",
      order.page ? `<b>Страница:</b> ${escapeHtml(order.page)}` : ""
    ].filter(Boolean);

    const telegramText = lines.join("\n");
    if (telegramText.length > 3900) {
      await env.ORDER_TRACKING.delete(trackingKey(code)).catch(() => {});
      return jsonResponse({ error: "Order details are too long" }, 413, corsHeaders);
    }

    let telegramResponse;
    try {
      telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: telegramText,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: env.TELEGRAM_WEBHOOK_SECRET ? statusKeyboard(code, trackingRecord.status) : undefined
        })
      });
    } catch {
      await env.ORDER_TRACKING.delete(trackingKey(code)).catch(() => {});
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
      await env.ORDER_TRACKING.delete(trackingKey(code)).catch(() => {});
      return jsonResponse({ error: "Could not send order notification" }, 502, corsHeaders);
    }
    return jsonResponse({ ok: true, trackingCode: code }, 200, corsHeaders);
  }
};
