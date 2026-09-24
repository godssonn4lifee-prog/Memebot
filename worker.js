const BOT_NAME = "memebott";

/*
  ============================================================
  MEMEBOTT — MULTI-SOURCE PAPER TRADING ENGINE
  ============================================================

  PAPER ONLY.

  No private key.
  No wallet signing.
  No real-money transaction execution.

  DISCOVERY:
    1. DEX Screener
    2. GeckoTerminal
    3. Jupiter price data when available

  Jupiter is NOT the primary discovery source.

  STRATEGY:
    - Discover many Solana candidates
    - Deduplicate by mint
    - Hydrate market data
    - Check liquidity
    - Check volume
    - Check buy/sell pressure
    - Analyze 5m / 1h / 6h momentum
    - Detect acceleration
    - Detect late-stage pumps
    - Detect short-term reversals
    - Confirm across independent sources
    - Score candidates
    - Paper-buy only strong candidates
    - Monitor open positions
    - Hard stop
    - Trailing-profit exit
    - Record every decision
*/

/*
  ============================================================
  SAFETY
  ============================================================
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
  ============================================================
  EXIT RULES
  ============================================================
*/

const STOP_LOSS = -0.01;

const TRAILING_ACTIVATION = 0.01;

const TRAILING_STOP = 0.03;

const REVERSAL_CONFIRMATIONS_REQUIRED = 2;

/*
  ============================================================
  SCANNER LIMITS
  ============================================================
*/

const MAX_CANDIDATES = 30;

const MAX_DEX_TOKENS_TO_ANALYZE = 40;

const MAX_GECKO_POOLS_TO_ANALYZE = 20;

const MAX_JUPITER_PRICE_CHECKS = 20;

const MIN_TOKEN_PRICE_USD = 0.00000001;

/*
  ============================================================
  RISK FILTERS
  ============================================================
*/

const MIN_LIQUIDITY_USD = 15000;

const MIN_VOLUME_24H_USD = 10000;

const MIN_VOLUME_1H_USD = 1000;

/*
  Very old pools are not automatically bad, but we don't want
  stale pairs dominating the scanner.
*/
const MAX_PAIR_AGE_DAYS = 365;

/*
  ============================================================
  MARKET-SHAPE RULES
  ============================================================
*/

/*
  Don't chase a token after an enormous 1h move.
*/
const EXTREME_1H_MOVE_PERCENT = 50;

/*
  Strongly negative 6h movement can indicate a temporary bounce
  rather than a healthy trend.
*/
const STRONG_NEGATIVE_6H_PERCENT = -15;

/*
  Very strong negative 5m movement is treated as a reversal.
*/
const STRONG_NEGATIVE_5M_PERCENT = -3;

/*
  A large positive 5m movement after a heavily negative 6h
  movement can indicate a bounce/chase situation.
*/
const BOUNCE_5M_PERCENT = 7;

/*
  If 5m sells greatly overwhelm buys, short-term momentum
  is considered unhealthy.
*/
const SHORT_TERM_SELL_RATIO = 1.50;

/*
  If 1h sells greatly overwhelm buys, avoid the candidate.
*/
const HOURLY_SELL_RATIO = 1.43;

/*
  Minimum score needed to even be considered for entry.
*/
const MIN_ENTRY_SCORE = 50;

/*
  Require at least one meaningful momentum component.
*/
const MIN_MOMENTUM_SCORE = 5;

/*
  Avoid immediately re-buying the same token.
*/
const COOLDOWN_SECONDS = 60;

/*
  ============================================================
  STORAGE
  ============================================================
*/

const PORTFOLIO_KEY = "PAPER_PORTFOLIO";

const HISTORY_KEY = "PAPER_TRADE_HISTORY";

const COOLDOWN_KEY = "PAPER_TRADE_COOLDOWN";

const SCAN_KEY = "LAST_SCAN";

/*
  ============================================================
  API ENDPOINTS
  ============================================================
*/

const DEXSCREENER_API =
  "https://api.dexscreener.com";

const GECKO_API =
  "https://api.geckoterminal.com/api/v2";

