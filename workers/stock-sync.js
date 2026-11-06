const stockFeedKey = "stock:godderob:feed";
const stockSyncStatusKey = "stock:godderob:sync-status";
const recentlyRestockedKey = "stock:godderob:recently-restocked";
const maxPublicOrderQuantity = 3;
export const maxStockAgeMs = 45 * 60 * 1000;
export const restockWindowMs = 14 * 24 * 60 * 60 * 1000;
const restockWindowSeconds = restockWindowMs / 1000;

const sheetPrefixes = {
  "jesusloversбеж": ["jesus-lovers-club-men", "бежевый"],
  "jesusloversсиний": ["jesus-lovers-club-men", "синий"],
  "jesusloversнебесный": ["jesus-lovers-club-women", "небесный"],
  "jesusloversтравяной": ["jesus-lovers-club-men", "травяной"],
  "jesusloversкрасный": ["jesus-lovers-club-men", "красный"],
  "oduvanchikрозовый": ["oduvanchik", "розовый"],
  "oduvanchikнебесный": ["oduvanchik", "небесный"],
  "oduvanchikсливочный": ["oduvanchik-zip-yellow", "светло-жёлтый"],
  "jesusloversclubsweatshirtсиний": ["jesus-lovers-club-sweatshirt", "синий"],
  "jesusloversclubsweatshirtиндиго": ["jesus-lovers-club-sweatshirt", "синий"],
  "jesusloversclubсвитшотсиний": ["jesus-lovers-club-sweatshirt", "синий"],
  "jesusloversclubсвитшотиндиго": ["jesus-lovers-club-sweatshirt", "синий"],
  "барашеккофе": ["shepherd-women", "кофе"],
  "барашекизумруд": ["shepherd-men", "изумруд"],
  "onlyjesusчерный": ["only-jesus", "чёрный"],
  "onlyjesusтравяной": ["only-jesus", "травяной"],
  "onlyjesusбелый": ["only-jesus-long-white", "белый"],
  "onlyjesusмолочный": ["only-jesus-long-white", "белый"],
  "onlyjesusмолоко": ["only-jesus-long-white", "белый"],
  "onlyjesusлонгбелый": ["only-jesus-long-white", "белый"],
  "onlyjesusлонгмолочный": ["only-jesus-long-white", "белый"],
  "onlyjesusлонгмолоко": ["only-jesus-long-white", "белый"],
  "childofgodборд": ["child-of-god", "розовый"],
  "childofgodбелый": ["child-of-god", "белый"],
  "childofgodмолочный": ["child-of-god", "белый"],
  lovebut: ["love-like-jesus", "травяной"],
  "jesusislordгорчица": ["jesus-is-lord-women", "горчичный"],
  "jesusislordкоричневый": ["jesus-is-lord-women", "коричневый"],
  "jesusislordшоколад": ["jesus-is-lord-women", "коричневый"],
  "богестьлюбовьмолоко": ["bog-est-lubov-men", "молочный"],
  "nameграфит": ["name", "графитовый"],
  "nameбордо": ["name", "бордовый"],
  "nameмолоко": ["name", "белый"],
  "praiseчерныйфутб": ["praise-tee", "чёрный"],
  "praiseчерныйлонг": ["praise-long-women", "чёрный"],
  "praiseсинийлонг": ["praise-long-men", "синий"],
  wins: ["wins", "чёрный"],
  "winsфутболка": ["wins-tee-black", "чёрный"],
  "winsфутб": ["wins-tee-black", "чёрный"],
  "winstshirtчерный": ["wins-tee-black", "чёрный"],
  "byjesusлонг": ["by-jesus", "тёмно-синий"],
  пластырь: ["jesus-healed", "белый"],
  saved: ["saved", "бордовый"],
  "богестьлюбовьроз": ["bog-est-lubov-women", "розовый"]
};

const alwaysManagedVariants = [
  "child-of-god|белый",
  "child-of-god|небесный",
  "jesus-lovers-club-sweatshirt|синий",
  "jesus-is-lord-women|коричневый",
  "only-jesus-long-white|белый",
  "wins-tee-black|черный"
];
const sizeOrder = new Map(["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "OS"].map((size, index) => [size, index]));
const sizeLookalikes = new Map([["Х", "X"], ["х", "x"], ["М", "M"], ["м", "m"], ["С", "S"], ["с", "s"], ["Л", "L"], ["л", "l"]]);

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/ё/g, "е").replace(/[^a-z0-9а-я]+/g, "").replace(/xxl$/, "2xl");
}

function normalizeSize(value) {
  let size = String(value || "").trim().replace(/[ХхМмСсЛл]/g, (character) => sizeLookalikes.get(character) || character).toUpperCase();
  return size.replace(/XXL/g, "2XL");
}

function parseCsv(csvText) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const input = csvText.replace(/^\uFEFF/, "");

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"' && value.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value.length || row.length) {
    row.push(value);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  if (quoted) throw new Error("Malformed stock CSV: unclosed quoted field");
  return rows;
}

