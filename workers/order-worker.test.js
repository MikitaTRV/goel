import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import worker from "./order-worker.js";

const originalFetch = globalThis.fetch;
const orderUrl = "https://goel-order-api.o-el.workers.dev/order";
const webhookUrl = "https://goel-order-api.o-el.workers.dev/telegram-webhook";
const turnstileUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const testOrderCode = "GOEL-ABCD-EFGH";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createFixture({ turnstileSuccess = true, rateLimitAllowed = true, stockFeed = null, telegramFailures = {} } = {}) {
  const state = { turnstileRequests: 0, stockRequests: 0, telegramMessages: 0, telegramCalls: [], rateLimitRequests: 0, values: new Map() };
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url === turnstileUrl) {
      state.turnstileRequests += 1;
      return Response.json({
        success: turnstileSuccess,
        hostname: "mikitatrv.github.io",
        action: "order"
      });
    }
    if (url.includes("godderob-availability.json")) {
      state.stockRequests += 1;
      return Response.json(stockFeed || { schemaVersion: 2, managedVariants: [], availableSizes: {}, maxOrderable: {} });
    }
    if (url.includes("api.telegram.org")) {
      const method = url.split("/").pop();
      const payload = JSON.parse(options.body || "{}");
      state.telegramCalls.push({ method, payload });
      if (method === "sendMessage") state.telegramMessages += 1;
      if (telegramFailures[method] === "throw") throw new Error("Telegram transport unavailable");
      if (telegramFailures[method]) return Response.json({ ok: false, description: telegramFailures[method] });
      return Response.json({ ok: true, result: { message_id: 42 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const env = {
    ALLOWED_ORIGIN: "https://mikitatrv.github.io",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_CHAT_ID: "12345",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    ORDER_RATE_LIMITER: {
      limit: async () => {
        state.rateLimitRequests += 1;
        return { success: rateLimitAllowed };
      }
    },
    ORDER_TRACKING: {
      get: async (key, type) => {
        const value = state.values.get(key);
        return type === "json" && value ? JSON.parse(value) : value ?? null;
      },
      put: async (key, value) => state.values.set(key, value),
      delete: async (key) => state.values.delete(key)
    }
  };
  return { env, state };
}

function orderRequest(overrides = {}) {
  return new Request(orderUrl, {
    method: "POST",
    headers: {
      Origin: "https://mikitatrv.github.io",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10"
    },
    body: JSON.stringify({
      items: [{ brand: "SOLA", product: "Test T-shirt", size: "M", quantity: 1 }],
      customerName: "Test Customer",
      phone: "+375291234567",
      delivery: "Minsk pickup point",
      consent: true,
      website: "",
      startedAt: Date.now() - 2000,
      page: "https://mikitatrv.github.io/",
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      turnstileToken: "turnstile-test-token",
      ...overrides
    })
  });
}

function seedOrder(state, status = "received") {
  const createdAt = "2026-10-31T09:00:00.000Z";
  const order = {
    code: testOrderCode,
    status,
    createdAt,
    updatedAt: createdAt,
    statusHistory: [{ status: "received", at: createdAt }]
  };
  state.values.set(`order:${testOrderCode}`, JSON.stringify(order));
  return order;
}

function webhookRequest(callbackData, { secret = "test-webhook-secret", chatId = "12345", senderId = "12345" } = {}) {
  return new Request(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret
    },
    body: JSON.stringify({
      callback_query: {
        id: "callback-test-1",
        data: callbackData,
        from: { id: senderId },
        message: { message_id: 77, chat: { id: chatId } }
      }
    })
  });
}

test("rejects failed Turnstile verification before notifying Telegram", async () => {
  const { env, state } = createFixture({ turnstileSuccess: false });
  const response = await worker.fetch(orderRequest(), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "human_verification_failed");
  assert.equal(state.telegramMessages, 0);
  assert.equal(state.values.size, 0);
});

test("rate-limits order submissions before challenge verification", async () => {
  const { env, state } = createFixture({ rateLimitAllowed: false });
  const response = await worker.fetch(orderRequest(), env);

  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "rate_limited");
  assert.equal(state.turnstileRequests, 0);
  assert.equal(state.telegramMessages, 0);
});

test("returns the original result for a retried idempotency key", async () => {
  const { env, state } = createFixture();
  const first = await worker.fetch(orderRequest(), env);
  const firstResult = await first.json();
  const retry = await worker.fetch(orderRequest({ turnstileToken: "fresh-turnstile-test-token" }), env);
  const retryResult = await retry.json();

  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retryResult.trackingCode, firstResult.trackingCode);
  assert.equal(state.telegramMessages, 1);
});

test("fetches stock once and aggregates duplicate cart lines", async () => {
  const { env, state } = createFixture({
    stockFeed: {
      schemaVersion: 2,
      managedVariants: ["test-shirt|black"],
      availableSizes: { "test-shirt": { Black: ["M"] } },
      maxOrderable: { "test-shirt": { Black: { M: 1 } } }
    }
  });
  const response = await worker.fetch(orderRequest({
    items: [1, 2].map(() => ({
      brand: "Godderob",
      inventoryBrandId: "godderob",
      inventorySlug: "test-shirt",
      inventoryTone: "Black",
      product: "Test T-shirt",
      size: "M",
      quantity: 1
    }))
  }), env);

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "insufficient_stock");
  assert.equal(state.stockRequests, 1);
  assert.equal(state.telegramMessages, 0);
});

