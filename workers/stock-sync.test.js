import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { maxStockAgeMs, parseGodderobStock, readFreshStock, restockWindowMs, stockStorageKeys, syncGodderobStock } from "./stock-sync.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createStorage() {
  const values = new Map();
  return {
    values,
    get: async (key, type) => {
      const value = values.get(key);
      return type === "json" && value ? JSON.parse(value) : value ?? null;
    },
    put: async (key, value) => values.set(key, value)
  };
}

const fixtureCsv = "\uFEFFАртикул_размера,Размер,Общий остаток,Город\r\nJesus lovers беж_S,S,2,Минск\r\nJesus lovers беж_M,M,8,Минск\r\nJesus lovers беж_L,L,0,Минск\r\nNAME графит_S,S,1,\"Минск, центр\"\r\n";

test("parses quoted CSV, normalizes sizes, caps order quantities, and omits exact counts", () => {
  const feed = parseGodderobStock(fixtureCsv);

  assert.deepEqual(feed.availableSizes["jesus-lovers-club-men"]["бежевый"], ["S", "M"]);
  assert.equal(feed.maxOrderable["jesus-lovers-club-men"]["бежевый"].S, 2);
  assert.equal(feed.maxOrderable["jesus-lovers-club-men"]["бежевый"].M, 3);
  assert.equal(feed.maxOrderable.name["графитовый"].S, 1);
  assert.equal(feed.schemaVersion, 2);
  assert.doesNotMatch(JSON.stringify(feed), /Общий остаток|Минск|8/);
});

test("parses the manager's movement ledger using merged article cells and signed movements", () => {
  const csv = `,статус,Артикул_размера,Тип,Кол-во,Остаток,Примечание\nПереучет,,Jesus lovers беж_S,Приход,4,4,\n,, ,Заказ (с минусом),-1,3,\n,,NAME графит_M,Приход,2,2,\n`;
  const feed = parseGodderobStock(csv);

  assert.deepEqual(feed.availableSizes["jesus-lovers-club-men"]["бежевый"], ["S"]);
  assert.equal(feed.maxOrderable["jesus-lovers-club-men"]["бежевый"].S, 3);
  assert.deepEqual(feed.availableSizes.name["графитовый"], ["M"]);
  assert.equal(feed.maxOrderable.name["графитовый"].M, 2);
});

test("maps one-size cap ledger articles to stock-controlled OS variants", () => {
  const csv = ",статус,Артикул_размера,Тип,Кол-во,Остаток,Примечание\nПереучет,,Кепка_песочная,Приход,6,6,\n,,Кепка_черная,Приход,9,9,\n,,Кепка_бордовая,Приход,7,7,\n,,Кепка_рыжая,Приход,7,7,\n";
  const feed = parseGodderobStock(csv);

  assert.deepEqual(feed.availableSizes["godderob-caps"]["песочный"], ["OS"]);
  assert.equal(feed.maxOrderable["godderob-caps"]["песочный"].OS, 3);
  assert.deepEqual(feed.availableSizes["godderob-caps"]["чёрный"], ["OS"]);
  assert.equal(feed.maxOrderable["godderob-caps"]["бордовый"].OS, 3);
  assert.equal(feed.maxOrderable["godderob-caps"]["рыжий"].OS, 3);
});

test("rejects malformed, unmapped, and empty stock CSVs rather than publishing empty availability", () => {
  assert.throws(() => parseGodderobStock("Артикул_размера,Размер\n"), /missing columns/);
  assert.throws(() => parseGodderobStock("Артикул_размера,Размер,Общий остаток\n\"broken,S,1\n"), /unclosed quoted field/);
  assert.throws(() => parseGodderobStock("Артикул_размера,Размер,Общий остаток\nUnknown product_M,M,5\n"), /No mapped positive stock rows/);
});