const JUPITER_PRICE_API =
  "https://api.jup.ag/price/v3";

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

  return Number.isFinite(n)
    ? n
    : fallback;
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function ageDays(timestampMs) {
  if (!timestampMs) {
    return 9999;
  }

  const age =
    Date.now() -
    Number(timestampMs);

  if (
    !Number.isFinite(age) ||
    age < 0
  ) {
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
  const blocked =
    new Set([
      "USDC",
      "USDT",
      "USD1",
      "USDS",
      "DAI",
      "SOL",
      "WSOL"
    ]);

  return blocked.has(
    String(symbol || "").toUpperCase()
  );
}

/*
  ============================================================
  HTTP
  ============================================================
*/

async function getJson(
  url,
  headers = {}
) {
  const response =
    await fetch(url, {
      method: "GET",

      headers: {
        accept:
          "application/json",

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
    starting_cash_usd:
      PAPER_STARTING_CASH_USD,

    cash_usd:
      PAPER_STARTING_CASH_USD,

    realized_pnl_usd:
      0,

    unrealized_pnl_usd:
      0,

    total_pnl_usd:
      0,

    return_percent:
      0,

    open_positions: [],

    last_run_at:
      null,

    updated_at:
      nowIso()
  };
}

async function getPortfolio(env) {
  const raw =
    await env.BOT_KV.get(
      PORTFOLIO_KEY
    );

  if (!raw) {
    const portfolio =
      createFreshPortfolio();

    await savePortfolio(
      env,
      portfolio
    );

    return portfolio;
  }

  try {
    const portfolio =
      JSON.parse(raw);

    if (
      !Array.isArray(
        portfolio.open_positions
      )
    ) {
      portfolio.open_positions = [];
    }

    /*
      Make sure old portfolio records have
      the fields used by the current version.
    */
    if (
      !Number.isFinite(
        Number(
          portfolio.starting_cash_usd
        )
      )
    ) {
      portfolio.starting_cash_usd =
        PAPER_STARTING_CASH_USD;
    }

    if (
      !Number.isFinite(
        Number(
          portfolio.cash_usd
        )
      )
    ) {
      portfolio.cash_usd =
        portfolio.starting_cash_usd;
    }

    if (
      !Number.isFinite(
        Number(
          portfolio.realized_pnl_usd
        )
      )
    ) {
      portfolio.realized_pnl_usd = 0;
    }

    if (
      !Number.isFinite(
        Number(
          portfolio.unrealized_pnl_usd
        )
      )
    ) {
      portfolio.unrealized_pnl_usd = 0;
    }

    return portfolio;
  } catch {
    const portfolio =
      createFreshPortfolio();

    await savePortfolio(
      env,
      portfolio
    );

    return portfolio;
  }
}

async function savePortfolio(
  env,
  portfolio
) {
  portfolio.updated_at =
    nowIso();

  await env.BOT_KV.put(
    PORTFOLIO_KEY,
    JSON.stringify(portfolio)
  );
}

/*
  ============================================================
  HISTORY
  ============================================================
*/

async function getHistory(env) {
  const raw =
    await env.BOT_KV.get(
      HISTORY_KEY
    );

  if (!raw) {
    return [];
  }

  try {
    const history =
      JSON.parse(raw);

    return Array.isArray(history)
      ? history
      : [];
  } catch {
    return [];
  }
}

async function saveHistory(
  env,
  history
) {
  const trimmed =
    history.slice(-500);

  await env.BOT_KV.put(
    HISTORY_KEY,
    JSON.stringify(trimmed)
  );
}

async function addHistory(
  env,
  event
) {
  const history =
    await getHistory(env);

  history.push({
    timestamp:
      nowIso(),

    ...event
  });

  await saveHistory(
    env,
    history
  );
}

/*
  ============================================================
  COOLDOWN
  ============================================================
*/

async function getCooldowns(env) {
  const raw =
    await env.BOT_KV.get(
      COOLDOWN_KEY
    );

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCooldowns(
  env,
  cooldowns
) {
  await env.BOT_KV.put(
    COOLDOWN_KEY,
    JSON.stringify(cooldowns)
  );
}

async function isCoolingDown(
  env,
  mint
) {
  const cooldowns =
    await getCooldowns(env);

  const last =
    safeNumber(
      cooldowns[mint],
      0
    );

  return (
    Date.now() -
      last <
    COOLDOWN_SECONDS * 1000
  );
}

async function setCooldown(
  env,
  mint
) {
  const cooldowns =
    await getCooldowns(env);

  cooldowns[mint] =
    Date.now();

  for (
    const key of
    Object.keys(cooldowns)
  ) {
    if (
      Date.now() -
        safeNumber(
          cooldowns[key],
          0
        ) >
      86400000
    ) {
      delete cooldowns[key];
    }
  }

  await saveCooldowns(
    env,
    cooldowns
  );
}

/*
  ============================================================
  DEX SCREENER DISCOVERY
  ============================================================
*/

async function getDexScreenerDiscovery() {
  const results = [];

  const urls = [
    `${DEXSCREENER_API}/token-profiles/latest/v1`,

    `${DEXSCREENER_API}/token-boosts/latest/v1`,

    `${DEXSCREENER_API}/token-boosts/top/v1`
  ];

  for (
    const url of urls
  ) {
    try {
      const data =
        await getJson(url);

      if (
        Array.isArray(data)
      ) {
        results.push(
          ...data
        );
      }
    } catch {
      /*
        One source failing must not
        stop the entire scanner.
      */
    }
  }

  const unique =
    new Map();

  for (
    const item of results
  ) {
    if (
      String(
        item.chainId || ""
      ).toLowerCase() !==
      "solana"
    ) {
      continue;
    }

    const mint =
      normalizeAddress(
        item.tokenAddress
      );

    if (
      !isValidMint(mint)
    ) {
      continue;
    }

    unique.set(
      mint,
      {
        mint,

        source:
          "DEXSCREENER",

        dex_url:
          item.url ||
          null,

        boosted:
          Boolean(
            item.amount ||
            item.totalAmount
          )
      }
    );
  }

  return [
    ...unique.values()
  ];
}

/*
  ============================================================
  DEX SCREENER SEARCH
  ============================================================
*/

async function getDexSearchCandidates() {
  const searches = [
    "SOL",
    "USDC",
    "USDT"
  ];

  const candidates = [];

  for (
    const query of searches
  ) {
    try {
      const url =
        `${DEXSCREENER_API}` +
        `/latest/dex/search?q=` +
        encodeURIComponent(query);

      const data =
        await getJson(url);

      if (
        !Array.isArray(
          data.pairs
        )
      ) {
        continue;
      }

      for (
        const pair of
        data.pairs
      ) {
        if (
          String(
            pair.chainId || ""
          ).toLowerCase() !==
          "solana"
        ) {
          continue;
        }

        const base =
          pair.baseToken ||
          {};

        const mint =
          normalizeAddress(
            base.address
          );

        if (
          !isValidMint(mint)
        ) {
          continue;
        }

        candidates.push({
          mint,

          source:
            "DEXSCREENER_SEARCH",

          pair
        });
      }
    } catch {
      /*
        Continue with the
        other search terms.
      */
    }
  }

  return candidates;
}

/*
  ============================================================
  HYDRATE DEX DATA
  ============================================================
*/

async function hydrateDexCandidates(
  candidates
) {
  const uniqueMints = [
    ...new Set(
      candidates
        .map(
          x => x.mint
        )
        .filter(
          isValidMint
        )
    )
  ].slice(
    0,
    MAX_DEX_TOKENS_TO_ANALYZE
  );

  if (
    !uniqueMints.length
  ) {
    return [];
  }

  const url =
    `${DEXSCREENER_API}` +
    `/tokens/v1/solana/` +
    uniqueMints.join(",");

  try {
    const pairs =
      await getJson(url);

    if (
      !Array.isArray(pairs)
    ) {
      return [];
    }

    return pairs.filter(
      pair =>
        String(
          pair.chainId || ""
        ).toLowerCase() ===
        "solana"
    );
  } catch {
    return [];
  }
}

/*
  ============================================================
  GECKOTERMINAL
  ============================================================
*/

async function getGeckoTrendingPools() {
  try {
    const url =
      `${GECKO_API}` +
      `/networks/solana/trending_pools`;

    const data =
      await getJson(url);

    if (
      !Array.isArray(
        data.data
      )
    ) {
      return [];
    }

    return data.data
      .slice(
        0,
        MAX_GECKO_POOLS_TO_ANALYZE
      )
      .map(pool => {
        const attrs =
          pool.attributes ||
          {};

        const relationships =
          pool.relationships ||
          {};

        const poolId =
          String(
            pool.id || ""
          );

        const poolAddress =
          poolId.includes("_")
            ? poolId
                .split("_")
                .slice(1)
                .join("_")
            : poolId;

        const baseTokenId =
          relationships
            ?.base_token
            ?.data
            ?.id ||
          "";

        return {
          source:
            "GECKOTERMINAL",

          pool_address:
            poolAddress,

          name:
            attrs.name ||
            null,

          address:
            baseTokenId ||
            null,

          attributes:
            attrs
        };
      });
  } catch {
    return [];
  }
}

function extractGeckoMint(
  value
) {
  const textValue =
    String(
      value || ""
    );

  if (!textValue) {
    return "";
  }

  if (
    textValue.includes("_")
  ) {
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

function getBestDexPair(
  pairs,
  mint
) {
  const matches =
    pairs.filter(
      pair =>
        normalizeAddress(
          pair.baseToken?.address
        ) === mint
    );

  if (
    !matches.length
  ) {
    return null;
  }

  /*
    Choose deepest liquidity pool.
  */
  matches.sort(
    (a, b) =>
      safeNumber(
        b.liquidity?.usd
      ) -
      safeNumber(
        a.liquidity?.usd
      )
  );

  return matches[0];
}

function normalizeDexPair(
  pair
) {
  const txns =
    pair.txns ||
    {};

  const volume =
    pair.volume ||
    {};

  const change =
    pair.priceChange ||
    {};

  const h24 =
    txns.h24 ||
    {};

  const h6 =
    txns.h6 ||
    {};

  const h1 =
    txns.h1 ||
    {};

  const m5 =
    txns.m5 ||
    {};

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
      safeNumber(
        pair.priceUsd
      ),

    liquidity_usd:
      safeNumber(
        pair.liquidity?.usd
      ),

    volume_24h_usd:
      safeNumber(
        volume.h24
      ),

    volume_6h_usd:
      safeNumber(
        volume.h6
      ),

    volume_1h_usd:
      safeNumber(
        volume.h1
      ),

    volume_5m_usd:
      safeNumber(
        volume.m5
      ),

    buys_24h:
      safeNumber(
        h24.buys
      ),

    sells_24h:
      safeNumber(
        h24.sells
      ),

    buys_1h:
      safeNumber(
        h1.buys
      ),

    sells_1h:
      safeNumber(
        h1.sells
      ),

    buys_5m:
      safeNumber(
        m5.buys
      ),

    sells_5m:
      safeNumber(
        m5.sells
      ),

    price_change_24h:
      safeNumber(
        change.h24
      ),

    price_change_6h:
      safeNumber(
        change.h6
      ),

    price_change_1h:
      safeNumber(
        change.h1
      ),

    price_change_5m:
      safeNumber(
        change.m5
      ),

    fdv:
      safeNumber(
        pair.fdv
      ),

    market_cap:
      safeNumber(
        pair.marketCap
      ),

    pair_created_at:
      safeNumber(
        pair.pairCreatedAt
      ),

    pair_age_days:
      ageDays(
        safeNumber(
          pair.pairCreatedAt
        )
      ),

    dex:
      pair.dexId ||
      null,

    pair_address:
      pair.pairAddress ||
      null,

    pair_url:
      pair.url ||
      null,

    boosts_active:
      safeNumber(
        pair.boosts?.active
      )
  };
}

/*
  ============================================================
  JUPITER OPTIONAL CROSS-CHECK
  ============================================================
*/

async function getJupiterCrossCheck(
  env,
  mints
) {
  const unique = [
    ...new Set(
      mints
        .filter(
          isValidMint
        )
    )
  ].slice(
    0,
    MAX_JUPITER_PRICE_CHECKS
  );

  /*
    Jupiter is optional.

    If there is no API key configured,
    do not allow that to affect the scanner.
  */
  if (
    !env.JUPITER_API_KEY ||
    !unique.length
  ) {
    return {
      checked: 0,
      confirmed: 0,
      data: {},
      available: false
    };
  }

  try {
    const url =
      `${JUPITER_PRICE_API}` +
      `?ids=` +
      unique.join(",");

    const data =
      await getJson(
        url,
        {
          "x-api-key":
            env.JUPITER_API_KEY
        }
      );

    const prices =
      data?.data ||
      {};

    return {
      checked:
        unique.length,

      confirmed:
        Object.keys(
          prices
        ).length,

      data:
        prices,

      available:
        true
    };
  } catch {
    return {
      checked:
        unique.length,

      confirmed:
        0,

      data: {},

      available:
        false
    };
  }
}

/*
  ============================================================
  BUY PRESSURE
  ============================================================
*/

function calculateBuyPressure(
  data
) {
  const buys =
    safeNumber(
      data.buys_1h
    );

  const sells =
    safeNumber(
      data.sells_1h
    );

  const total =
    buys + sells;

  if (
    total <= 0
  ) {
    return 0;
  }

  return (
    buys / total
  );
}

function calculateShortTermPressure(
  data
) {
  const buys =
    safeNumber(
      data.buys_5m
    );

  const sells =
    safeNumber(
      data.sells_5m
    );

  const total =
    buys + sells;

  if (
    total <= 0
  ) {
    return 0.5;
  }

  return (
    buys / total
  );
}

/*
  ============================================================
  MOMENTUM SCORE
  ============================================================
*/

function calculateMomentumScore(
  data
) {
  let score = 0;

  /*
    5-minute momentum.
  */
  if (
    data.price_change_5m > 0
  ) {
    score += clamp(
      data.price_change_5m *
        0.65,
      0,
      6
    );
  }

  /*
    1-hour momentum.
  */
  if (
    data.price_change_1h > 0
  ) {
    score += clamp(
      data.price_change_1h *
        0.45,
      0,
      8
    );
  }

  /*
    6-hour momentum.
  */
  if (
    data.price_change_6h > 0
  ) {
    score += clamp(
      data.price_change_6h *
        0.12,
      0,
      5
    );
  }

  /*
    Slight bonus for a stable short-term movement
    while the 1h trend remains positive.

    This prevents us from requiring a token to be
    pumping every five minutes.
  */
  if (
    data.price_change_1h > 1 &&
    data.price_change_5m >= -0.75 &&
    data.price_change_5m <= 2
  ) {
    score += 2;
  }

  return clamp(
    score,
    0,
    20
  );
}

/*
  ============================================================
  VOLUME SCORE
  ============================================================
*/

function calculateVolumeScore(
  data
) {
  let score = 0;

  if (
    data.volume_24h_usd >=
    1000000
  ) {
    score += 8;
  } else if (
    data.volume_24h_usd >=
    250000
  ) {
    score += 6;
  } else if (
    data.volume_24h_usd >=
    100000
  ) {
    score += 5;
  } else if (
    data.volume_24h_usd >=
    50000
  ) {
    score += 3;
  } else if (
    data.volume_24h_usd >=
    10000
  ) {
    score += 1;
  }

  if (
    data.volume_1h_usd >=
    50000
  ) {
    score += 7;
  } else if (
    data.volume_1h_usd >=
    10000
  ) {
    score += 5;
  } else if (
    data.volume_1h_usd >=
    5000
  ) {
    score += 3;
  } else if (
    data.volume_1h_usd >=
    1000
  ) {
    score += 1;
  }

  /*
    5m activity bonus.

    We don't require huge 5m volume, but we want
    some actual activity when the token is being
    considered for entry.
  */
  if (
    data.volume_5m_usd >=
    10000
  ) {
    score += 2;
  } else if (
    data.volume_5m_usd >=
    2500
  ) {
    score += 1;
  }

  return clamp(
    score,
    0,
    20
  );
}

/*
  ============================================================
  LIQUIDITY SCORE
  ============================================================
*/

function calculateLiquidityScore(
  data
) {
  const liquidity =
    data.liquidity_usd;

  if (
    liquidity >=
    1000000
  ) {
    return 20;
  }

  if (
    liquidity >=
    500000
  ) {
    return 18;
  }

  if (
    liquidity >=
    250000
  ) {
    return 16;
  }

  if (
    liquidity >=
    100000
  ) {
    return 13;
  }

  if (
    liquidity >=
    50000
  ) {
    return 10;
  }

  if (
    liquidity >=
    25000
  ) {
    return 6;
  }

  if (
    liquidity >=
    MIN_LIQUIDITY_USD
  ) {
    return 3;
  }

  return 0;
}

/*
  ============================================================
  BUY PRESSURE SCORE
  ============================================================
*/

function calculateBuyPressureScore(
  data
) {
  const pressure =
    calculateBuyPressure(
      data
    );

  if (
    pressure >=
    0.70
  ) {
    return 15;
  }

  if (
    pressure >=
    0.62
  ) {
    return 12;
  }

  if (
    pressure >=
    0.56
  ) {
    return 9;
  }

  if (
    pressure >=
    0.52
  ) {
    return 6;
  }

  if (
    pressure >=
    0.50
  ) {
    return 3;
  }

  return 0;
}

/*
  ============================================================
  ACCELERATION
  ============================================================
*/

function calculateAccelerationScore(
  data
) {
  const shortTerm =
    safeNumber(
      data.price_change_5m
    );

  const hourly =
    safeNumber(
      data.price_change_1h
    );

  let score = 0;

  /*
    Healthy positive trend.
  */
  if (
    shortTerm > 0 &&
    hourly > 0
  ) {
    score += 4;
  }

  /*
    5m is meaningfully participating
    in the 1h trend.
  */
  if (
    shortTerm > 0 &&
    hourly > 0 &&
    shortTerm >=
      hourly / 6
  ) {
    score += 3;
  }

  /*
    Positive short-term price movement
    with meaningful short-term volume.
  */
  if (
    data.volume_5m_usd >
    data.volume_1h_usd / 12
  ) {
    score += 2;
  }

  /*
    Short-term buyers exceeding sellers.
  */
  if (
    data.buys_5m >
    data.sells_5m
  ) {
    score += 1;
  }

  return clamp(
    score,
    0,
    10
  );
}

/*
  ============================================================
  CROSS-SOURCE SCORE
  ============================================================
*/

function calculateCrossSourceScore(
  jupiterData,
  geckoFound
) {
  let score = 0;

  /*
    DEX Screener is already the primary
    market-data source, so we do not award
    a bonus merely for having it.
  */

  /*
    GeckoTerminal independently confirms
    the token.
  */
  if (
    geckoFound
  ) {
    score += 10;
  }

  /*
    Jupiter is only a supplemental price
    confirmation when actually available.
  */
  if (
    jupiterData
  ) {
    score += 3;
  }

  return clamp(
    score,
    0,
    13
  );
}

/*
  ============================================================
  MARKET SHAPE
  ============================================================
*/

function analyzeMarketShape(
  data
) {
  let penalty = 0;

  const reasons = [];

  /*
    ========================================================
    EXTREME 1H MOVE
    ========================================================
  */

  if (
    data.price_change_1h >=
    EXTREME_1H_MOVE_PERCENT
  ) {
    penalty += 10;

    reasons.push(
      "EXTREME_1H_MOVE"
    );
  }

  /*
    ========================================================
    STRONG NEGATIVE 6H TREND
    ========================================================
  */

  if (
    data.price_change_6h <=
    STRONG_NEGATIVE_6H_PERCENT
  ) {
    penalty += 8;

    reasons.push(
      "NEGATIVE_6H_TREND"
    );
  }

  /*
    ========================================================
    LARGE 5M REVERSAL
    ========================================================
  */

  if (
    data.price_change_5m <=
    STRONG_NEGATIVE_5M_PERCENT &&
    data.price_change_1h > 0
  ) {
    penalty += 8;

    reasons.push(
      "SHORT_TERM_REVERSAL"
    );
  }

  /*
    ========================================================
    BUY/SELL DETERIORATION
    ========================================================
  */

  const shortBuys =
    safeNumber(
      data.buys_5m
    );

  const shortSells =
    safeNumber(
      data.sells_5m
    );

  if (
    shortSells > 0 &&
    shortBuys <
      shortSells /
        SHORT_TERM_SELL_RATIO
  ) {
    penalty += 6;

    reasons.push(
      "SHORT_TERM_SELL_PRESSURE"
    );
  }

  /*
    ========================================================
    HOURLY SELL PRESSURE
    ========================================================
  */

  const hourlyBuys =
    safeNumber(
      data.buys_1h
    );

  const hourlySells =
    safeNumber(
      data.sells_1h
    );

  if (
    hourlySells > 0 &&
    hourlyBuys <
      hourlySells /
        HOURLY_SELL_RATIO
  ) {
    penalty += 7;

    reasons.push(
      "HOURLY_SELL_PRESSURE"
    );
  }

  /*
    ========================================================
    BOUNCE / CHASE DETECTION
    ========================================================

    Example:

      6h = -30%
      1h = +8%
      5m = +10%

    That can be a bounce rather than
    the beginning of a sustained trend.
  */

  if (
    data.price_change_6h <=
      STRONG_NEGATIVE_6H_PERCENT &&
    data.price_change_5m >=
      BOUNCE_5M_PERCENT
  ) {
    penalty += 7;

    reasons.push(
      "BOUNCE_AFTER_LARGE_DECLINE"
    );
  }

  /*
    ========================================================
    TOO MANY SHORT-TERM SELLS
    ========================================================
  */

  if (
    shortSells >= 20 &&
    shortSells >
      shortBuys * 1.25
  ) {
    penalty += 4;

    reasons.push(
      "SHORT_TERM_SELL_DOMINANCE"
    );
  }

  return {
    penalty,

    reasons
  };
}

/*
  ============================================================
  RISK ASSESSMENT
  ============================================================
*/

function assessRisk(
  data,
  marketShape
) {
  const reasons = [];

  if (
    data.liquidity_usd <
    MIN_LIQUIDITY_USD
  ) {
    reasons.push(
      "LOW_LIQUIDITY"
    );
  }

  if (
    data.volume_24h_usd <
    MIN_VOLUME_24H_USD
  ) {
    reasons.push(
      "LOW_24H_VOLUME"
    );
  }

  if (
    data.volume_1h_usd <
    MIN_VOLUME_1H_USD
  ) {
    reasons.push(
      "LOW_1H_VOLUME"
    );
  }

  if (
    data.pair_age_days >
    MAX_PAIR_AGE_DAYS
  ) {
    reasons.push(
      "OLD_PAIR"
    );
  }

  if (
    data.price_usd <
    MIN_TOKEN_PRICE_USD
  ) {
    reasons.push(
      "INVALID_PRICE"
    );
  }

  /*
    Hard hourly sell-pressure rule.
  */
  if (
    data.sells_1h > 0 &&
    data.buys_1h <
      data.sells_1h *
        0.70
  ) {
    reasons.push(
      "SELL_PRESSURE"
    );
  }

  /*
    Strong negative short-term momentum
    while the hourly trend is already negative.
  */
  if (
    data.price_change_5m <
      -2 &&
    data.price_change_1h <
      0
  ) {
    reasons.push(
      "NEGATIVE_MOMENTUM"
    );
  }

  /*
    Extremely dangerous short-term reversal.
  */
  if (
    data.price_change_5m <=
      -6
  ) {
    reasons.push(
      "SEVERE_5M_DECLINE"
    );
  }

  return {
    pass:
      reasons.length === 0,

    reasons
  };
}

/*
  ============================================================
  ENTRY QUALITY
  ============================================================
*/

function evaluateEntryQuality(
  data,
  score,
  marketShape,
  risk
) {
  const reasons = [];

  /*
    Must pass basic risk.
  */
  if (
    !risk.pass
  ) {
    reasons.push(
      ...risk.reasons
    );
  }

  /*
    Minimum overall score.
  */
  if (
    score.total <
    MIN_ENTRY_SCORE
  ) {
    reasons.push(
      "BELOW_ENTRY_SCORE"
    );
  }

  /*
    Need actual momentum.
  */
  if (
    score.momentum <
    MIN_MOMENTUM_SCORE
  ) {
    reasons.push(
      "WEAK_MOMENTUM"
    );
  }

  /*
    Don't enter when the market shape
    has accumulated too many warning points.
  */
  if (
    marketShape.penalty >=
    8
  ) {
    reasons.push(
      "BAD_MARKET_SHAPE"
    );
  }

  /*
    Avoid buying a token with strongly
    negative 6h momentum unless the overall
    structure is exceptionally strong.
  */
  if (
    data.price_change_6h <
      -20 &&
    score.momentum <
      12
  ) {
    reasons.push(
      "NEGATIVE_LONGER_TREND"
    );
  }

  /*
    If 5m selling dominates while the
    candidate is trying to enter, wait.
  */
  if (
    data.sells_5m >= 10 &&
    data.sells_5m >
      data.buys_5m * 1.50
  ) {
    reasons.push(
      "5M_ENTRY_SELL_PRESSURE"
    );
  }

  return {
    pass:
      reasons.length === 0,

    reasons
  };
}

/*
  ============================================================
  COMPLETE CANDIDATE SCORE
  ============================================================
*/

function scoreCandidate(
  data,
  jupiterData,
  geckoFound
) {
  const momentum =
    calculateMomentumScore(
      data
    );

  const volume =
    calculateVolumeScore(
      data
    );

  const liquidity =
    calculateLiquidityScore(
      data
    );

  const buyPressure =
    calculateBuyPressureScore(
      data
    );

  const acceleration =
    calculateAccelerationScore(
      data
    );

  const crossSource =
    calculateCrossSourceScore(
      jupiterData,
      geckoFound
    );

  const marketShape =
    analyzeMarketShape(
      data
    );

  const grossScore =
    momentum +
    volume +
    liquidity +
    buyPressure +
    acceleration +
    crossSource;

  const total =
    Math.max(
      0,
      Math.round(
        grossScore -
        marketShape.penalty
      )
    );

  return {
    total,

    gross_score:
      Math.round(
        grossScore
      ),

    momentum,

    volume,

    liquidity,

    buy_pressure:
      buyPressure,

    acceleration,

    cross_source:
      crossSource,

    penalties:
      marketShape.penalty,

    penalty_reasons:
      marketShape.reasons,

    jupiter_price_check:
      Boolean(
        jupiterData
      )
  };
}

/*
  ============================================================
  CANDIDATE SCANNER
  ============================================================
*/

async function scanCandidates(
  env
) {
  const scanStarted =
    Date.now();

  /*
    ----------------------------------------------------------
    SOURCE 1:
    DEX Screener discovery
    ----------------------------------------------------------
  */

  const dexDiscovery =
    await getDexScreenerDiscovery();

  /*
    ----------------------------------------------------------
    SOURCE 2:
    DEX Screener search
    ----------------------------------------------------------
  */

  const dexSearch =
    await getDexSearchCandidates();

  /*
    ----------------------------------------------------------
    COMBINE DISCOVERY
    ----------------------------------------------------------
  */

  const discoveryMap =
    new Map();

  for (
    const item of [
      ...dexDiscovery,
      ...dexSearch
    ]
  ) {
    if (
      !isValidMint(
        item.mint
      )
    ) {
      continue;
    }

    if (
      !discoveryMap.has(
        item.mint
      )
    ) {
      discoveryMap.set(
        item.mint,
        item
      );
    }
  }

  /*
    ----------------------------------------------------------
    SOURCE 3:
    GeckoTerminal
    ----------------------------------------------------------
  */

  const geckoPools =
    await getGeckoTrendingPools();

  const geckoMints =
    new Set();

  for (
    const pool of geckoPools
  ) {
    const mint =
      extractGeckoMint(
        pool.address
      );

    if (
      !isValidMint(mint)
    ) {
      continue;
    }

    geckoMints.add(
      mint
    );

    if (
      !discoveryMap.has(
        mint
      )
    ) {
      discoveryMap.set(
        mint,
        {
          mint,

          source:
            "GECKOTERMINAL"
        }
      );
    }
  }

  /*
    ----------------------------------------------------------
    HYDRATE MARKET DATA
    ----------------------------------------------------------
  */

  const dexPairs =
    await hydrateDexCandidates(
      [
        ...discoveryMap.values()
      ]
    );

  /*
    ----------------------------------------------------------
    UNIQUE MARKET MINTS
    ----------------------------------------------------------
  */

  const mints = [
    ...new Set(
      dexPairs
        .map(
          pair =>
            normalizeAddress(
              pair
                .baseToken
                ?.address
            )
        )
        .filter(
          isValidMint
        )
    )
  ];

  /*
    ----------------------------------------------------------
    JUPITER OPTIONAL CHECK
    ----------------------------------------------------------
  */

  const jupiter =
    await getJupiterCrossCheck(
      env,
      mints
    );

  /*
    ----------------------------------------------------------
    NORMALIZE + SCORE
    ----------------------------------------------------------
  */

  const candidates = [];

  for (
    const pair of dexPairs
  ) {
    const data =
      normalizeDexPair(
        pair
      );

    if (
      !isValidMint(
        data.mint
      )
    ) {
      continue;
    }

    if (
      isBlockedSymbol(
        data.symbol
      )
    ) {
      continue;
    }

    if (
      data.price_usd <=
      MIN_TOKEN_PRICE_USD
    ) {
      continue;
    }

    const marketShape =
      analyzeMarketShape(
        data
      );

    const risk =
      assessRisk(
        data,
        marketShape
      );

    const jupiterData =
      jupiter.data[
        data.mint
      ] ||
      null;

    const geckoFound =
      geckoMints.has(
        data.mint
      );

    const score =
      scoreCandidate(
        data,
        jupiterData,
        geckoFound
      );

    const entry =
      evaluateEntryQuality(
        data,
        score,
        marketShape,
        risk
      );

    candidates.push({
      ...data,

      score,

      entry_quality:
        entry.pass,

      entry_reasons:
        entry.reasons,

      market_shape:
        marketShape,

      risk,

      sources: {
        dexscreener:
          true,

        geckoterminal:
          geckoFound,

        jupiter_price:
          Boolean(
            jupiterData
          )
      },

      decision:
        entry.pass
          ? "PAPER_ELIGIBLE"
          : risk.pass
            ? "BELOW_ENTRY_SCORE"
            : "REJECTED"
    });
  }

  /*
    ----------------------------------------------------------
    SORT
    ----------------------------------------------------------
  */

  candidates.sort(
    (a, b) =>
      b.score.total -
      a.score.total
  );

  const eligible =
    candidates.filter(
      candidate =>
        candidate.entry_quality
    );

  /*
    ----------------------------------------------------------
    SCAN RESULT
    ----------------------------------------------------------
  */

  const result = {
    scanned_at:
      nowIso(),

    duration_ms:
      Date.now() -
      scanStarted,

    source_counts: {
      dexscreener_discovery:
        dexDiscovery.length,

      dexscreener_search:
        dexSearch.length,

      gecko_trending:
        geckoPools.length,

      gecko_confirmed_tokens:
        geckoMints.size,

      jupiter_price_checked:
        jupiter.checked,

      jupiter_price_confirmed:
        jupiter.confirmed,

      hydrated_pairs:
        dexPairs.length
    },

    total_candidates:
      candidates.length,

    risk_pass_candidates:
      candidates.filter(
        x =>
          x.risk.pass
      ).length,

    eligible_candidates:
      eligible.length,

    candidates:
      candidates
        .slice(
          0,
          MAX_CANDIDATES
        )
  };

  await env.BOT_KV.put(
    SCAN_KEY,
    JSON.stringify(
      result
    )
  );

  return result;
}

/*
  ============================================================
  POSITION PRICE
  ============================================================
*/

async function getTokenPriceFromDex(
  mint
) {
  try {
    const url =
      `${DEXSCREENER_API}` +
      `/tokens/v1/solana/` +
      mint;

    const pairs =
      await getJson(
        url
      );

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
  if (
    !PAPER_MODE
  ) {
    throw new Error(
      "Safety error: PAPER_MODE must remain true."
    );
  }

  if (
    portfolio.open_positions
      .length >=
    MAX_POSITIONS
  ) {
    return {
      opened:
        false,

      reason:
        "MAX_POSITIONS"
    };
  }

  const availableCash =
    portfolio.cash_usd -
    PAPER_MIN_CASH_RESERVE_USD;

  if (
    availableCash <= 0
  ) {
    return {
      opened:
        false,

      reason:
        "CASH_RESERVE"
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

  if (
    cost <= 0
  ) {
    return {
      opened:
        false,

      reason:
        "INSUFFICIENT_CASH"
    };
  }

  const price =
    safeNumber(
      candidate.price_usd
    );

  if (
    price <= 0
  ) {
    return {
      opened:
        false,

      reason:
        "INVALID_PRICE"
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
      candidate.risk,

    entry_quality:
      candidate.entry_quality,

    entry_market_shape:
      candidate.market_shape
  };

  portfolio.cash_usd -=
    cost;

  portfolio.open_positions
    .push(
      position
    );

  await setCooldown(
    env,
    candidate.mint
  );

  await addHistory(
    env,
    {
      type:
        "PAPER_BUY",

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

      market_shape:
        candidate.market_shape,

      transaction:
        "SIMULATED — NO BLOCKCHAIN TRANSACTION"
    }
  );

  return {
    opened:
      true,

    position
  };
}

/*
  ============================================================
  POSITION MONITORING
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
      action:
        "HOLD",

      reason:
        "NO_PRICE"
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
    profit <=
    STOP_LOSS
  ) {
    return {
      action:
        "SELL",

      reason:
        "HARD_STOP",

      price,

      profit
    };
  }

  /*
    TRAILING ACTIVATION
  */
  if (
    highestProfit >=
    TRAILING_ACTIVATION
  ) {
    position.trailing_active =
      true;
  }

  /*
    TRAILING EXIT
  */
  if (
    position.trailing_active
  ) {
    const trailingFloor =
      position.highest_price_usd *
      (1 -
        TRAILING_STOP);

    if (
      price <=
      trailingFloor
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
        action:
          "SELL",

        reason:
          "TRAILING_EXIT",

        price,

        profit,

        trailing_floor:
          trailingFloor
      };
    }
  }

  return {
    action:
      "HOLD",

    reason:
      "NO_EXIT_SIGNAL",

    price,

    profit
  };
}

/*
  ============================================================
  CLOSE PAPER POSITION
  ============================================================
*/

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
        item.id !==
        position.id
    );

  await addHistory(
    env,
    {
      type:
        "PAPER_SELL",

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
          ? (
              pnl /
              position.cost_usd
            ) *
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

  /*
    IMPORTANT:
    Return is based on total portfolio value
    versus starting cash.

    This prevents the old incorrect percentage
    calculation.
  */
  portfolio.return_percent =
    portfolio.starting_cash_usd >
    0
      ? (
          (
            totalValue -
            portfolio.starting_cash_usd
          ) /
          portfolio.starting_cash_usd
        ) *
        100
      : 0;

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
  if (
    !PAPER_MODE
  ) {
    throw new Error(
      "SAFETY STOP: This version is PAPER ONLY."
    );
  }

  const portfolio =
    await getPortfolio(
      env
    );

  const actions = [];

  /*
    ----------------------------------------------------------
    STEP 1:
    MONITOR EXISTING POSITIONS
    ----------------------------------------------------------
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
      type:
        "POSITION",

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
      result.action ===
      "SELL"
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
    ----------------------------------------------------------
    STEP 2:
    SCAN MARKET
    ----------------------------------------------------------
  */

  const scan =
    await scanCandidates(
      env
    );

  /*
    ----------------------------------------------------------
    STEP 3:
    ONLY ENTRY-QUALITY CANDIDATES
    ----------------------------------------------------------
  */

  const eligible =
    scan.candidates.filter(
      candidate =>
        candidate.entry_quality
    );

  /*
    ----------------------------------------------------------
    DON'T BUY ALREADY-HELD TOKENS
    ----------------------------------------------------------
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

  let buysThisRun = 0;

  /*
    ----------------------------------------------------------
    PAPER ENTRY
    ----------------------------------------------------------
  */

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
      Safety check:
      Never bypass entry quality.
    */
    if (
      !candidate.entry_quality
    ) {
      continue;
    }

    if (
      candidate.score.total <
      MIN_ENTRY_SCORE
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
      type:
        "CANDIDATE",

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

      market_shape:
        candidate.market_shape,

      action:
        result.opened
          ? "PAPER_BUY"
          : "SKIP",

      reason:
        result.reason ||
        null
    });

    if (
      result.opened
    ) {
      buysThisRun += 1;
    }
  }

  /*
    ----------------------------------------------------------
    STEP 4:
    PORTFOLIO VALUE
    ----------------------------------------------------------
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
    ok:
      true,

    bot:
      BOT_NAME,

    mode: {
      type:
        "PAPER",

      real_money:
        false,

      live_trading:
        false,

      transaction_execution:
        false,

      wallet_signing:
        false,

      private_key_required:
        false
    },

    trigger:
      reason,

    scan: {
      candidates:
        scan.total_candidates,

      risk_pass:
        scan.risk_pass_candidates,

      eligible:
        scan.eligible_candidates,

      sources:
        scan.source_counts,

      top_candidates:
        scan.candidates
          .slice(
            0,
            5
          )
          .map(
            candidate => ({
              symbol:
                candidate.symbol,

              mint:
                candidate.mint,

              score:
                candidate.score.total,

              score_breakdown:
                candidate.score,

              entry_quality:
                candidate.entry_quality,

              entry_reasons:
                candidate.entry_reasons,

              liquidity_usd:
                candidate.liquidity_usd,

              volume_24h_usd:
                candidate.volume_24h_usd,

              volume_1h_usd:
                candidate.volume_1h_usd,

              volume_5m_usd:
                candidate.volume_5m_usd,

              price_change_5m:
                candidate.price_change_5m,

              price_change_1h:
                candidate.price_change_1h,

              price_change_6h:
                candidate.price_change_6h,

              buys_1h:
                candidate.buys_1h,

              sells_1h:
                candidate.sells_1h,

              buys_5m:
                candidate.buys_5m,

              sells_5m:
                candidate.sells_5m,

              sources:
                candidate.sources,

              market_shape:
                candidate.market_shape,

              risk:
                candidate.risk
            })
          )
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
    new URL(
      request.url
    );

  const path =
    url.pathname;

  /*
    ----------------------------------------------------------
    HOME
    ----------------------------------------------------------
  */

  if (
    path === "/"
  ) {
    return json({
      ok:
        true,

      bot:
        BOT_NAME,

      message:
        "memebott multi-source PAPER trading bot",

      mode: {
        type:
          "PAPER",

        real_money:
          false,

        live_trading:
          false,

        wallet_signing:
          false,

        transaction_execution:
          false
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
    ----------------------------------------------------------
    STATUS
    ----------------------------------------------------------
  */

  if (
    path === "/status"
  ) {
    const portfolio =
      await getPortfolio(
        env
      );

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
      ok:
        true,

      bot:
        BOT_NAME,

      mode: {
        type:
          "PAPER",

        real_money:
          false,

        live_trading:
          false,

        transaction_execution:
          false,

        wallet_signing:
          false,

        private_key_required:
          false
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
          MIN_VOLUME_1H_USD,

        minimum_entry_score:
          MIN_ENTRY_SCORE,

        extreme_1h_move_percent:
          EXTREME_1H_MOVE_PERCENT,

        strong_negative_6h_percent:
          STRONG_NEGATIVE_6H_PERCENT
      },

      positions:
        portfolio.open_positions
    });
  }

  /*
    ----------------------------------------------------------
    SCAN
    ----------------------------------------------------------
  */

  if (
    path === "/scan"
  ) {
    const scan =
      await scanCandidates(
        env
      );

    return json({
      ok:
        true,

      bot:
        BOT_NAME,

      mode:
        "PAPER",

      scan
    });
  }

  /*
    ----------------------------------------------------------
    TEST
    ----------------------------------------------------------
  */

  if (
    path === "/test"
  ) {
    const scan =
      await scanCandidates(
        env
      );

    return json({
      ok:
        true,

      bot:
        BOT_NAME,

      mode: {
        type:
          "PAPER",

        transaction_execution:
          false
      },

      message:
        "Scanner test completed. No position was opened.",

      scan: {
        total_candidates:
          scan.total_candidates,

        risk_pass_candidates:
          scan.risk_pass_candidates,

        eligible_candidates:
          scan.eligible_candidates,

        source_counts:
          scan.source_counts,

        top_candidates:
          scan.candidates
            .slice(
              0,
              10
            )
            .map(
              candidate => ({
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

                entry_quality:
                  candidate.entry_quality,

                entry_reasons:
                  candidate.entry_reasons,

                liquidity_usd:
                  candidate.liquidity_usd,

                volume_24h_usd:
                  candidate.volume_24h_usd,

                volume_1h_usd:
                  candidate.volume_1h_usd,

                volume_5m_usd:
                  candidate.volume_5m_usd,

                price_change_5m:
                  candidate.price_change_5m,

                price_change_1h:
                  candidate.price_change_1h,

                price_change_6h:
                  candidate.price_change_6h,

                buys_1h:
                  candidate.buys_1h,

                sells_1h:
                  candidate.sells_1h,

                buys_5m:
                  candidate.buys_5m,

                sells_5m:
                  candidate.sells_5m,

                sources:
                  candidate.sources,

                market_shape:
                  candidate.market_shape,

                risk:
                  candidate.risk,

                decision:
                  candidate.decision
              })
            )
      }
    });
  }

  /*
    ----------------------------------------------------------
    RUN
    ----------------------------------------------------------
  */

  if (
    path === "/run"
  ) {
    const result =
      await runBot(
        env,
        "manual"
      );

    return json(
      result
    );
  }

  /*
    ----------------------------------------------------------
    TRADES
    ----------------------------------------------------------
  */

  if (
    path === "/trades"
  ) {
    const history =
      await getHistory(
        env
      );

    return json({
      ok:
        true,

      bot:
        BOT_NAME,

      mode:
        "PAPER",

      count:
        history.length,

      trades:
        history
    });
  }

  /*
    ----------------------------------------------------------
    RESET PAPER ACCOUNT
    ----------------------------------------------------------
  */

  if (
    path ===
    "/reset-paper"
  ) {
    const confirm =
      url.searchParams.get(
        "confirm"
      );

    if (
      confirm !==
      "RESET"
    ) {
      return json(
        {
          ok:
            false,

          error:
            "Reset blocked. Use /reset-paper?confirm=RESET"
        },
        400
      );
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
      ok:
        true,

      message:
        "Paper account reset.",

      starting_cash_usd:
        PAPER_STARTING_CASH_USD
    });
  }

  /*
    ----------------------------------------------------------
    NOT FOUND
    ----------------------------------------------------------
  */

  return json(
    {
      ok:
        false,

      error:
        "Not found"
    },
    404
  );
}

/*
  ============================================================
  JSON RESPONSE
  ============================================================
*/

function json(
  data,
  status = 200
) {
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
    } catch (
      error
    ) {
      return json(
        {
          ok:
            false,

          bot:
            BOT_NAME,

          error:
            error?.message ||
            String(error),

          mode:
            "PAPER",

          safety:
            "No live transaction execution is implemented."
        },
        500
      );
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
