import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import worker from "./order-worker.js";

const originalFetch = globalThis.fetch;
const orderUrl = "https://goel-order-api.o-el.workers.dev/order";
const turnstileUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createFixture({ turnstileSuccess = true, rateLimitAllowed = true, stockFeed = null } = {}) {
  const state = { turnstileRequests: 0, stockRequests: 0, telegramMessages: 0, rateLimitRequests: 0, values: new Map() };
  globalThis.fetch = async (input) => {
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
      if (url.endsWith("/sendMessage")) state.telegramMessages += 1;
      return Response.json({ ok: true, result: { message_id: 42 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const env = {
    ALLOWED_ORIGIN: "https://mikitatrv.github.io",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_CHAT_ID: "12345",
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
