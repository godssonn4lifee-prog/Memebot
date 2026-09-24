const BOT_NAME = "memebott";

/*
  ============================================================
  MEMEBOTT — PAPER TRADING ONLY
  ============================================================

  IMPORTANT:
  - No private key
  - No wallet signing
  - No real transactions
  - No real-money trading
  - All buys/sells are simulated
*/

const PAPER_MODE = true;
const PAPER_SCHEMA_VERSION = 3;

/* ============================================================
   BASIC SETTINGS
   ============================================================ */

const STARTING_CASH_USD = 100;

const MIN_CASH_RESERVE_USD = 10;

const MAX_POSITIONS = 7;

const MAX_NEW_BUYS_PER_RUN = 1;

const MAX_PAPER_POSITION_USD = 40;

const COOLDOWN_SECONDS = 60;

/* Progressive paper position sizing */
const POSITION_SIZE_TIERS = [
  { equity: 0, amount: 5 },
  { equity: 150, amount: 7 },
  { equity: 250, amount: 10 },
  { equity: 500, amount: 15 },
  { equity: 1000, amount: 25 },
  { equity: 2000, amount: 40 }
];

/* ============================================================
   EXIT PROTECTION
   ============================================================ */

const STOP_LOSS = -0.01;

const TRAILING_ACTIVATION = 0.01;

const TRAILING_STOP = 0.03;

const REVERSAL_CONFIRMATIONS_REQUIRED = 2;

const PROFIT_REVERSAL_SELL_RATIO = 1.20;

/* ============================================================
   ENTRY SETTINGS
   ============================================================ */

/*
  Controlled adjustment:
  - Overall score: 45
  - Momentum requirement: 5

  Safety filters remain active.
*/
const MIN_ENTRY_SCORE = 45;

const MIN_MOMENTUM_SCORE = 5;

/* ============================================================
   MARKET FILTERS
   ============================================================ */

const MIN_TOKEN_PRICE = 0.00000001;

const MIN_LIQUIDITY_USD = 15000;

const MIN_VOLUME_24H_USD = 10000;

const MIN_VOLUME_1H_USD = 1000;

/* ============================================================
   CHASE PROTECTION
   ============================================================ */

const MAX_5M_GAIN = 0.15;

const MAX_1H_GAIN = 0.45;

const MAX_6H_GAIN = 1.00;

const MAX_24H_GAIN = 5.00;

/* ============================================================
   NEW TOKEN PROTECTION
   ============================================================ */

const NEW_TOKEN_MAX_AGE_DAYS = 1;

const NEW_TOKEN_MIN_LIQUIDITY_USD = 25000;

/* ============================================================
   MARKET SHAPE
   ============================================================ */

const EXTREME_1H_MOVE = 0.50;

const STRONG_NEGATIVE_6H = -0.15;

const STRONG_NEGATIVE_5M = -0.03;

const BOUNCE_5M = 0.07;

const SHORT_TERM_SELL_RATIO = 1.50;

const HOURLY_SELL_RATIO = 1.43;

/* ============================================================
   SCANNER LIMITS
   ============================================================ */

const MAX_CANDIDATES = 30;

const MAX_DEX_TOKENS_ANALYZED = 40;

const MAX_GECKO_POOLS_ANALYZED = 20;

const MAX_JUPITER_PRICE_CHECKS = 20;

/* ============================================================
   API SETTINGS
   ============================================================ */

const DEX_BASE = "https://api.dexscreener.com";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

const JUPITER_PRICE_API =
  "https://api.jup.ag/price/v3";

/* ============================================================
   UTILITY FUNCTIONS
   ============================================================ */

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
  return safeNumber(value) * 100;
}