test("rejects Telegram webhooks with an invalid secret", async () => {
  const { env, state } = createFixture();
  seedOrder(state);
  const response = await worker.fetch(webhookRequest(`status:${testOrderCode}:confirmed`, { secret: "wrong-secret" }), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Unauthorized");
  assert.equal((await env.ORDER_TRACKING.get(`order:${testOrderCode}`, "json")).status, "received");
  assert.equal(state.telegramCalls.length, 0);
});

test("does not let callbacks outside the admin chat change an order", async () => {
  const { env, state } = createFixture();
  seedOrder(state);
  const response = await worker.fetch(webhookRequest(`status:${testOrderCode}:confirmed`, { chatId: "999", senderId: "999" }), env);

  assert.equal(response.status, 200);
  assert.equal((await env.ORDER_TRACKING.get(`order:${testOrderCode}`, "json")).status, "received");
  assert.equal(state.telegramCalls.length, 1);
  assert.equal(state.telegramCalls[0].method, "answerCallbackQuery");
  assert.equal(state.telegramCalls[0].payload.show_alert, true);
});

test("advances a valid status and replaces the Telegram button with the next step", async () => {
  const { env, state } = createFixture();
  seedOrder(state);
  const response = await worker.fetch(webhookRequest(`status:${testOrderCode}:confirmed`), env);
  const order = await env.ORDER_TRACKING.get(`order:${testOrderCode}`, "json");
  const editCall = state.telegramCalls.find((call) => call.method === "editMessageReplyMarkup");

  assert.equal(response.status, 200);
  assert.equal(order.status, "confirmed");
  assert.equal(order.statusHistory.length, 2);
  assert.equal(state.telegramCalls[0].method, "answerCallbackQuery");
  assert.equal(editCall.payload.reply_markup.inline_keyboard[0][0].callback_data, `status:${testOrderCode}:preparing`);
});

test("ignores stale callbacks without moving an order backwards", async () => {
  const { env, state } = createFixture();
  const order = seedOrder(state, "preparing");
  order.statusHistory.push({ status: "preparing", at: "2026-10-31T09:01:00.000Z" });
  state.values.set(`order:${testOrderCode}`, JSON.stringify(order));
  const response = await worker.fetch(webhookRequest(`status:${testOrderCode}:confirmed`), env);
  const savedOrder = await env.ORDER_TRACKING.get(`order:${testOrderCode}`, "json");
  const editCall = state.telegramCalls.find((call) => call.method === "editMessageReplyMarkup");

  assert.equal(response.status, 200);
  assert.equal(savedOrder.status, "preparing");
  assert.equal(savedOrder.statusHistory.length, 2);
  assert.equal(editCall.payload.reply_markup.inline_keyboard[0][0].callback_data, `status:${testOrderCode}:shipped`);
});

test("treats repeated status callbacks as replays and tolerates an unchanged keyboard", async () => {
  const telegramFailures = { editMessageReplyMarkup: "Bad Request: message is not modified" };
  const { env, state } = createFixture({ telegramFailures });
  const order = seedOrder(state, "confirmed");
  order.statusHistory.push({ status: "confirmed", at: "2026-10-31T09:01:00.000Z" });
  state.values.set(`order:${testOrderCode}`, JSON.stringify(order));
  const response = await worker.fetch(webhookRequest(`status:${testOrderCode}:confirmed`), env);
  const savedOrder = await env.ORDER_TRACKING.get(`order:${testOrderCode}`, "json");

  assert.equal(response.status, 200);
  assert.equal(savedOrder.status, "confirmed");
  assert.equal(savedOrder.statusHistory.length, 2);
  assert.match(state.telegramCalls[0].payload.text, /Уже обновлено/);
  assert.equal(state.telegramCalls[1].method, "editMessageReplyMarkup");
});

test("recovers from a temporary Telegram callback error without duplicating the transition", async () => {
  const telegramFailures = { answerCallbackQuery: "temporary Telegram error" };
  const { env, state } = createFixture({ telegramFailures });
  seedOrder(state);
  const callback = () => webhookRequest(`status:${testOrderCode}:confirmed`);

  await assert.rejects(worker.fetch(callback(), env), /temporary Telegram error/);
  const afterFirstAttempt = await env.ORDER_TRACKING.get(`order:${testOrderCode}`, "json");
  assert.equal(afterFirstAttempt.status, "confirmed");
  assert.equal(afterFirstAttempt.statusHistory.length, 2);

  delete telegramFailures.answerCallbackQuery;
  const retry = await worker.fetch(callback(), env);
  const afterRetry = await env.ORDER_TRACKING.get(`order:${testOrderCode}`, "json");

  assert.equal(retry.status, 200);
  assert.equal(afterRetry.status, "confirmed");
  assert.equal(afterRetry.statusHistory.length, 2);
});
