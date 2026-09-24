const BOT_NAME = "memebott";

/*
  ============================================================
  MEMEBOTT — MULTI-SOURCE PAPER TRADING ENGINE
  ============================================================

  PAPER ONLY.
  No private key.
  No wallet signing.
  No real-money transaction execution.

  Discovery:
    1. DEX Screener
    2. GeckoTerminal
    3. Jupiter price data

  Jupiter is NOT the primary discovery source.

  Strategy:
    - Discover many Solana candidates
    - Combine/deduplicate candidates
    - Analyze liquidity, volume, buys/sells,
      momentum, acceleration and pool age
    - Score candidates
    - Paper-buy only the strongest eligible candidate
    - Monitor positions
    - Hard stop
    - Trailing-profit exit
    - Record every decision
*/

const PAPER_MODE = true;

const PAPER_STARTING_CASH_USD = 100;
const PAPER_MIN_CASH_RESERVE_USD = 10;

const SMALL_TRADE_CAP_USD = 2;
const LARGE_TRADE_CAP_USD = 5;
const BALANCE_THRESHOLD_USD = 20;

const MAX_POSITIONS = 10;
const MAX_NEW_BUYS_PER_RUN = 1;

/*
  EXIT RULES
*/
const STOP_LOSS = -0.01;
const TRAILING_ACTIVATION = 0.01;
const TRAILING_STOP = 0.03;
const REVERSAL_CONFIRMATIONS_REQUIRED = 2;

/*
  SCANNER
*/
const MAX_CANDIDATES = 30;
const MAX_DEX_TOKENS_TO_ANALYZE = 30;
const MAX_GECKO_POOLS_TO_ANALYZE = 10;

const MIN_TOKEN_PRICE_USD = 0.00000001;

/*
  Minimum liquidity required before a candidate can
  become a paper position.
*/
const MIN_LIQUIDITY_USD = 15000;

/*
  Minimum 24h volume.
*/
const MIN_VOLUME_24H_USD = 10000;

/*
  Minimum 1h volume.
*/
const MIN_VOLUME_1H_USD = 1000;

/*
  Do not buy something that has been sitting around
  without meaningful activity.
*/
const MAX_PAIR_AGE_DAYS = 365;

/*
  Avoid immediately re-buying the same token.
*/
const COOLDOWN_SECONDS = 60;

const PORTFOLIO_KEY = "PAPER_PORTFOLIO";
const HISTORY_KEY = "PAPER_TRADE_HISTORY";
const COOLDOWN_KEY = "PAPER_TRADE_COOLDOWN";
const SCAN_KEY = "LAST_SCAN";

const DEXSCREENER_API = "https://api.dexscreener.com";
const GECKO_API = "https://api.geckoterminal.com/api/v2";
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufG4C8G4wEGGkZwyTDt1v";

/*
  Known stable/native quote symbols that should not
  accidentally become buy candidates.
*/
const BLOCKED_SYMBOLS = new Set([
  "USDC",
  "USDT",
  "USD1",
  "USDS",
  "DAI",
  "SOL",
  "WSOL"
]);

/*
  ============================================================
  BASIC HELPERS
  ============================================================
*/

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pct(value) {
  return safeNumber(value) / 100;
}

function ageDays(timestampMs) {
  if (!timestampMs) return 9999;

  const age =
    Date.now() - Number(timestampMs);

  if (!Number.isFinite(age) || age < 0) {
    return 0;
  }

  return age / 86400000;
}

function normalizeAddress(value) {
  return String(value || "").trim();
}

function isValidMint(mint) {
  return (
    typeof mint === "string" &&
    mint.length >= 32 &&
    mint.length <= 50
  );
}

function isBlockedSymbol(symbol) {
  return BLOCKED_SYMBOLS.has(
    String(symbol || "").toUpperCase()
  );
}