test("rejects a ledger when its signed movements do not reconcile with the balance", () => {
  const csv = "Артикул_размера,Тип,Кол-во,Остаток\nJesus lovers беж_S,Приход,4,3\n";
  assert.throws(() => parseGodderobStock(csv), /movements do not match/);
});

test("reads only fresh stock feeds", async () => {
  const storage = createStorage();
  const keys = stockStorageKeys();
  const feed = { schemaVersion: 2, managedVariants: [], availableSizes: {}, maxOrderable: {} };
  const now = Date.now();
  storage.values.set(keys.feed, JSON.stringify(feed));
  storage.values.set(keys.status, JSON.stringify({ lastSuccessAt: new Date(now - maxStockAgeMs).toISOString() }));

  assert.deepEqual((await readFreshStock({ ORDER_TRACKING: storage }, now)).feed, feed);
  await assert.rejects(readFreshStock({ ORDER_TRACKING: storage }, now + 1), /missing or stale/);

  storage.values.set(keys.status, JSON.stringify({ lastSuccessAt: new Date(now + 60_000).toISOString() }));
  await assert.rejects(readFreshStock({ ORDER_TRACKING: storage }, now), /missing or stale/);
});

test("stores sanitized stock and preserves last success when the source later fails", async () => {
  const storage = createStorage();
  const keys = stockStorageKeys();
  const env = { ORDER_TRACKING: storage, GODDEROB_STOCK_CSV_URL: "https://example.test/stock.csv" };
  const now = new Date("2026-10-31T12:00:00.000Z");
  globalThis.fetch = async () => new Response(fixtureCsv, { status: 200 });

  const successfulSync = await syncGodderobStock(env, now);
  assert.equal(successfulSync.lastSuccessAt, now.toISOString());
  const savedFeed = JSON.parse(storage.values.get(keys.feed));
  assert.equal(savedFeed.maxOrderable["jesus-lovers-club-men"]["бежевый"].M, 3);

  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(syncGodderobStock(env, new Date(now.getTime() + 15 * 60_000)), /HTTP 503/);

  const status = JSON.parse(storage.values.get(keys.status));
  assert.equal(status.lastSuccessAt, now.toISOString());
  assert.equal(status.errorCode, "stock_sync_failed");
  assert.equal(storage.values.get(keys.feed), JSON.stringify(savedFeed));
});

test("records a managed variant returning from out of stock for 14 days", async () => {
  const storage = createStorage();
  const keys = stockStorageKeys();
  const env = { ORDER_TRACKING: storage, GODDEROB_STOCK_CSV_URL: "https://example.test/stock.csv" };
  const now = new Date("2026-11-06T12:00:00.000Z");
  const unavailableCsv = "Артикул_размера,Размер,Общий остаток\nJesus lovers беж_S,S,0\nNAME графит_S,S,1\n";
  const availableCsv = "Артикул_размера,Размер,Общий остаток\nJesus lovers беж_S,S,2\nNAME графит_S,S,1\n";

  globalThis.fetch = async () => new Response(unavailableCsv, { status: 200 });
  await syncGodderobStock(env, now);
  assert.deepEqual(JSON.parse(storage.values.get(keys.recentlyRestocked) || "{}"), {});

  globalThis.fetch = async () => new Response(availableCsv, { status: 200 });
  const returnedAt = new Date(now.getTime() + 15 * 60_000);
  await syncGodderobStock(env, returnedAt);
  const expected = { "jesus-lovers-club-men|бежевый": returnedAt.toISOString() };
  assert.deepEqual(JSON.parse(storage.values.get(keys.recentlyRestocked)), expected);
  assert.deepEqual((await readFreshStock(env, returnedAt.getTime())).recentlyRestocked, expected);

  const afterWindow = new Date(returnedAt.getTime() + restockWindowMs + 1);
  await syncGodderobStock(env, afterWindow);
  assert.deepEqual(JSON.parse(storage.values.get(keys.recentlyRestocked)), {});
  assert.deepEqual((await readFreshStock(env, afterWindow.getTime())).recentlyRestocked, {});
});