function stockArticlePrefix(article, size) {
  const match = /[_\s-]+([^_\s-]+)$/.exec(String(article || "").trim());
  if (!match || normalizeSize(match[1]) !== normalizeSize(size)) return null;
  return normalize(article.slice(0, match.index));
}

export function parseGodderobStock(csvText) {
  const rows = parseCsv(csvText);
  const headers = (rows.shift() || []).map((header) => header.trim());
  const summaryColumns = ["Артикул_размера", "Размер", "Общий остаток"];
  const ledgerColumns = ["Артикул_размера", "Кол-во", "Остаток"];
  const isLedger = ledgerColumns.every((header) => headers.includes(header));
  const required = isLedger ? ledgerColumns : summaryColumns;
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`Наличие CSV missing columns: ${missing.join(", ")}`);
  const columns = Object.fromEntries(headers.map((header, index) => [header, index]));
  const quantities = new Map();

  if (isLedger) {
    const articleBalances = new Map();
    let currentArticle = "";
    for (const row of rows) {
      const rowArticle = String(row[columns["Артикул_размера"]] || "").trim();
      if (rowArticle) currentArticle = rowArticle;
      const rawQuantity = String(row[columns["Кол-во"]] || "").trim();
      const rawBalance = String(row[columns["Остаток"]] || "").trim();
      if (!rawQuantity) continue;
      if (!currentArticle || !rawBalance) {
        throw new Error("Malformed stock ledger row: missing article, quantity, or balance");
      }

      const parsedQuantity = Number(rawQuantity.replace(",", "."));
      const parsedBalance = Number(rawBalance.replace(",", "."));
      if (!Number.isFinite(parsedQuantity) || !Number.isFinite(parsedBalance)) {
        throw new Error("Malformed stock ledger row: quantity and balance must be numeric");
      }
      const entry = articleBalances.get(currentArticle) || { movementTotal: 0, balance: 0 };
      entry.movementTotal += Math.trunc(parsedQuantity);
      entry.balance = Math.trunc(parsedBalance);
      articleBalances.set(currentArticle, entry);
    }

    for (const [article, { movementTotal, balance }] of articleBalances) {
      if (movementTotal !== balance) {
        throw new Error("Stock ledger movements do not match the reported balances");
      }
      const sizeMatch = /[_\s-]+([^_\s-]+)$/.exec(article);
      if (!sizeMatch) continue;
      const size = normalizeSize(sizeMatch[1]);
      const target = sheetPrefixes[stockArticlePrefix(article, size)];
      if (!target) continue;
      const [slug, tone] = target;
      const key = JSON.stringify([slug, tone, size]);
      quantities.set(key, (quantities.get(key) || 0) + balance);
    }
  } else {
    for (const row of rows) {
      const article = String(row[columns["Артикул_размера"]] || "").trim();
      const size = normalizeSize(row[columns["Размер"]]);
      const rawQuantity = String(row[columns["Общий остаток"]] || "").trim();
      if (!article || !size || !rawQuantity) continue;
      const parsedQuantity = Number(rawQuantity.replace(",", "."));
      if (!Number.isFinite(parsedQuantity)) continue;
      const quantity = Math.trunc(parsedQuantity);
      const target = sheetPrefixes[stockArticlePrefix(article, size)];
      if (!target) continue;
      const [slug, tone] = target;
      const key = JSON.stringify([slug, tone, size]);
      quantities.set(key, (quantities.get(key) || 0) + quantity);
    }
  }

  const availableSizes = {};
  const maxOrderable = {};
  for (const [key, quantity] of quantities) {
    if (quantity <= 0) continue;
    const [slug, tone, size] = JSON.parse(key);
    availableSizes[slug] ||= {};
    availableSizes[slug][tone] ||= [];
    availableSizes[slug][tone].push(size);
    maxOrderable[slug] ||= {};
    maxOrderable[slug][tone] ||= {};
    maxOrderable[slug][tone][size] = Math.min(quantity, maxPublicOrderQuantity);
  }

  const sortNested = (object, sortValues = false) => Object.fromEntries(Object.keys(object).sort().map((key) => [
    key,
    sortValues && Array.isArray(object[key])
      ? [...object[key]].sort((left, right) => (sizeOrder.get(left) ?? 999) - (sizeOrder.get(right) ?? 999))
      : object[key] && typeof object[key] === "object" && !Array.isArray(object[key])
        ? sortNested(object[key], false)
        : object[key]
  ]));
  const sortedAvailableSizes = Object.fromEntries(Object.keys(availableSizes).sort().map((slug) => [
    slug,
    Object.fromEntries(Object.keys(availableSizes[slug]).sort().map((tone) => [
      tone,
      [...availableSizes[slug][tone]].sort((left, right) => (sizeOrder.get(left) ?? 999) - (sizeOrder.get(right) ?? 999))
    ]))
  ]));
  const sortedMaxOrderable = sortNested(maxOrderable);
  if (!Object.keys(sortedAvailableSizes).length) {
    throw new Error("No mapped positive stock rows found; refusing to publish empty availability");
  }

  const mappedVariants = Object.entries(sheetPrefixes).map(([, [slug, tone]]) => `${slug}|${normalize(tone)}`);
  return {
    schemaVersion: 2,
    managedVariants: [...new Set([...mappedVariants, ...alwaysManagedVariants])].sort(),
    availableSizes: sortedAvailableSizes,
    maxOrderable: sortedMaxOrderable
  };
}