/*
  ============================================================
  HTTP
  ============================================================
*/

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      ...headers
    }
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} from ${url}`
    );
  }

  return await response.json();
}

/*
  ============================================================
  PAPER PORTFOLIO
  ============================================================
*/

function createFreshPortfolio() {
  return {
    starting_cash_usd: PAPER_STARTING_CASH_USD,
    cash_usd: PAPER_STARTING_CASH_USD,
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 0,
    total_pnl_usd: 0,
    return_percent: 0,
    open_positions: [],
    last_run_at: null,
    updated_at: nowIso()
  };
}

async function getPortfolio(env) {
  const raw = await env.BOT_KV.get(PORTFOLIO_KEY);

  if (!raw) {
    const portfolio = createFreshPortfolio();

    await savePortfolio(env, portfolio);

    return portfolio;
  }

  try {
    const portfolio = JSON.parse(raw);

    if (!Array.isArray(portfolio.open_positions)) {
      portfolio.open_positions = [];
    }

    return portfolio;
  } catch {
    const portfolio = createFreshPortfolio();

    await savePortfolio(env, portfolio);

    return portfolio;
  }
}

async function savePortfolio(env, portfolio) {
  portfolio.updated_at = nowIso();

  await env.BOT_KV.put(
    PORTFOLIO_KEY,
    JSON.stringify(portfolio)
  );
}

async function getHistory(env) {
  const raw = await env.BOT_KV.get(HISTORY_KEY);

  if (!raw) return [];

  try {
    const history = JSON.parse(raw);

    return Array.isArray(history)
      ? history
      : [];
  } catch {
    return [];
  }
}

async function saveHistory(env, history) {
  /*
    Keep the last 500 events.
  */
  const trimmed = history.slice(-500);

  await env.BOT_KV.put(
    HISTORY_KEY,
    JSON.stringify(trimmed)
  );
}

async function addHistory(env, event) {
  const history = await getHistory(env);

  history.push({
    timestamp: nowIso(),
    ...event
  });

  await saveHistory(env, history);
}

/*
  ============================================================
  COOLDOWN
  ============================================================
*/

async function getCooldowns(env) {
  const raw = await env.BOT_KV.get(COOLDOWN_KEY);

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCooldowns(env, cooldowns) {
  await env.BOT_KV.put(
    COOLDOWN_KEY,
    JSON.stringify(cooldowns)
  );
}

async function isCoolingDown(env, mint) {
  const cooldowns = await getCooldowns(env);

  const last = safeNumber(
    cooldowns[mint],
    0
  );

  return (
    Date.now() - last <
    COOLDOWN_SECONDS * 1000
  );
}

async function setCooldown(env, mint) {
  const cooldowns = await getCooldowns(env);

  cooldowns[mint] = Date.now();

  /*
    Remove very old entries.
  */
  for (const key of Object.keys(cooldowns)) {
    if (
      Date.now() - safeNumber(cooldowns[key], 0) >
      86400000
    ) {
      delete cooldowns[key];
    }
  }

  await saveCooldowns(env, cooldowns);
}

/*
  ============================================================
  DEX SCREENER DISCOVERY
  ============================================================
*/

/*
  DEX Screener provides public endpoints for:
    - latest token profiles
    - latest boosts
    - top boosts
    - token/pair lookup

  We use several of them to broaden discovery.
*/

async function getDexScreenerDiscovery() {
  const results = [];

  const urls = [
    `${DEXSCREENER_API}/token-profiles/latest/v1`,
    `${DEXSCREENER_API}/token-boosts/latest/v1`,
    `${DEXSCREENER_API}/token-boosts/top/v1`
  ];

  for (const url of urls) {
    try {
      const data = await getJson(url);

      if (Array.isArray(data)) {
        results.push(...data);
      }
    } catch (error) {
      /*
        One source failing should not kill the scanner.
      */
    }
  }

  const unique = new Map();

  for (const item of results) {
    if (
      String(item.chainId || "").toLowerCase() !==
      "solana"
    ) {
      continue;
    }

    const mint = normalizeAddress(
      item.tokenAddress
    );

    if (!isValidMint(mint)) continue;

    unique.set(mint, {
      mint,
      source: "DEXSCREENER",
      dex_url: item.url || null,
      boosted: Boolean(
        item.amount ||
        item.totalAmount
      )
    });
  }

  return [...unique.values()];
}

/*
  DEX Screener's search endpoint is used with common
  Solana quote symbols to find additional active pairs.
*/
async function getDexSearchCandidates() {
  const searches = [
    "SOL",
    "USDC",
    "USDT"
  ];

  const candidates = [];

  for (const query of searches) {
    try {
      const url =
        `${DEXSCREENER_API}/latest/dex/search?q=` +
        encodeURIComponent(query);

      const data = await getJson(url);

      if (!Array.isArray(data.pairs)) {
        continue;
      }

      for (const pair of data.pairs) {
        if (
          String(pair.chainId || "").toLowerCase() !==
          "solana"
        ) {
          continue;
        }

        const base =
          pair.baseToken || {};

        const mint =
          normalizeAddress(base.address);

        if (!isValidMint(mint)) continue;

        candidates.push({
          mint,
          source: "DEXSCREENER_SEARCH",
          pair
        });
      }
    } catch {
      /*
        Continue with other searches.
      */
    }
  }

  return candidates;
}

/*
  Fetch detailed pair information for up to 30 tokens
  in one request.
*/
async function hydrateDexCandidates(candidates) {
  const uniqueMints = [
    ...new Set(
      candidates
        .map(x => x.mint)
        .filter(isValidMint)
    )
  ].slice(
    0,
    MAX_DEX_TOKENS_TO_ANALYZE
  );

  if (!uniqueMints.length) {
    return [];
  }

  const url =
    `${DEXSCREENER_API}/tokens/v1/solana/` +
    uniqueMints.join(",");

  try {
    const pairs = await getJson(url);

    if (!Array.isArray(pairs)) {
      return [];
    }

    return pairs.filter(
      pair =>
        String(pair.chainId || "").toLowerCase() ===
        "solana"
    );
  } catch {
    return [];
  }
}

/*
  ============================================================
  GECKOTERMINAL DISCOVERY
  ============================================================
*/

async function getGeckoTrendingPools() {
  try {
    const url =
      `${GECKO_API}/networks/solana/trending_pools`;

    const data = await getJson(url);

    if (!Array.isArray(data.data)) {
      return [];
    }

    return data.data
      .slice(0, MAX_GECKO_POOLS_TO_ANALYZE)
      .map(pool => {
        const attrs =
          pool.attributes || {};

        const relationships =
          pool.relationships || {};

        /*
          Gecko pool IDs are normally:
          solana_<pool-address>
        */
        const poolId =
          String(pool.id || "");

        const poolAddress =
          poolId.includes("_")
            ? poolId.split("_").slice(1).join("_")
            : poolId;

        return {
          source: "GECKOTERMINAL",
          pool_address: poolAddress,
          name: attrs.name || null,
          address:
            relationships.base_token?.data?.id ||
            null,
          attributes: attrs
        };
      });
  } catch {
    return [];
  }
}

/*
  Gecko token IDs can be formatted:
    solana_<mint>

  Convert them into normal mint addresses.
*/
function extractGeckoMint(value) {
  const textValue =
    String(value || "");

  if (!textValue) return "";

  if (textValue.includes("_")) {
    return textValue
      .split("_")
      .slice(1)
      .join("_");
  }

  return textValue;
}

/*
  ============================================================
  DEX DATA NORMALIZATION
  ============================================================
*/

function getBestDexPair(pairs, mint) {
  const matches = pairs.filter(pair => {
    return (
      normalizeAddress(
        pair.baseToken?.address
      ) === mint
    );
  });

  if (!matches.length) {
    return null;
  }

  /*
    Prefer the deepest liquidity pool.
  */
  matches.sort(
    (a, b) =>
      safeNumber(b.liquidity?.usd) -
      safeNumber(a.liquidity?.usd)
  );

  return matches[0];
}

function normalizeDexPair(pair) {
  const txns = pair.txns || {};
  const volume = pair.volume || {};
  const change = pair.priceChange || {};

  const h24 =
    txns.h24 || {};

  const h6 =
    txns.h6 || {};

  const h1 =
    txns.h1 || {};

  const m5 =
    txns.m5 || {};

  return {
    mint:
      normalizeAddress(
        pair.baseToken?.address
      ),

    symbol:
      pair.baseToken?.symbol ||
      "UNKNOWN",

    name:
      pair.baseToken?.name ||
      "Unknown",

    price_usd:
      safeNumber(pair.priceUsd),

    liquidity_usd:
      safeNumber(pair.liquidity?.usd),

    volume_24h_usd:
      safeNumber(volume.h24),

    volume_6h_usd:
      safeNumber(volume.h6),

    volume_1h_usd:
      safeNumber(volume.h1),

    volume_5m_usd:
      safeNumber(volume.m5),

    buys_24h:
      safeNumber(h24.buys),

    sells_24h:
      safeNumber(h24.sells),

    buys_1h:
      safeNumber(h1.buys),

    sells_1h:
      safeNumber(h1.sells),

    buys_5m:
      safeNumber(m5.buys),

    sells_5m:
      safeNumber(m5.sells),

    price_change_24h:
      safeNumber(change.h24),

    price_change_6h:
      safeNumber(change.h6),

    price_change_1h:
      safeNumber(change.h1),

    price_change_5m:
      safeNumber(change.m5),

    fdv:
      safeNumber(pair.fdv),

    market_cap:
      safeNumber(pair.marketCap),

    pair_created_at:
      safeNumber(pair.pairCreatedAt),

    pair_age_days:
      ageDays(
        safeNumber(pair.pairCreatedAt)
      ),

    dex:
      pair.dexId || null,

    pair_address:
      pair.pairAddress || null,

    pair_url:
      pair.url || null,

    boosts_active:
      safeNumber(
        pair.boosts?.active
      )
  };
}

/*
  ============================================================
  JUPITER CROSS-CHECK
  ============================================================
*/

async function getJupiterPrices(mints) {
  const unique = [
    ...new Set(
      mints.filter(isValidMint)
    )
  ];

  if (!unique.length) {
    return {};
  }

  try {
    const url =
      `${JUPITER_PRICE_API}?ids=` +
      unique.join(",");

    const headers = {};

    /*
      If the existing Cloudflare secret exists,
      use it. Otherwise the public request is attempted.
    */
    if (envHasJupiterKey) {
      headers["x-api-key"] =
        envHasJupiterKey;
    }

    const data =
      await getJson(url, headers);

    return data?.data || {};
  } catch {
    return {};
  }
}

/*
  This variable is assigned by scanCandidates()
  because Cloudflare env is required.
*/
let envHasJupiterKey = null;

async function getJupiterCrossCheck(env, mints) {
  envHasJupiterKey =
    env.JUPITER_API_KEY || null;

  return await getJupiterPrices(mints);
}

/*
  ============================================================
  CANDIDATE SCORING
  ============================================================
*/

function calculateBuyPressure(data) {
  const buys =
    safeNumber(data.buys_1h);

  const sells =
    safeNumber(data.sells_1h);

  const total =
    buys + sells;

  if (total <= 0) {
    return 0;
  }

  return buys / total;
}

function calculateMomentumScore(data) {
  let score = 0;

  /*
    5m momentum
  */
  if (data.price_change_5m > 0) {
    score += clamp(
      data.price_change_5m * 0.8,
      0,
      8
    );
  }

  /*
    1h momentum
  */
  if (data.price_change_1h > 0) {
    score += clamp(
      data.price_change_1h * 0.45,
      0,
      7
    );
  }

  /*
    6h momentum
  */
  if (data.price_change_6h > 0) {
    score += clamp(
      data.price_change_6h * 0.15,
      0,
      5
    );
  }

  return clamp(score, 0, 20);
}

function calculateVolumeScore(data) {
  let score = 0;

  if (data.volume_24h_usd >= 1000000) {
    score += 8;
  } else if (data.volume_24h_usd >= 250000) {
    score += 6;
  } else if (data.volume_24h_usd >= 100000) {
    score += 5;
  } else if (data.volume_24h_usd >= 50000) {
    score += 3;
  } else if (data.volume_24h_usd >= 10000) {
    score += 1;
  }

  if (data.volume_1h_usd >= 50000) {
    score += 7;
  } else if (data.volume_1h_usd >= 10000) {
    score += 5;
  } else if (data.volume_1h_usd >= 5000) {
    score += 3;
  } else if (data.volume_1h_usd >= 1000) {
    score += 1;
  }

  return clamp(score, 0, 20);
}

function calculateLiquidityScore(data) {
  const liquidity =
    data.liquidity_usd;

  if (liquidity >= 1000000) return 20;
  if (liquidity >= 500000) return 18;
  if (liquidity >= 250000) return 16;
  if (liquidity >= 100000) return 13;
  if (liquidity >= 50000) return 10;
  if (liquidity >= 25000) return 6;
  if (liquidity >= MIN_LIQUIDITY_USD) return 3;

  return 0;
}

function calculateBuyPressureScore(data) {
  const pressure =
    calculateBuyPressure(data);

  if (pressure >= 0.70) return 15;
  if (pressure >= 0.62) return 12;
  if (pressure >= 0.56) return 9;
  if (pressure >= 0.52) return 6;
  if (pressure >= 0.50) return 3;

  return 0;
}

function calculateAccelerationScore(data) {
  /*
    We want short-term movement to be stronger than
    the longer trend, but we don't want runaway values.
  */

  const shortTerm =
    safeNumber(data.price_change_5m);

  const hourly =
    safeNumber(data.price_change_1h);

  let score = 0;

  if (
    shortTerm > 0 &&
    hourly > 0
  ) {
    score += 5;
  }

  if (
    shortTerm > 0 &&
    shortTerm >= hourly / 6
  ) {
    score += 3;
  }

  if (
    data.volume_5m_usd >
    data.volume_1h_usd / 12
  ) {
    score += 2;
  }

  return clamp(score, 0, 10);
}

function calculateCrossSourceScore(
  dexData,
  jupiterData,
  geckoFound
) {
  let score = 0;

  if (jupiterData) {
    score += 5;
  }

  if (geckoFound) {
    score += 5;
  }

  return clamp(score, 0, 10);
}

function assessRisk(data) {
  const reasons = [];

  if (
    data.liquidity_usd <
    MIN_LIQUIDITY_USD
  ) {
    reasons.push("LOW_LIQUIDITY");
  }

  if (
    data.volume_24h_usd <
    MIN_VOLUME_24H_USD
  ) {
    reasons.push("LOW_24H_VOLUME");
  }

  if (
    data.volume_1h_usd <
    MIN_VOLUME_1H_USD
  ) {
    reasons.push("LOW_1H_VOLUME");
  }

  if (
    data.pair_age_days >
    MAX_PAIR_AGE_DAYS
  ) {
    reasons.push("OLD_PAIR");
  }

  if (
    data.price_usd <
    MIN_TOKEN_PRICE_USD
  ) {
    reasons.push("INVALID_PRICE");
  }

  /*
    If 1h sells greatly overwhelm buys,
    don't buy into the decline.
  */
  if (
    data.sells_1h > 0 &&
    data.buys_1h <
    data.sells_1h * 0.70
  ) {
    reasons.push("SELL_PRESSURE");
  }

  /*
    A strongly negative short-term trend is rejected.
  */
  if (
    data.price_change_5m < -2 &&
    data.price_change_1h < 0
  ) {
    reasons.push("NEGATIVE_MOMENTUM");
  }

  return {
    pass: reasons.length === 0,
    reasons
  };
}

function scoreCandidate(
  data,
  jupiterData,
  geckoFound
) {
  const momentum =
    calculateMomentumScore(data);

  const volume =
    calculateVolumeScore(data);

  const liquidity =
    calculateLiquidityScore(data);

  const buyPressure =
    calculateBuyPressureScore(data);

  const acceleration =
    calculateAccelerationScore(data);

  const crossSource =
    calculateCrossSourceScore(
      data,
      jupiterData,
      geckoFound
    );

  const total = Math.round(
    momentum +
    volume +
    liquidity +
    buyPressure +
    acceleration +
    crossSource
  );

  return {
    total,
    momentum,
    volume,
    liquidity,
    buy_pressure: buyPressure,
    acceleration,
    cross_source: crossSource
  };
}

/*
  ============================================================
  CANDIDATE SCANNER
  ============================================================
*/

async function scanCandidates(env) {
  const scanStarted =
    Date.now();

  /*
    SOURCE 1:
    DEX Screener discovery.
  */
  const dexDiscovery =
    await getDexScreenerDiscovery();

  /*
    SOURCE 2:
    DEX Screener search.
  */
  const dexSearch =
    await getDexSearchCandidates();

  /*
    Combine discovery addresses.
  */
  const discoveryMap =
    new Map();

  for (
    const item of [
      ...dexDiscovery,
      ...dexSearch
    ]
  ) {
    if (!isValidMint(item.mint)) {
      continue;
    }

    if (!discoveryMap.has(item.mint)) {
      discoveryMap.set(
        item.mint,
        item
      );
    }
  }

  /*
    SOURCE 3:
    GeckoTerminal trending pools.
  */
  const geckoPools =
    await getGeckoTrendingPools();

  for (const pool of geckoPools) {
    const mint =
      extractGeckoMint(
        pool.address
      );

    if (!isValidMint(mint)) {
      continue;
    }

    if (!discoveryMap.has(mint)) {
      discoveryMap.set(
        mint,
        {
          mint,
          source: "GECKOTERMINAL"
        }
      );
    }
  }

  /*
    Hydrate candidates with DEX Screener market data.
  */
  const dexPairs =
    await hydrateDexCandidates(
      [...discoveryMap.values()]
    );

  /*
    Get unique token addresses from
    actual DEX market data.
  */
  const mints = [
    ...new Set(
      dexPairs
        .map(pair =>
          normalizeAddress(
            pair.baseToken?.address
          )
        )
        .filter(isValidMint)
    )
  ];

  /*
    Jupiter is now a CROSS-CHECK.
    It does not generate the candidates.
  */
  const jupiterPrices =
    await getJupiterCrossCheck(
      env,
      mints.slice(0, 20)
    );

  /*
    Gecko confirmation set.
  */
  const geckoMints =
    new Set(
      geckoPools
        .map(pool =>
          extractGeckoMint(
            pool.address
          )
        )
        .filter(isValidMint)
    );

  const candidates = [];

  for (const pair of dexPairs) {
    const data =
      normalizeDexPair(pair);

    if (!isValidMint(data.mint)) {
      continue;
    }

    if (
      isBlockedSymbol(data.symbol)
    ) {
      continue;
    }

    if (
      data.price_usd <=
      MIN_TOKEN_PRICE_USD
    ) {
      continue;
    }

    const risk =
      assessRisk(data);

    const jupiterData =
      jupiterPrices[data.mint] ||
      null;

    const geckoFound =
      geckoMints.has(data.mint);

    const score =
      scoreCandidate(
        data,
        jupiterData,
        geckoFound
      );

    candidates.push({
      ...data,

      score,

      risk,

      sources: {
        dexscreener: true,
        jupiter: Boolean(
          jupiterData
        ),
        geckoterminal: geckoFound
      },

      decision:
        risk.pass
          ? "ELIGIBLE"
          : "REJECTED"
    });
  }

  /*
    Highest scoring first.
  */
  candidates.sort(
    (a, b) =>
      b.score.total -
      a.score.total
  );

  const result = {
    scanned_at: nowIso(),

    duration_ms:
      Date.now() - scanStarted,

    source_counts: {
      dexscreener_discovery:
        dexDiscovery.length,

      dexscreener_search:
        dexSearch.length,

      gecko_trending:
        geckoPools.length,

      hydrated_pairs:
        dexPairs.length
    },

    total_candidates:
      candidates.length,

    eligible_candidates:
      candidates.filter(
        x => x.risk.pass
      ).length,

    candidates:
      candidates
        .slice(0, MAX_CANDIDATES)
  };

  await env.BOT_KV.put(
    SCAN_KEY,
    JSON.stringify(result)
  );

  return result;
}

/*
  ============================================================
  POSITION PRICING
  ============================================================
*/

async function getTokenPriceFromDex(
  mint
) {
  try {
    const url =
      `${DEXSCREENER_API}/tokens/v1/solana/${mint}`;

    const pairs =
      await getJson(url);

    if (
      !Array.isArray(pairs) ||
      !pairs.length
    ) {
      return null;
    }

    const pair =
      getBestDexPair(
        pairs,
        mint
      );

    if (!pair) {
      return null;
    }

    const price =
      safeNumber(
        pair.priceUsd
      );

    return price > 0
      ? price
      : null;
  } catch {
    return null;
  }
}

/*
  ============================================================
  OPEN PAPER POSITION
  ============================================================
*/

async function openPaperPosition(
  env,
  portfolio,
  candidate
) {
  if (!PAPER_MODE) {
    throw new Error(
      "Safety error: PAPER_MODE must remain true."
    );
  }

  if (
    portfolio.open_positions.length >=
    MAX_POSITIONS
  ) {
    return {
      opened: false,
      reason: "MAX_POSITIONS"
    };
  }

  const availableCash =
    portfolio.cash_usd -
    PAPER_MIN_CASH_RESERVE_USD;

  if (availableCash <= 0) {
    return {
      opened: false,
      reason: "CASH_RESERVE"
    };
  }

  const tradeSize =
    portfolio.cash_usd >=
    BALANCE_THRESHOLD_USD
      ? LARGE_TRADE_CAP_USD
      : SMALL_TRADE_CAP_USD;

  const cost =
    Math.min(
      tradeSize,
      availableCash
    );

  if (cost <= 0) {
    return {
      opened: false,
      reason: "INSUFFICIENT_CASH"
    };
  }

  const price =
    safeNumber(
      candidate.price_usd
    );

  if (price <= 0) {
    return {
      opened: false,
      reason: "INVALID_PRICE"
    };
  }

  const quantity =
    cost / price;

  const position = {
    id:
      `${Date.now()}-` +
      Math.random()
        .toString(36)
        .slice(2, 10),

    symbol:
      candidate.symbol,

    name:
      candidate.name,

    mint:
      candidate.mint,

    entry_price_usd:
      price,

    current_price_usd:
      price,

    highest_price_usd:
      price,

    quantity,

    cost_usd:
      cost,

    current_value_usd:
      cost,

    unrealized_pnl_usd:
      0,

    profit_percent:
      0,

    highest_profit_percent:
      0,

    trailing_active:
      false,

    reversal_confirmations:
      0,

    execution:
      "PAPER",

    transaction:
      "NONE — simulated trade",

    opened_at:
      nowIso(),

    last_checked_at:
      nowIso(),

    entry_score:
      candidate.score,

    entry_sources:
      candidate.sources,

    entry_risk:
      candidate.risk
  };

  portfolio.cash_usd -=
    cost;

  portfolio.open_positions.push(
    position
  );

  await setCooldown(
    env,
    candidate.mint
  );

  await addHistory(
    env,
    {
      type: "PAPER_BUY",

      symbol:
        candidate.symbol,

      mint:
        candidate.mint,

      price_usd:
        price,

      amount_usd:
        cost,

      score:
        candidate.score,

      sources:
        candidate.sources,

      risk:
        candidate.risk,

      transaction:
        "SIMULATED — NO BLOCKCHAIN TRANSACTION"
    }
  );

  return {
    opened: true,
    position
  };
}

/*
  ============================================================
  POSITION MONITORING / EXIT
  ============================================================
*/

async function updatePosition(
  env,
  portfolio,
  position
) {
  const price =
    await getTokenPriceFromDex(
      position.mint
    );

  if (!price) {
    return {
      action: "HOLD",
      reason: "NO_PRICE"
    };
  }

  position.current_price_usd =
    price;

  position.last_checked_at =
    nowIso();

  if (
    price >
    position.highest_price_usd
  ) {
    position.highest_price_usd =
      price;
  }

  const profit =
    (
      price -
      position.entry_price_usd
    ) /
    position.entry_price_usd;

  const highestProfit =
    (
      position.highest_price_usd -
      position.entry_price_usd
    ) /
    position.entry_price_usd;

  const value =
    position.quantity *
    price;

  const pnl =
    value -
    position.cost_usd;

  position.current_value_usd =
    value;

  position.unrealized_pnl_usd =
    pnl;

  position.profit_percent =
    profit * 100;

  position.highest_profit_percent =
    highestProfit * 100;

  /*
    HARD STOP
  */
  if (
    profit <= STOP_LOSS
  ) {
    return {
      action: "SELL",
      reason: "HARD_STOP",
      price,
      profit
    };
  }

  /*
    Activate trailing only after
    reaching +1%.
  */
  if (
    highestProfit >=
    TRAILING_ACTIVATION
  ) {
    position.trailing_active =
      true;
  }

  /*
    Once trailing is active, require
    two consecutive observations below
    the trailing floor.
  */
  if (
    position.trailing_active
  ) {
    const trailingFloor =
      position.highest_price_usd *
      (1 - TRAILING_STOP);

    if (
      price <= trailingFloor
    ) {
      position.reversal_confirmations +=
        1;
    } else {
      position.reversal_confirmations =
        0;
    }

    if (
      position.reversal_confirmations >=
      REVERSAL_CONFIRMATIONS_REQUIRED
    ) {
      return {
        action: "SELL",
        reason: "TRAILING_EXIT",
        price,
        profit,
        trailing_floor:
          trailingFloor
      };
    }
  }

  return {
    action: "HOLD",
    reason: "NO_EXIT_SIGNAL",
    price,
    profit
  };
}

async function closePaperPosition(
  env,
  portfolio,
  position,
  reason,
  price
) {
  const finalPrice =
    safeNumber(
      price,
      position.current_price_usd
    );

  const proceeds =
    position.quantity *
    finalPrice;

  const pnl =
    proceeds -
    position.cost_usd;

  portfolio.cash_usd +=
    proceeds;

  portfolio.realized_pnl_usd +=
    pnl;

  portfolio.open_positions =
    portfolio.open_positions.filter(
      item =>
        item.id !== position.id
    );

  await addHistory(
    env,
    {
      type: "PAPER_SELL",

      symbol:
        position.symbol,

      mint:
        position.mint,

      entry_price_usd:
        position.entry_price_usd,

      exit_price_usd:
        finalPrice,

      amount_usd:
        proceeds,

      pnl_usd:
        pnl,

      return_percent:
        position.cost_usd > 0
          ? (pnl /
              position.cost_usd) *
            100
          : 0,

      reason,

      transaction:
        "SIMULATED — NO BLOCKCHAIN TRANSACTION"
    }
  );
}

/*
  ============================================================
  PORTFOLIO MARK-TO-MARKET
  ============================================================
*/

async function refreshPortfolioValues(
  env,
  portfolio
) {
  let marketValue = 0;
  let unrealized = 0;

  for (
    const position of
    portfolio.open_positions
  ) {
    marketValue +=
      safeNumber(
        position.current_value_usd
      );

    unrealized +=
      safeNumber(
        position.unrealized_pnl_usd
      );
  }

  portfolio.unrealized_pnl_usd =
    unrealized;

  portfolio.total_pnl_usd =
    portfolio.realized_pnl_usd +
    unrealized;

  const totalValue =
    portfolio.cash_usd +
    marketValue;

  portfolio.return_percent =
    (
      (
        totalValue -
        portfolio.starting_cash_usd
      ) /
      portfolio.starting_cash_usd
    ) * 100;

  return {
    market_value_usd:
      marketValue,

    total_value_usd:
      totalValue
  };
}

/*
  ============================================================
  MAIN BOT
  ============================================================
*/

async function runBot(
  env,
  reason = "manual"
) {
  if (!PAPER_MODE) {
    throw new Error(
      "SAFETY STOP: This version is PAPER ONLY."
    );
  }

  const portfolio =
    await getPortfolio(env);

  const actions = [];

  /*
    STEP 1:
    Monitor existing positions.
  */
  for (
    const position of [
      ...portfolio.open_positions
    ]
  ) {
    const result =
      await updatePosition(
        env,
        portfolio,
        position
      );

    actions.push({
      type: "POSITION",
      symbol:
        position.symbol,
      action:
        result.action,
      reason:
        result.reason,
      price:
        result.price ||
        position.current_price_usd
    });

    if (
      result.action === "SELL"
    ) {
      await closePaperPosition(
        env,
        portfolio,
        position,
        result.reason,
        result.price
      );
    }
  }

  /*
    STEP 2:
    Scan the market.
  */
  const scan =
    await scanCandidates(env);

  /*
    STEP 3:
    Find the highest-scoring eligible
    candidate.
  */
  const eligible =
    scan.candidates.filter(
      candidate =>
        candidate.risk.pass
    );

  /*
    Never buy a token already held.
  */
  const heldMints =
    new Set(
      portfolio.open_positions.map(
        position =>
          position.mint
      )
    );

  const buyCandidates =
    eligible.filter(
      candidate =>
        !heldMints.has(
          candidate.mint
        )
    );

  /*
    Respect maximum new buys.
  */
  let buysThisRun = 0;

  for (
    const candidate of
    buyCandidates
  ) {
    if (
      buysThisRun >=
      MAX_NEW_BUYS_PER_RUN
    ) {
      break;
    }

    if (
      await isCoolingDown(
        env,
        candidate.mint
      )
    ) {
      continue;
    }

    /*
      Require a meaningful score.
    */
    if (
      candidate.score.total < 45
    ) {
      continue;
    }

    const result =
      await openPaperPosition(
        env,
        portfolio,
        candidate
      );

    actions.push({
      type: "CANDIDATE",
      symbol:
        candidate.symbol,
      mint:
        candidate.mint,
      score:
        candidate.score,
      sources:
        candidate.sources,
      risk:
        candidate.risk,
      action:
        result.opened
          ? "PAPER_BUY"
          : "SKIP",
      reason:
        result.reason ||
        null
    });

    if (result.opened) {
      buysThisRun += 1;
    }
  }

  /*
    STEP 4:
    Recalculate portfolio.
  */
  const value =
    await refreshPortfolioValues(
      env,
      portfolio
    );

  portfolio.last_run_at =
    nowIso();

  await savePortfolio(
    env,
    portfolio
  );

  return {
    ok: true,

    bot: BOT_NAME,

    mode: {
      type: "PAPER",
      real_money: false,
      live_trading: false,
      transaction_execution: false,
      wallet_signing: false,
      private_key_required: false
    },

    trigger: reason,

    scan: {
      candidates:
        scan.total_candidates,

      eligible:
        scan.eligible_candidates,

      sources:
        scan.source_counts,

      top_candidates:
        scan.candidates
          .slice(0, 5)
          .map(candidate => ({
            symbol:
              candidate.symbol,

            mint:
              candidate.mint,

            score:
              candidate.score.total,

            score_breakdown:
              candidate.score,

            liquidity_usd:
              candidate.liquidity_usd,

            volume_24h_usd:
              candidate.volume_24h_usd,

            volume_1h_usd:
              candidate.volume_1h_usd,

            price_change_5m:
              candidate.price_change_5m,

            price_change_1h:
              candidate.price_change_1h,

            buys_1h:
              candidate.buys_1h,

            sells_1h:
              candidate.sells_1h,

            sources:
              candidate.sources,

            risk:
              candidate.risk
          }))
    },

    actions,

    portfolio: {
      cash_usd:
        portfolio.cash_usd,

      market_value_usd:
        value.market_value_usd,

      total_value_usd:
        value.total_value_usd,

      open_positions:
        portfolio.open_positions.length,

      realized_pnl_usd:
        portfolio.realized_pnl_usd,

      unrealized_pnl_usd:
        portfolio.unrealized_pnl_usd,

      total_pnl_usd:
        portfolio.total_pnl_usd,

      return_percent:
        portfolio.return_percent
    }
  };
}

/*
  ============================================================
  HTTP ROUTES
  ============================================================
*/

async function handleRequest(
  request,
  env
) {
  const url =
    new URL(request.url);

  const path =
    url.pathname;

  /*
    HOME
  */
  if (path === "/") {
    return json({
      ok: true,

      bot: BOT_NAME,

      message:
        "memebott multi-source PAPER trading bot",

      mode: {
        type: "PAPER",
        real_money: false,
        live_trading: false,
        wallet_signing: false
      },

      routes: [
        "/status",
        "/test",
        "/run",
        "/trades",
        "/scan",
        "/reset-paper?confirm=RESET"
      ]
    });
  }

  /*
    STATUS
  */
  if (path === "/status") {
    const portfolio =
      await getPortfolio(env);

    const value =
      await refreshPortfolioValues(
        env,
        portfolio
      );

    await savePortfolio(
      env,
      portfolio
    );

    return json({
      ok: true,

      bot: BOT_NAME,

      mode: {
        type: "PAPER",
        real_money: false,
        live_trading: false,
        transaction_execution: false,
        wallet_signing: false,
        private_key_required: false
      },

      portfolio: {
        starting_cash_usd:
          portfolio.starting_cash_usd,

        cash_usd:
          portfolio.cash_usd,

        market_value_usd:
          value.market_value_usd,

        total_value_usd:
          value.total_value_usd,

        open_positions:
          portfolio.open_positions.length,

        maximum_positions:
          MAX_POSITIONS,

        realized_pnl_usd:
          portfolio.realized_pnl_usd,

        unrealized_pnl_usd:
          portfolio.unrealized_pnl_usd,

        total_pnl_usd:
          portfolio.total_pnl_usd,

        return_percent:
          portfolio.return_percent
      },

      settings: {
        small_trade_cap_usd:
          SMALL_TRADE_CAP_USD,

        large_trade_cap_usd:
          LARGE_TRADE_CAP_USD,

        balance_threshold_usd:
          BALANCE_THRESHOLD_USD,

        minimum_cash_reserve_usd:
          PAPER_MIN_CASH_RESERVE_USD,

        hard_stop_percent:
          STOP_LOSS * 100,

        trailing_activation_percent:
          TRAILING_ACTIVATION * 100,

        trailing_stop_percent:
          TRAILING_STOP * 100,

        reversal_confirmations:
          REVERSAL_CONFIRMATIONS_REQUIRED,

        minimum_liquidity_usd:
          MIN_LIQUIDITY_USD,

        minimum_24h_volume_usd:
          MIN_VOLUME_24H_USD,

        minimum_1h_volume_usd:
          MIN_VOLUME_1H_USD
      },

      positions:
        portfolio.open_positions
    });
  }

  /*
    SCAN ONLY
  */
  if (path === "/scan") {
    const scan =
      await scanCandidates(env);

    return json({
      ok: true,

      bot: BOT_NAME,

      mode:
        "PAPER",

      scan
    });
  }

  /*
    TEST:
    Scanner only.
    Does NOT open a position.
  */
  if (path === "/test") {
    const scan =
      await scanCandidates(env);

    return json({
      ok: true,

      bot: BOT_NAME,

      mode: {
        type: "PAPER",
        transaction_execution: false
      },

      message:
        "Scanner test completed. No position was opened.",

      scan: {
        total_candidates:
          scan.total_candidates,

        eligible_candidates:
          scan.eligible_candidates,

        source_counts:
          scan.source_counts,

        top_candidates:
          scan.candidates
            .slice(0, 10)
            .map(candidate => ({
              symbol:
                candidate.symbol,

              name:
                candidate.name,

              mint:
                candidate.mint,

              score:
                candidate.score.total,

              score_breakdown:
                candidate.score,

              liquidity_usd:
                candidate.liquidity_usd,

              volume_24h_usd:
                candidate.volume_24h_usd,

              volume_1h_usd:
                candidate.volume_1h_usd,

              price_change_5m:
                candidate.price_change_5m,

              price_change_1h:
                candidate.price_change_1h,

              buys_1h:
                candidate.buys_1h,

              sells_1h:
                candidate.sells_1h,

              sources:
                candidate.sources,

              risk:
                candidate.risk
            }))
      }
    });
  }

  /*
    RUN
  */
  if (path === "/run") {
    const result =
      await runBot(
        env,
        "manual"
      );

    return json(result);
  }

  /*
    TRADES
  */
  if (path === "/trades") {
    const history =
      await getHistory(env);

    return json({
      ok: true,

      bot: BOT_NAME,

      mode:
        "PAPER",

      count:
        history.length,

      trades:
        history
    });
  }

  /*
    RESET PAPER ACCOUNT
  */
  if (
    path === "/reset-paper"
  ) {
    const confirm =
      url.searchParams.get(
        "confirm"
      );

    if (confirm !== "RESET") {
      return json({
        ok: false,

        error:
          "Reset blocked. Use /reset-paper?confirm=RESET"
      }, 400);
    }

    const portfolio =
      createFreshPortfolio();

    await savePortfolio(
      env,
      portfolio
    );

    await env.BOT_KV.delete(
      HISTORY_KEY
    );

    await env.BOT_KV.delete(
      COOLDOWN_KEY
    );

    await env.BOT_KV.delete(
      SCAN_KEY
    );

    return json({
      ok: true,

      message:
        "Paper account reset.",

      starting_cash_usd:
        PAPER_STARTING_CASH_USD
    });
  }

  return json({
    ok: false,
    error: "Not found"
  }, 404);
}

/*
  ============================================================
  JSON RESPONSE
  ============================================================
*/

function json(data, status = 200) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );
}

/*
  ============================================================
  CLOUDFLARE WORKER
  ============================================================
*/

export default {
  async fetch(
    request,
    env
  ) {
    try {
      return await handleRequest(
        request,
        env
      );
    } catch (error) {
      return json({
        ok: false,

        bot: BOT_NAME,

        error:
          error?.message ||
          String(error),

        mode:
          "PAPER",

        safety:
          "No live transaction execution is implemented."
      }, 500);
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      runBot(
        env,
        "cron"
      ).catch(
        async error => {
          await addHistory(
            env,
            {
              type:
                "ERROR",

              error:
                error?.message ||
                String(error)
            }
          );
        }
      )
    );
  }
};
