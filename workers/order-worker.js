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

    const order = {
      brand: text(body.brand, 100),
      product: text(body.product, 160),
      model: text(body.model, 100),
      color: text(body.color, 100),
      size: text(body.size, 80),
      price: text(body.price, 80),
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
      !order.brand ||
      !order.product
    ) {
      return jsonResponse({ error: "Please complete the required fields" }, 400, corsHeaders);
    }

    const lines = [
      "<b>Новая заявка с сайта GO’EL</b>",
      "",
      `<b>Бренд:</b> ${escapeHtml(order.brand)}`,
      `<b>Товар:</b> ${escapeHtml(order.product)}`,
      order.model ? `<b>Модель:</b> ${escapeHtml(order.model)}` : "",
      `<b>Цвет:</b> ${escapeHtml(order.color || "не указан")}`,
      `<b>Размер:</b> ${escapeHtml(order.size || "не указан")}`,
      `<b>Цена:</b> ${escapeHtml(order.price || "не указана")}`,
      "",
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