function round(value, decimals = 4) {
  const p = 10 ** decimals;
  return Math.round(safeNumber(value) * p) / p;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorText(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

/* ============================================================
   FETCH HELPERS
   ============================================================ */

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} from ${url}`
    );
  }

  return await response.json();
}

/* ============================================================
   PAPER PORTFOLIO
   ============================================================ */

function createEmptyPortfolio() {
  return {
    schema_version: PAPER_SCHEMA_VERSION,
    starting_cash_usd: STARTING_CASH_USD,
    cash_usd: STARTING_CASH_USD,
    realized_pnl_usd: 0,
    positions: [],
    history: [],
    cooldowns: {},
    last_scan: null,
    created_at: nowIso(),
    updated_at: nowIso()
  };
}

async function loadPortfolio(env) {
  const raw = await env.BOT_KV.get("PAPER_PORTFOLIO");

  if (!raw) {
    return createEmptyPortfolio();
  }

  try {
    const portfolio = JSON.parse(raw);

    /*
      Schema mismatch intentionally starts a clean paper
      portfolio so stale state from an older bot version
      cannot contaminate the new engine.
    */
    if (
      safeNumber(portfolio.schema_version) !==
      PAPER_SCHEMA_VERSION
    ) {
      return createEmptyPortfolio();
    }

    portfolio.positions ||= [];
    portfolio.history ||= [];
    portfolio.cooldowns ||= {};
    portfolio.cash_usd = safeNumber(
      portfolio.cash_usd,
      STARTING_CASH_USD
    );
    portfolio.realized_pnl_usd = safeNumber(
      portfolio.realized_pnl_usd
    );

    return portfolio;
  } catch {
    return createEmptyPortfolio();
  }
}

async function savePortfolio(env, portfolio) {
  portfolio.updated_at = nowIso();

  await env.BOT_KV.put(
    "PAPER_PORTFOLIO",
    JSON.stringify(portfolio)
  );
}

/* ============================================================
   HISTORY
   ============================================================ */

function addHistory(portfolio, event) {
  portfolio.history.push({
    time: nowIso(),
    ...event
  });

  if (portfolio.history.length > 500) {
    portfolio.history =
      portfolio.history.slice(-500);
  }
}

/* ============================================================
   POSITION SIZE
   ============================================================ */

function getPositionSize(equity) {
  let amount = POSITION_SIZE_TIERS[0].amount;

  for (const tier of POSITION_SIZE_TIERS) {
    if (equity >= tier.equity) {
      amount = tier.amount;
    }
  }

  return Math.min(
    amount,
    MAX_PAPER_POSITION_USD
  );
}

/* ============================================================
   DEXSCREENER DISCOVERY
   ============================================================ */

async function getDexDiscovery() {
  const urls = [
    `${DEX_BASE}/token-profiles/latest/v1`,
    `${DEX_BASE}/token-boosts/latest/v1`
  ];

  const results = [];

  for (const url of urls) {
    try {
      const data = await fetchJson(url);

      if (Array.isArray(data)) {
        for (const item of data) {
          const chainId =
            String(item.chainId || "").toLowerCase();

          if (chainId !== "solana") continue;

          const mint =
            item.tokenAddress ||
            item.address;

          if (!mint) continue;

          results.push({
            mint,
            source: "DEXSCREENER"
          });
        }
      }
    } catch {
      /* Continue with other sources */
    }
  }

  return results.slice(
    0,
    MAX_DEX_TOKENS_ANALYZED
  );
}

/* ============================================================
   DEXSCREENER SEARCH
   ============================================================ */

async function getDexSearch() {
  const queries = [
    "SOL",
    "meme",
    "pump"
  ];

  const results = [];

  for (const query of queries) {
    try {
      const data = await fetchJson(
        `${DEX_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`
      );

      for (const pair of data.pairs || []) {
        if (
          String(pair.chainId || "").toLowerCase() !==
          "solana"
        ) {
          continue;
        }

        const mint =
          pair.baseToken?.address;

        if (!mint) continue;

        results.push({
          mint,
          source: "DEXSCREENER_SEARCH"
        });
      }
    } catch {
      /* Continue */
    }
  }

  return results.slice(
    0,
    MAX_DEX_TOKENS_ANALYZED
  );
}

/* ============================================================
   GECKOTERMINAL
   ============================================================ */

async function getGeckoCandidates() {
  const mints = new Set();

  try {
    const trending = await fetchJson(
      `${GECKO_BASE}/networks/solana/trending_pools?page=1`
    );

    for (
      const item of trending.data || []
    ) {
      const address =
        item.relationships?.base_token?.data?.id;

      if (!address) continue;

      /*
        Gecko token IDs commonly look like:
        solana_<mint>
      */
      const mint = String(address)
        .replace(/^solana_/, "");

      if (mint) {
        mints.add(mint);
      }
    }
  } catch {
    /* Gecko is supplemental */
  }

  return [...mints].slice(
    0,
    MAX_GECKO_POOLS_ANALYZED
  );
}

/* ============================================================
   BEST DEX PAIR
   ============================================================ */

async function getBestDexPair(mint) {
  try {
    const data = await fetchJson(
      `${DEX_BASE}/latest/dex/tokens/${encodeURIComponent(mint)}`
    );

    const pairs = (data.pairs || [])
      .filter(
        pair =>
          String(pair.chainId || "").toLowerCase() ===
          "solana"
      )
      .sort(
        (a, b) =>
          safeNumber(b.liquidity?.usd) -
          safeNumber(a.liquidity?.usd)
      );

    return pairs[0] || null;
  } catch {
    return null;
  }
}

/* ============================================================
   NORMALIZE DEX DATA
   ============================================================ */

function normalizeDexPair(pair, mint) {
  if (!pair) return null;

  const price =
    safeNumber(pair.priceUsd);

  const liquidity =
    safeNumber(pair.liquidity?.usd);

  const volume24h =
    safeNumber(pair.volume?.h24);

  const volume1h =
    safeNumber(pair.volume?.h1);

  const tx5m =
    pair.txns?.m5 || {};

  const tx1h =
    pair.txns?.h1 || {};

  const buys5m =
    safeNumber(tx5m.buys);

  const sells5m =
    safeNumber(tx5m.sells);

  const buys1h =
    safeNumber(tx1h.buys);

  const sells1h =
    safeNumber(tx1h.sells);

  const total5m =
    buys5m + sells5m;

  const total1h =
    buys1h + sells1h;

  const sellRatio5m =
    sells5m > 0
      ? buys5m / sells5m
      : buys5m > 0
        ? 99
        : 0;

  const buyPressure5m =
    total5m > 0
      ? buys5m / total5m
      : 0;

  const buyPressure1h =
    total1h > 0
      ? buys1h / total1h
      : 0;

  const createdAt =
    safeNumber(pair.pairCreatedAt);

  let ageDays = null;

  if (createdAt > 0) {
    ageDays =
      (Date.now() - createdAt) /
      86400000;
  }

  const priceChange =
    pair.priceChange || {};

  return {
    mint,

    symbol:
      pair.baseToken?.symbol ||
      "UNKNOWN",

    name:
      pair.baseToken?.name ||
      pair.baseToken?.symbol ||
      "UNKNOWN",

    price,

    liquidity_usd: liquidity,

    volume_24h_usd: volume24h,

    volume_1h_usd: volume1h,

    change_5m: safeNumber(
      priceChange.m5
    ) / 100,

    change_1h: safeNumber(
      priceChange.h1
    ) / 100,

    change_6h: safeNumber(
      priceChange.h6
    ) / 100,

    change_24h: safeNumber(
      priceChange.h24
    ) / 100,

    buys_5m: buys5m,

    sells_5m: sells5m,

    buys_1h: buys1h,

    sells_1h: sells1h,

    buy_pressure_5m:
      buyPressure5m,

    buy_pressure_1h:
      buyPressure1h,

    sell_ratio_5m:
      sellRatio5m,

    age_days:
      ageDays,

    pair_address:
      pair.pairAddress || null,

    dex_id:
      pair.dexId || null,

    url:
      pair.url || null
  };
}

/* ============================================================
   JUPITER SUPPLEMENTAL PRICE CHECK
   ============================================================ */

async function getJupiterPrices(mints, env) {
  const result = new Map();

  if (!mints.length) {
    return result;
  }

  const batch = mints.slice(
    0,
    MAX_JUPITER_PRICE_CHECKS
  );

  try {
    const url =
      `${JUPITER_PRICE_API}?ids=${batch.join(",")}`;

    const headers = {};

    if (env.JUPITER_API_KEY) {
      headers["x-api-key"] =
        env.JUPITER_API_KEY;
    }

    const data = await fetchJson(url, {
      headers
    });

    for (const mint of batch) {
      const item =
        data?.data?.[mint];

      if (!item) continue;

      const price =
        safeNumber(item.usdPrice);

      if (price > 0) {
        result.set(mint, price);
      }
    }
  } catch {
    /*
      Jupiter is supplemental. A failure here must not
      disable the entire scanner.
    */
  }

  return result;
}

/* ============================================================
   SOURCE CROSS-CHECK
   ============================================================ */

function addJupiterConfirmation(
  candidate,
  jupiterPrice
) {
  if (
    !jupiterPrice ||
    !candidate.price
  ) {
    return {
      confirmed: false,
      difference: null
    };
  }

  const difference =
    Math.abs(
      jupiterPrice -
      candidate.price
    ) /
    candidate.price;

  return {
    confirmed: difference <= 0.15,
    difference
  };
}

/* ============================================================
   MARKET SHAPE
   ============================================================ */

function analyzeMarketShape(candidate) {
  const reasons = [];

  let penalty = 0;

  if (
    candidate.change_1h >=
    EXTREME_1H_MOVE
  ) {
    penalty += 10;
    reasons.push("EXTREME_1H_MOVE");
  }

  if (
    candidate.change_1h >=
    EXTREME_1H_MOVE
  ) {
    penalty += 8;
    reasons.push(
      "EXTREME_1H_ACCELERATION"
    );
  }

  if (
    candidate.change_6h >= 1.00
  ) {
    penalty += 8;
    reasons.push(
      "EXTREME_6H_MOVE"
    );
  }

  if (
    candidate.change_5m >= 0.15
  ) {
    penalty += 8;
    reasons.push(
      "EXTREME_5M_MOVE"
    );
  }

  if (
    candidate.change_6h <=
    STRONG_NEGATIVE_6H
  ) {
    penalty += 10;
    reasons.push(
      "STRONG_NEGATIVE_6H"
    );
  }

  if (
    candidate.change_5m <=
    STRONG_NEGATIVE_5M
  ) {
    penalty += 8;
    reasons.push(
      "STRONG_NEGATIVE_5M"
    );
  }

  /*
    Bounce can offset some concern when the token has
    recently recovered from a short-term decline.
  */
  if (
    candidate.change_5m >= BOUNCE_5M &&
    candidate.change_1h < 0
  ) {
    penalty -= 4;
    reasons.push("BOUNCE_ATTEMPT");
  }

  return {
    penalty: Math.max(0, penalty),
    reasons
  };
}

/* ============================================================
   SCORE CANDIDATE
   ============================================================ */

function scoreCandidate(candidate) {
  let score = 0;

  const breakdown = {};

  /* Momentum: max 20 */
  let momentum = 0;

  if (candidate.change_5m > 0) {
    momentum += 5;
  }

  if (candidate.change_1h > 0) {
    momentum += 5;
  }

  if (candidate.change_6h > 0) {
    momentum += 5;
  }

  if (candidate.change_24h > 0) {
    momentum += 5;
  }

  /*
    Avoid rewarding extreme acceleration too heavily.
  */
  momentum = clamp(momentum, 0, 20);

  breakdown.momentum = momentum;

  /* Volume: max 17 */
  let volume = 0;

  if (
    candidate.volume_24h_usd >=
    10000
  ) {
    volume += 5;
  }

  if (
    candidate.volume_24h_usd >=
    25000
  ) {
    volume += 4;
  }

  if (
    candidate.volume_24h_usd >=
    100000
  ) {
    volume += 4;
  }

  if (
    candidate.volume_1h_usd >=
    1000
  ) {
    volume += 2;
  }

  if (
    candidate.volume_1h_usd >=
    5000
  ) {
    volume += 2;
  }

  volume = clamp(volume, 0, 17);

  breakdown.volume = volume;

  /* Liquidity: max 15 */
  let liquidity = 0;

  if (
    candidate.liquidity_usd >=
    15000
  ) {
    liquidity += 5;
  }

  if (
    candidate.liquidity_usd >=
    25000
  ) {
    liquidity += 4;
  }

  if (
    candidate.liquidity_usd >=
    50000
  ) {
    liquidity += 3;
  }

  if (
    candidate.liquidity_usd >=
    100000
  ) {
    liquidity += 3;
  }

  liquidity = clamp(
    liquidity,
    0,
    15
  );

  breakdown.liquidity =
    liquidity;

  /* Buy pressure: max 15 */
  let buyPressure = 0;

  if (
    candidate.buy_pressure_5m >=
    0.50
  ) {
    buyPressure += 5;
  }

  if (
    candidate.buy_pressure_5m >=
    0.60
  ) {
    buyPressure += 3;
  }

  if (
    candidate.buy_pressure_1h >=
    0.50
  ) {
    buyPressure += 4;
  }

  if (
    candidate.buy_pressure_1h >=
    0.60
  ) {
    buyPressure += 3;
  }

  buyPressure = clamp(
    buyPressure,
    0,
    15
  );

  breakdown.buy_pressure =
    buyPressure;

  /* Acceleration: max 9 */
  let acceleration = 0;

  if (
    candidate.change_5m > 0 &&
    candidate.change_1h > 0
  ) {
    acceleration += 3;
  }

  if (
    candidate.change_1h >
    candidate.change_6h
  ) {
    acceleration += 2;
  }

  if (
    candidate.change_5m >= 0.02 &&
    candidate.change_5m <= 0.10
  ) {
    acceleration += 2;
  }

  if (
    candidate.change_1h >= 0.03 &&
    candidate.change_1h <= 0.30
  ) {
    acceleration += 2;
  }

  acceleration = clamp(
    acceleration,
    0,
    9
  );

  breakdown.acceleration =
    acceleration;

  /* Cross-source confirmation: max 10 */
  let crossSource = 0;

  if (candidate.dex_confirmed) {
    crossSource += 5;
  }

  if (candidate.gecko_confirmed) {
    crossSource += 3;
  }

  if (candidate.jupiter_confirmed) {
    crossSource += 2;
  }

  crossSource = clamp(
    crossSource,
    0,
    10
  );

  breakdown.cross_source =
    crossSource;

  const shape =
    analyzeMarketShape(
      candidate
    );

  breakdown.market_shape_penalty =
    shape.penalty;

  score =
    momentum +
    volume +
    liquidity +
    buyPressure +
    acceleration +
    crossSource -
    shape.penalty;

  score = clamp(
    score,
    0,
    100
  );

  return {
    score: round(score, 2),
    momentum_score: round(
      momentum,
      2
    ),
    breakdown,
    market_shape_reasons:
      shape.reasons
  };
}

/* ============================================================
   ENTRY QUALITY
   ============================================================ */

function evaluateEntryQuality(
  candidate
) {
  const reasons = [];

  if (
    candidate.liquidity_usd <
    MIN_LIQUIDITY_USD
  ) {
    reasons.push(
      "LOW_LIQUIDITY"
    );
  }

  if (
    candidate.volume_1h_usd <
    MIN_VOLUME_1H_USD
  ) {
    reasons.push(
      "LOW_1H_VOLUME"
    );
  }

  if (
    candidate.momentum_score <
    MIN_MOMENTUM_SCORE
  ) {
    reasons.push(
      "WEAK_MOMENTUM"
    );
  }

  if (
    candidate.change_5m <=
    STRONG_NEGATIVE_5M
  ) {
    reasons.push(
      "SEVERE_5M_DECLINE"
    );
  }

  if (
    candidate.change_5m >
    MAX_5M_GAIN
  ) {
    reasons.push(
      "CHASE_PROTECTION_5M"
    );
  }

  if (
    candidate.change_1h >
    MAX_1H_GAIN
  ) {
    reasons.push(
      "CHASE_PROTECTION_1H"
    );
  }

  if (
    candidate.change_6h >
    MAX_6H_GAIN
  ) {
    reasons.push(
      "CHASE_PROTECTION_6H"
    );
  }

  if (
    candidate.change_24h >
    MAX_24H_GAIN
  ) {
    reasons.push(
      "CHASE_PROTECTION_24H"
    );
  }

  if (
    candidate.age_days !== null &&
    candidate.age_days <=
    NEW_TOKEN_MAX_AGE_DAYS
  ) {
    if (
      candidate.change_1h >= 0.25
    ) {
      reasons.push(
        "NEW_TOKEN_PARABOLIC_MOVE"
      );
    }
  }

  if (
    candidate.score <
    MIN_ENTRY_SCORE
  ) {
    reasons.push(
      "BELOW_ENTRY_SCORE"
    );
  }

  return {
    eligible:
      reasons.length === 0,
    reasons
  };
}

/* ============================================================
   RISK ASSESSMENT
   ============================================================ */

function assessRisk(candidate) {
  const reasons = [];

  if (
    !Number.isFinite(candidate.price) ||
    candidate.price <
    MIN_TOKEN_PRICE
  ) {
    reasons.push(
      "INVALID_PRICE"
    );
  }

  if (
    candidate.liquidity_usd <
    MIN_LIQUIDITY_USD
  ) {
    reasons.push(
      "LOW_LIQUIDITY"
    );
  }

  if (
    candidate.volume_24h_usd <
    MIN_VOLUME_24H_USD
  ) {
    reasons.push(
      "LOW_24H_VOLUME"
    );
  }

  if (
    candidate.volume_1h_usd <
    MIN_VOLUME_1H_USD
  ) {
    reasons.push(
      "LOW_1H_VOLUME"
    );
  }

  if (
    candidate.change_5m <=
    STRONG_NEGATIVE_5M
  ) {
    reasons.push(
      "SEVERE_5M_DECLINE"
    );
  }

  if (
    candidate.change_6h <=
    STRONG_NEGATIVE_6H
  ) {
    reasons.push(
      "STRONG_NEGATIVE_6H"
    );
  }

  if (
    candidate.age_days !== null &&
    candidate.age_days <=
    NEW_TOKEN_MAX_AGE_DAYS &&
    candidate.liquidity_usd <
    NEW_TOKEN_MIN_LIQUIDITY_USD
  ) {
    reasons.push(
      "NEW_TOKEN_LOW_LIQUIDITY"
    );
  }

  return {
    pass:
      reasons.length === 0,
    reasons
  };
}

/* ============================================================
   BUILD CANDIDATES
   ============================================================ */

async function buildCandidates(env) {
  const sourceCounts = {
    dexscreener_discovery: 0,
    dexscreener_search: 0,
    gecko_trending: 0,
    gecko_confirmed_tokens: 0,
    jupiter_price_checked: 0,
    jupiter_price_confirmed: 0,
    hydrated_pairs: 0
  };

  const dexDiscovery =
    await getDexDiscovery();

  sourceCounts.dexscreener_discovery =
    dexDiscovery.length;

  const dexSearch =
    await getDexSearch();

  sourceCounts.dexscreener_search =
    dexSearch.length;

  const geckoMints =
    await getGeckoCandidates();

  sourceCounts.gecko_trending =
    geckoMints.length;

  sourceCounts.gecko_confirmed_tokens =
    geckoMints.length;

  const allMints = unique([
    ...dexDiscovery.map(x => x.mint),
    ...dexSearch.map(x => x.mint),
    ...geckoMints
  ]);

  const dexCandidates = [
    ...dexDiscovery,
    ...dexSearch,
    ...geckoMints.map(
      mint => ({
        mint,
        source: "GECKOTERMINAL"
      })
    )
  ];

  const limited = [];

  const seen = new Set();

  for (const item of dexCandidates) {
    if (!item.mint) continue;

    if (seen.has(item.mint)) continue;

    seen.add(item.mint);

    limited.push(item);

    if (
      limited.length >=
      MAX_CANDIDATES
    ) {
      break;
    }
  }

  const candidates = [];

  for (const item of limited) {
    const pair =
      await getBestDexPair(
        item.mint
      );

    if (!pair) continue;

    const candidate =
      normalizeDexPair(
        pair,
        item.mint
      );

    if (!candidate) continue;

    candidate.sources = unique([
      item.source,
      ...(dexDiscovery.some(
        x => x.mint === item.mint
      )
        ? ["DEXSCREENER"]
        : []),
      ...(geckoMints.includes(
        item.mint
      )
        ? ["GECKOTERMINAL"]
        : [])
    ]);

    candidate.dex_confirmed = true;

    candidate.gecko_confirmed =
      geckoMints.includes(
        item.mint
      );

    sourceCounts.hydrated_pairs++;

    candidates.push(
      candidate
    );
  }

  /*
    Supplemental Jupiter confirmation.
  */
  const jupiterMints =
    candidates
      .slice(
        0,
        MAX_JUPITER_PRICE_CHECKS
      )
      .map(x => x.mint);

  sourceCounts.jupiter_price_checked =
    jupiterMints.length;

  const jupiterPrices =
    await getJupiterPrices(
      jupiterMints,
      env
    );

  sourceCounts.jupiter_price_confirmed =
    jupiterPrices.size;

  for (const candidate of candidates) {
    const jupiterPrice =
      jupiterPrices.get(
        candidate.mint
      );

    candidate.jupiter_price =
      jupiterPrice || null;

    const confirmation =
      addJupiterConfirmation(
        candidate,
        jupiterPrice
      );

    candidate.jupiter_confirmed =
      confirmation.confirmed;

    candidate.jupiter_price_difference =
      confirmation.difference;
  }

  /*
    Score and risk-assess every hydrated candidate.
  */
  for (const candidate of candidates) {
    const scoring =
      scoreCandidate(
        candidate
      );

    candidate.score =
      scoring.score;

    candidate.momentum_score =
      scoring.momentum_score;

    candidate.score_breakdown =
      scoring.breakdown;

    candidate.market_shape_reasons =
      scoring.market_shape_reasons;

    const risk =
      assessRisk(
        candidate
      );

    candidate.risk_pass =
      risk.pass;

    candidate.risk_reasons =
      risk.reasons;

    const entry =
      evaluateEntryQuality(
        candidate
      );

    candidate.entry_eligible =
      entry.eligible;

    candidate.entry_reasons =
      entry.reasons;
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score
  );

  return {
    candidates:
      candidates.slice(
        0,
        MAX_CANDIDATES
      ),

    sourceCounts
  };
}

/* ============================================================
   REJECTION DIAGNOSTICS
   ============================================================ */

function countReasons(
  candidates,
  field
) {
  const counts = {};

  for (const candidate of candidates) {
    for (
      const reason of
      candidate[field] || []
    ) {
      counts[reason] =
        (counts[reason] || 0) + 1;
    }
  }

  return Object.fromEntries(
    Object.entries(counts)
      .sort(
        (a, b) =>
          b[1] - a[1]
      )
  );
}

function buildRejectionDiagnostics(
  candidates
) {
  const riskRejected =
    candidates.filter(
      x => !x.risk_pass
    );

  const entryRejected =
    candidates.filter(
      x =>
        x.risk_pass &&
        !x.entry_eligible
    );

  const eligible =
    candidates.filter(
      x =>
        x.risk_pass &&
        x.entry_eligible
    );

  return {
    risk_rejections:
      riskRejected.length,

    entry_rejections:
      entryRejected.length,

    eligible:
      eligible.length,

    risk_rejection_reasons:
      countReasons(
        riskRejected,
        "risk_reasons"
      ),

    entry_rejection_reasons:
      countReasons(
        entryRejected,
        "entry_reasons"
      )
  };
}

/* ============================================================
   COOLDOWN
   ============================================================ */

function isOnCooldown(
  portfolio,
  mint
) {
  const timestamp =
    safeNumber(
      portfolio.cooldowns?.[mint]
    );

  if (!timestamp) {
    return false;
  }

  return (
    Date.now() -
    timestamp <
    COOLDOWN_SECONDS * 1000
  );
}

function setCooldown(
  portfolio,
  mint
) {
  portfolio.cooldowns[mint] =
    Date.now();
}

/* ============================================================
   PAPER BUY
   ============================================================ */

function paperBuy(
  portfolio,
  candidate,
  amountUsd
) {
  if (!PAPER_MODE) {
    throw new Error(
      "LIVE TRADING IS DISABLED"
    );
  }

  if (
    portfolio.positions.length >=
    MAX_POSITIONS
  ) {
    return {
      ok: false,
      reason: "MAX_POSITIONS"
    };
  }

  const availableCash =
    portfolio.cash_usd -
    MIN_CASH_RESERVE_USD;

  if (
    availableCash <
    amountUsd
  ) {
    return {
      ok: false,
      reason: "INSUFFICIENT_CASH"
    };
  }

  if (
    portfolio.positions.some(
      p =>
        p.mint === candidate.mint
    )
  ) {
    return {
      ok: false,
      reason: "ALREADY_HOLDING"
    };
  }

  const quantity =
    amountUsd /
    candidate.price;

  const position = {
    id:
      `${candidate.mint}-${Date.now()}`,

    mint:
      candidate.mint,

    symbol:
      candidate.symbol,

    name:
      candidate.name,

    quantity,

    invested_usd:
      amountUsd,

    entry_price:
      candidate.price,

    current_price:
      candidate.price,

    peak_price:
      candidate.price,

    pnl_percent: 0,

    pnl_usd: 0,

    trailing_active:
      false,

    reversal_confirmations:
      0,

    entry_score:
      candidate.score,

    entry_momentum_score:
      candidate.momentum_score,

    entry_score_breakdown:
      candidate.score_breakdown,

    entry_sources:
      candidate.sources,

    entry_time:
      nowIso()
  };

  portfolio.cash_usd -=
    amountUsd;

  portfolio.positions.push(
    position
  );

  setCooldown(
    portfolio,
    candidate.mint
  );

  addHistory(
    portfolio,
    {
      type: "PAPER_BUY",

      mint:
        candidate.mint,

      symbol:
        candidate.symbol,

      price:
        candidate.price,

      amount_usd:
        amountUsd,

      quantity,

      score:
        candidate.score,

      momentum_score:
        candidate.momentum_score,

      reason:
        "ENTRY_ELIGIBLE"
    }
  );

  return {
    ok: true,
    position
  };
}

/* ============================================================
   PAPER SELL
   ============================================================ */

function paperSell(
  portfolio,
  position,
  price,
  reason
) {
  if (!PAPER_MODE) {
    throw new Error(
      "LIVE TRADING IS DISABLED"
    );
  }

  const proceeds =
    position.quantity *
    price;

  const pnl =
    proceeds -
    position.invested_usd;

  const pnlPercent =
    position.invested_usd > 0
      ? pnl /
        position.invested_usd
      : 0;

  portfolio.cash_usd +=
    proceeds;

  portfolio.realized_pnl_usd +=
    pnl;

  portfolio.positions =
    portfolio.positions.filter(
      p =>
        p.id !== position.id
    );

  setCooldown(
    portfolio,
    position.mint
  );

  addHistory(
    portfolio,
    {
      type: "PAPER_SELL",

      mint:
        position.mint,

      symbol:
        position.symbol,

      price,

      proceeds_usd:
        proceeds,

      pnl_usd:
        pnl,

      pnl_percent:
        pnlPercent,

      reason
    }
  );

  return {
    ok: true,

    mint:
      position.mint,

    symbol:
      position.symbol,

    price,

    proceeds_usd:
      proceeds,

    pnl_usd:
      pnl,

    pnl_percent:
      pnlPercent,

    reason
  };
}

/* ============================================================
   POSITION MONITOR
   ============================================================ */

function updatePosition(
  position,
  candidate
) {
  const price =
    candidate.price;

  position.current_price =
    price;

  const pnl =
    position.entry_price > 0
      ? (
          price -
          position.entry_price
        ) /
        position.entry_price
      : 0;

  position.pnl_percent =
    pnl;

  position.pnl_usd =
    position.invested_usd *
    pnl;

  if (
    price >
    safeNumber(
      position.peak_price,
      position.entry_price
    )
  ) {
    position.peak_price =
      price;
  }

  /*
    Hard stop.
  */
  if (
    pnl <= STOP_LOSS
  ) {
    return {
      sell: true,
      reason: "HARD_STOP"
    };
  }

  /*
    Activate trailing protection.
  */
  if (
    pnl >=
    TRAILING_ACTIVATION
  ) {
    position.trailing_active =
      true;
  }

  /*
    Trailing stop.
  */
  if (
    position.trailing_active &&
    position.peak_price > 0
  ) {
    const drawdownFromPeak =
      (
        price -
        position.peak_price
      ) /
      position.peak_price;

    if (
      drawdownFromPeak <=
      -TRAILING_STOP
    ) {
      return {
        sell: true,
        reason:
          "TRAILING_STOP"
      };
    }
  }

  /*
    Reversal detection.
  */
  const shortTermSelling =
    candidate.sell_ratio_5m <=
    SHORT_TERM_SELL_RATIO;

  const hourlySelling =
    candidate.buy_pressure_1h <
    1 / HOURLY_SELL_RATIO;

  const reversalSignal =
    shortTermSelling ||
    hourlySelling;

  if (
    position.trailing_active &&
    pnl > 0 &&
    reversalSignal
  ) {
    position.reversal_confirmations =
      safeNumber(
        position.reversal_confirmations
      ) + 1;
  } else if (!reversalSignal) {
    position.reversal_confirmations = 0;
  }

  /*
    Require multiple confirmations.
  */
  if (
    position.trailing_active &&
    pnl > 0 &&
    position.reversal_confirmations >=
      REVERSAL_CONFIRMATIONS_REQUIRED
  ) {
    const sellThreshold =
      1 /
      PROFIT_REVERSAL_SELL_RATIO;

    if (
      candidate.buy_pressure_1h <=
      sellThreshold
    ) {
      return {
        sell: true,
        reason:
          "PROFIT_REVERSAL"
      };
    }
  }

  return {
    sell: false,
    reason: null
  };
}

/* ============================================================
   ACCOUNTING CHECK
   ============================================================ */

function calculateAccountingCheck(
  portfolio
) {
  const openInvested =
    portfolio.positions.reduce(
      (sum, position) =>
        sum +
        safeNumber(
          position.invested_usd
        ),
      0
    );

  const expected =
    STARTING_CASH_USD +
    portfolio.realized_pnl_usd;

  const actual =
    portfolio.cash_usd +
    openInvested;

  const difference =
    actual - expected;

  return {
    actual_basis_usd:
      round(actual, 8),

    expected_basis_usd:
      round(expected, 8),

    difference_usd:
      round(difference, 8),

    ok:
      Math.abs(difference) <
      0.000001
  };
}

/* ============================================================
   MARK PORTFOLIO
   ============================================================ */

function markPortfolio(
  portfolio,
  candidates
) {
  const byMint =
    new Map(
      candidates.map(
        candidate =>
          [
            candidate.mint,
            candidate
          ]
      )
    );

  let positionValue = 0;

  let unrealizedPnl = 0;

  for (const position of portfolio.positions) {
    const candidate =
      byMint.get(
        position.mint
      );

    if (candidate) {
      position.current_price =
        candidate.price;

      const pnl =
        position.entry_price > 0
          ? (
              candidate.price -
              position.entry_price
            ) /
            position.entry_price
          : 0;

      position.pnl_percent =
        pnl;

      position.pnl_usd =
        position.invested_usd *
        pnl;

      positionValue +=
        position.invested_usd *
        (1 + pnl);

      unrealizedPnl +=
        position.pnl_usd;
    } else {
      /*
        If the scanner temporarily cannot see a held token,
        retain its previous marked value rather than treating
        it as zero.
      */
      positionValue +=
        position.invested_usd *
        (
          1 +
          safeNumber(
            position.pnl_percent
          )
        );

      unrealizedPnl +=
        safeNumber(
          position.pnl_usd
        );
    }
  }

  const equity =
    portfolio.cash_usd +
    positionValue;

  const totalPnl =
    portfolio.realized_pnl_usd +
    unrealizedPnl;

  const returnPercent =
    STARTING_CASH_USD > 0
      ? totalPnl /
        STARTING_CASH_USD
      : 0;

  return {
    cash_usd:
      round(
        portfolio.cash_usd,
        8
      ),

    position_value_usd:
      round(
        positionValue,
        8
      ),

    equity_usd:
      round(
        equity,
        8
      ),

    realized_pnl_usd:
      round(
        portfolio.realized_pnl_usd,
        8
      ),

    unrealized_pnl_usd:
      round(
        unrealizedPnl,
        8
      ),

    total_pnl_usd:
      round(
        totalPnl,
        8
      ),

    return_percent:
      round(
        returnPercent * 100,
        6
      ),

    open_positions:
      portfolio.positions.length,

    max_positions:
      MAX_POSITIONS
  };
}

/* ============================================================
   RUN PAPER ENGINE
   ============================================================ */

async function runPaperEngine(env) {
  if (!PAPER_MODE) {
    throw new Error(
      "This build is configured for PAPER MODE only."
    );
  }

  const portfolio =
    await loadPortfolio(env);

  const buys = [];

  const sells = [];

  /*
    ==========================================================
    FIRST: SCAN CURRENT MARKET
    ==========================================================
  */

  const scan =
    await buildCandidates(env);

  const candidates =
    scan.candidates;

  /*
    ==========================================================
    MONITOR EXISTING POSITIONS
    ==========================================================
  */

  for (
    const position of [
      ...portfolio.positions
    ]
  ) {
    const candidate =
      candidates.find(
        c =>
          c.mint ===
          position.mint
      );

    if (!candidate) {
      continue;
    }

    const decision =
      updatePosition(
        position,
        candidate
      );

    if (
      decision.sell
    ) {
      const result =
        paperSell(
          portfolio,
          position,
          candidate.price,
          decision.reason
        );

      if (result.ok) {
        sells.push(result);
      }
    }
  }

  /*
    ==========================================================
    FIND NEW ENTRY
    ==========================================================
  */

  let buysRemaining =
    MAX_NEW_BUYS_PER_RUN;

  if (
    portfolio.positions.length <
    MAX_POSITIONS
  ) {
    const eligible =
      candidates.filter(
        candidate =>
          candidate.risk_pass &&
          candidate.entry_eligible &&
          !isOnCooldown(
            portfolio,
            candidate.mint
          ) &&
          !portfolio.positions.some(
            position =>
              position.mint ===
              candidate.mint
          )
      );

    for (
      const candidate of eligible
    ) {
      if (
        buysRemaining <= 0
      ) {
        break;
      }

      const equity =
        markPortfolio(
          portfolio,
          candidates
        ).equity_usd;

      let amount =
        getPositionSize(
          equity
        );

      const availableCash =
        portfolio.cash_usd -
        MIN_CASH_RESERVE_USD;

      amount =
        Math.min(
          amount,
          MAX_PAPER_POSITION_USD,
          availableCash
        );

      if (
        amount <= 0
      ) {
        break;
      }

      const result =
        paperBuy(
          portfolio,
          candidate,
          amount
        );

      if (result.ok) {
        buys.push({
          mint:
            candidate.mint,

          symbol:
            candidate.symbol,

          price:
            candidate.price,

          amount_usd:
            amount,

          quantity:
            result.position.quantity,

          score:
            candidate.score,

          momentum_score:
            candidate.momentum_score
        });

        buysRemaining--;
      }
    }
  }

  /*
    ==========================================================
    MARK PORTFOLIO AFTER TRADES
    ==========================================================
  */

  const portfolioMark =
    markPortfolio(
      portfolio,
      candidates
    );

  const accounting =
    calculateAccountingCheck(
      portfolio
    );

  /*
    ==========================================================
    REJECTION DIAGNOSTICS
    ==========================================================
  */

  const diagnostics =
    buildRejectionDiagnostics(
      candidates
    );

  const riskPassCount =
    candidates.filter(
      c => c.risk_pass
    ).length;

  const eligibleCount =
    candidates.filter(
      c =>
        c.risk_pass &&
        c.entry_eligible
    ).length;

  let noTradeReason =
    null;

  if (
    buys.length === 0
  ) {
    if (
      portfolio.positions.length >=
      MAX_POSITIONS
    ) {
      noTradeReason =
        "MAX_POSITIONS_REACHED";
    } else if (
      portfolio.cash_usd <=
      MIN_CASH_RESERVE_USD
    ) {
      noTradeReason =
        "CASH_RESERVE";
    } else if (
      candidates.length === 0
    ) {
      noTradeReason =
        "NO_CANDIDATES";
    } else if (
      riskPassCount === 0
    ) {
      noTradeReason =
        "NO_RISK_PASS_CANDIDATES";
    } else if (
      eligibleCount === 0
    ) {
      noTradeReason =
        "NO_ELIGIBLE_NEW_ENTRY";
    } else {
      noTradeReason =
        "NO_BUY_EXECUTED";
    }
  }

  const sizing =
    getPositionSize(
      portfolioMark.equity_usd
    );

  const scanResult = {
    total_candidates:
      candidates.length,

    risk_pass_candidates:
      riskPassCount,

    eligible_candidates:
      eligibleCount,

    source_counts:
      scan.sourceCounts,

    rejection_diagnostics:
      diagnostics,

    top_candidates:
      candidates
        .slice(0, 15)
        .map(candidate => ({
          symbol:
            candidate.symbol,

          name:
            candidate.name,

          mint:
            candidate.mint,

          price:
            candidate.price,

          score:
            candidate.score,

          momentum_score:
            candidate.momentum_score,

          liquidity_usd:
            round(
              candidate.liquidity_usd,
              2
            ),

          volume_24h_usd:
            round(
              candidate.volume_24h_usd,
              2
            ),

          volume_1h_usd:
            round(
              candidate.volume_1h_usd,
              2
            ),

          change_5m:
            round(
              pct(
                candidate.change_5m
              ),
              2
            ),

          change_1h:
            round(
              pct(
                candidate.change_1h
              ),
              2
            ),

          change_6h:
            round(
              pct(
                candidate.change_6h
              ),
              2
            ),

          change_24h:
            round(
              pct(
                candidate.change_24h
              ),
              2
            ),

          buy_pressure_5m:
            round(
              candidate.buy_pressure_5m,
              3
            ),

          buy_pressure_1h:
            round(
              candidate.buy_pressure_1h,
              3
            ),

          age_days:
            candidate.age_days === null
              ? null
              : round(
                  candidate.age_days,
                  4
                ),

          risk_pass:
            candidate.risk_pass,

          risk_reasons:
            candidate.risk_reasons,

          entry_eligible:
            candidate.entry_eligible,

          entry_reasons:
            candidate.entry_reasons,

          sources:
            candidate.sources,

          jupiter_confirmed:
            candidate.jupiter_confirmed
        }))
  };

  portfolio.last_scan =
    scanResult;

  await savePortfolio(
    env,
    portfolio
  );

  return {
    ok: true,

    bot:
      BOT_NAME,

    mode: {
      type: "PAPER",
      transaction_execution: false
    },

    buys:
      buys.length,

    sells:
      sells.length,

    buy_details:
      buys,

    sell_details:
      sells,

    scanner_status:
      "OK",

    no_trade_reason:
      noTradeReason,

    portfolio:
      portfolioMark,

    sizing: {
      current_position_size_usd:
        sizing,

      max_position_size_usd:
        MAX_PAPER_POSITION_USD,

      max_positions:
        MAX_POSITIONS,

      max_new_buys_per_run:
        MAX_NEW_BUYS_PER_RUN
    },

    accounting,

    scan:
      scanResult
  };
}

/* ============================================================
   TEST SCAN
   ============================================================ */

async function runScanOnly(env) {
  const scan =
    await buildCandidates(env);

  const candidates =
    scan.candidates;

  const diagnostics =
    buildRejectionDiagnostics(
      candidates
    );

  return {
    ok: true,

    bot:
      BOT_NAME,

    mode: {
      type: "PAPER",
      transaction_execution: false
    },

    scanner_status:
      "OK",

    scan: {
      total_candidates:
        candidates.length,

      risk_pass_candidates:
        candidates.filter(
          c => c.risk_pass
        ).length,

      eligible_candidates:
        candidates.filter(
          c =>
            c.risk_pass &&
            c.entry_eligible
        ).length,

      source_counts:
        scan.sourceCounts,

      rejection_diagnostics:
        diagnostics,

      top_candidates:
        candidates
          .slice(0, 15)
          .map(candidate => ({
            symbol:
              candidate.symbol,

            name:
              candidate.name,

            mint:
              candidate.mint,

            price:
              candidate.price,

            score:
              candidate.score,

            momentum_score:
              candidate.momentum_score,

            liquidity_usd:
              round(
                candidate.liquidity_usd,
                2
              ),

            volume_24h_usd:
              round(
                candidate.volume_24h_usd,
                2
              ),

            volume_1h_usd:
              round(
                candidate.volume_1h_usd,
                2
              ),

            change_5m:
              round(
                pct(
                  candidate.change_5m
                ),
                2
              ),

            change_1h:
              round(
                pct(
                  candidate.change_1h
                ),
                2
              ),

            change_6h:
              round(
                pct(
                  candidate.change_6h
                ),
                2
              ),

            change_24h:
              round(
                pct(
                  candidate.change_24h
                ),
                2
              ),

            risk_pass:
              candidate.risk_pass,

            risk_reasons:
              candidate.risk_reasons,

            entry_eligible:
              candidate.entry_eligible,

            entry_reasons:
              candidate.entry_reasons,

            sources:
              candidate.sources,

            jupiter_confirmed:
              candidate.jupiter_confirmed
          }))
    }
  };
}

/* ============================================================
   STATUS
   ============================================================ */

async function getStatus(env) {
  const portfolio =
    await loadPortfolio(env);

  const mark =
    markPortfolio(
      portfolio,
      portfolio.positions.map(
        position => ({
          mint:
            position.mint,

          price:
            position.current_price
        })
      )
    );

  return {
    ok: true,

    bot:
      BOT_NAME,

    mode: {
      type: "PAPER",
      transaction_execution: false
    },

    settings: {
      min_entry_score:
        MIN_ENTRY_SCORE,

      min_momentum_score:
        MIN_MOMENTUM_SCORE,

      max_positions:
        MAX_POSITIONS,

      max_new_buys_per_run:
        MAX_NEW_BUYS_PER_RUN,

      stop_loss:
        STOP_LOSS,

      trailing_activation:
        TRAILING_ACTIVATION,

      trailing_stop:
        TRAILING_STOP,

      reversal_confirmations_required:
        REVERSAL_CONFIRMATIONS_REQUIRED
    },

    portfolio:
      mark,

    accounting:
      calculateAccountingCheck(
        portfolio
      ),

    open_positions:
      portfolio.positions.map(
        position => ({
          symbol:
            position.symbol,

          mint:
            position.mint,

          entry_price:
            position.entry_price,

          current_price:
            position.current_price,

          invested_usd:
            position.invested_usd,

          pnl_usd:
            position.pnl_usd,

          pnl_percent:
            pct(
              position.pnl_percent
            ),

          peak_price:
            position.peak_price,

          trailing_active:
            position.trailing_active,

          reversal_confirmations:
            position.reversal_confirmations,

          entry_score:
            position.entry_score,

          entry_time:
            position.entry_time
        })
      )
  };
}

/* ============================================================
   RESET PAPER ACCOUNT
   ============================================================ */

async function resetPaper(env) {
  const portfolio =
    createEmptyPortfolio();

  await env.BOT_KV.delete(
    "PAPER_SCAN"
  );

  await savePortfolio(
    env,
    portfolio
  );

  return {
    ok: true,

    bot:
      BOT_NAME,

    mode: {
      type: "PAPER",
      transaction_execution: false
    },

    message:
      "Paper portfolio reset.",

    portfolio:
      markPortfolio(
        portfolio,
        []
      )
  };
}

/* ============================================================
   HTTP ROUTER
   ============================================================ */

export default {
  async fetch(request, env) {
    try {
      const url =
        new URL(request.url);

      const path =
        url.pathname;

      if (
        request.method !== "GET" &&
        request.method !== "POST"
      ) {
        return new Response(
          JSON.stringify({
            ok: false,
            error:
              "Method not allowed"
          }),
          {
            status: 405,
            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }

      /*
        Health check
      */
      if (
        path === "/" ||
        path === "/health"
      ) {
        return new Response(
          JSON.stringify({
            ok: true,
            bot:
              BOT_NAME,
            mode:
              "PAPER",
            transaction_execution:
              false,
            time:
              nowIso()
          }),
          {
            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }

      /*
        Run full paper engine
      */
      if (
        path === "/run"
      ) {
        const result =
          await runPaperEngine(
            env
          );

        return new Response(
          JSON.stringify(
            result,
            null,
            2
          ),
          {
            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }

      /*
        Scan without trading
      */
      if (
        path === "/scan"
      ) {
        const result =
          await runScanOnly(
            env
          );

        return new Response(
          JSON.stringify(
            result,
            null,
            2
          ),
          {
            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }

      /*
        Portfolio status
      */
      if (
        path === "/status"
      ) {
        const result =
          await getStatus(
            env
          );

        return new Response(
          JSON.stringify(
            result,
            null,
            2
          ),
          {
            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }

      /*
        Reset only when explicitly confirmed.
        Example:
        /reset?confirm=RESET
      */
      if (
        path === "/reset"
      ) {
        const confirm =
          url.searchParams.get(
            "confirm"
          );

        if (
          confirm !== "RESET"
        ) {
          return new Response(
            JSON.stringify({
              ok: false,
              error:
                "Reset requires ?confirm=RESET"
            }),
            {
              status: 400,
              headers: {
                "content-type":
                  "application/json"
              }
            }
          );
        }

        const result =
          await resetPaper(
            env
          );

        return new Response(
          JSON.stringify(
            result,
            null,
            2
          ),
          {
            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }

      return new Response(
        JSON.stringify({
          ok: false,
          error:
            "Unknown endpoint",
          endpoints: [
            "/health",
            "/run",
            "/scan",
            "/status",
            "/reset?confirm=RESET"
          ]
        }),
        {
          status: 404,
          headers: {
            "content-type":
              "application/json"
          }
        }
      );
    } catch (error) {
      /*
        Keep failures visible in the Worker response and
        history without attempting any live transaction.
      */

      try {
        const portfolio =
          await loadPortfolio(env);

        addHistory(
          portfolio,
          {
            type:
              "ENGINE_ERROR",

            error:
              errorText(error)
          }
        );

        await savePortfolio(
          env,
          portfolio
        );
      } catch {
        /* Do not mask the original error */
      }

      return new Response(
        JSON.stringify(
          {
            ok: false,

            bot:
              BOT_NAME,

            mode: {
              type: "PAPER",
              transaction_execution:
                false
            },

            error:
              errorText(error),

            time:
              nowIso()
          },
          null,
          2
        ),
        {
          status: 500,
          headers: {
            "content-type":
              "application/json"
          }
        }
      );
    }
  },

  /*
    Cloudflare Cron:
    run the paper engine once every minute.
  */
  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      (async () => {
        try {
          const result =
            await runPaperEngine(
              env
            );

          console.log(
            JSON.stringify(
              {
                cron:
                  true,

                bot:
                  BOT_NAME,

                time:
                  nowIso(),

                buys:
                  result.buys,

                sells:
                  result.sells,

                no_trade_reason:
                  result.no_trade_reason,

                equity:
                  result.portfolio
                    .equity_usd,

                eligible:
                  result.scan
                    .eligible_candidates
              }
            )
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              cron:
                true,

              bot:
                BOT_NAME,

              error:
                errorText(error),

              time:
                nowIso()
            })
          );
        }
      })()
    );
  }
};