function activeRestocks(restocks, nowMs) {
  return Object.fromEntries(Object.entries(restocks || {})
    .filter(([key, value]) => {
      const timestamp = Date.parse(value);
      return /^[a-z0-9-]+\|[a-z0-9а-я]+$/u.test(key)
        && Number.isFinite(timestamp)
        && timestamp <= nowMs
        && nowMs - timestamp < restockWindowMs;
    })
    .sort(([left], [right]) => left.localeCompare(right)));
}

function updateRestocks(currentFeed, nextFeed, previousRestocks, now) {
  const nowMs = now.getTime();
  const restocks = activeRestocks(previousRestocks, nowMs);
  if (!currentFeed?.availableSizes || !Array.isArray(currentFeed.managedVariants)) {
    return restocks;
  }

  for (const [slug, tones] of Object.entries(nextFeed.availableSizes)) {
    for (const [tone, sizes] of Object.entries(tones)) {
      if (!Array.isArray(sizes) || !sizes.length) continue;
      const key = `${slug}|${normalize(tone)}`;
      if (!currentFeed.managedVariants.includes(key)) continue;
      const previousSizes = currentFeed.availableSizes[slug]?.[tone];
      if (!Array.isArray(previousSizes) || previousSizes.length === 0) {
        restocks[key] = now.toISOString();
      }
    }
  }
  return Object.fromEntries(Object.entries(restocks).sort(([left], [right]) => left.localeCompare(right)));
}

export async function readFreshStock(env, now = Date.now()) {
  if (!env.ORDER_TRACKING) throw new Error("Stock storage is not configured");
  const [feed, status, restocks] = await Promise.all([
    env.ORDER_TRACKING.get(stockFeedKey, "json"),
    env.ORDER_TRACKING.get(stockSyncStatusKey, "json"),
    env.ORDER_TRACKING.get(recentlyRestockedKey, "json")
  ]);
  const lastSuccessAt = status?.lastSuccessAt;
  const lastSuccess = Date.parse(lastSuccessAt || "");
  if (!feed || !Number.isFinite(lastSuccess) || lastSuccess > now || now - lastSuccess > maxStockAgeMs) {
    throw new Error("Stock feed is missing or stale");
  }
  return { feed, lastSuccessAt, recentlyRestocked: activeRestocks(restocks, now) };
}

export async function syncGodderobStock(env, now = new Date()) {
  if (!env.ORDER_TRACKING) throw new Error("Stock storage is not configured");
  if (!env.GODDEROB_STOCK_CSV_URL) throw new Error("Stock source is not configured");
  const lastAttemptAt = now.toISOString();
  const previousStatus = await env.ORDER_TRACKING.get(stockSyncStatusKey, "json");

  try {
    const response = await fetch(env.GODDEROB_STOCK_CSV_URL, {
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache", "User-Agent": "GOEL-stock-sync/1.0" },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Stock source returned HTTP ${response.status}`);
    const csvText = await response.text();
    if (csvText.length > 2_000_000) throw new Error("Stock CSV is too large");
    const nextFeed = parseGodderobStock(csvText);
    const [currentFeed, currentRestocks] = await Promise.all([
      env.ORDER_TRACKING.get(stockFeedKey, "json"),
      env.ORDER_TRACKING.get(recentlyRestockedKey, "json")
    ]);
    const nextRestocks = updateRestocks(currentFeed, nextFeed, currentRestocks, now);
    const changed = JSON.stringify(currentFeed) !== JSON.stringify(nextFeed);
    if (changed) await env.ORDER_TRACKING.put(stockFeedKey, JSON.stringify(nextFeed));
    if (JSON.stringify(currentRestocks || {}) !== JSON.stringify(nextRestocks)) {
      await env.ORDER_TRACKING.put(recentlyRestockedKey, JSON.stringify(nextRestocks), { expirationTtl: restockWindowSeconds });
    }

    const status = { lastAttemptAt, lastSuccessAt: lastAttemptAt, changed, errorCode: null };
    await env.ORDER_TRACKING.put(stockSyncStatusKey, JSON.stringify(status));
    return status;
  } catch (error) {
    const status = {
      lastAttemptAt,
      lastSuccessAt: previousStatus?.lastSuccessAt || null,
      changed: false,
      errorCode: "stock_sync_failed"
    };
    await env.ORDER_TRACKING.put(stockSyncStatusKey, JSON.stringify(status)).catch(() => {});
    throw error;
  }
}

export function stockStorageKeys() {
  return { feed: stockFeedKey, status: stockSyncStatusKey, recentlyRestocked: recentlyRestockedKey };
}
