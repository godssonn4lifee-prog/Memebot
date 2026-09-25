const BOT_NAME = "memebott";

/*
  ============================================================
   MEMEBOTT — PAPER TRADING ONLY
  ============================================================

  Strategy revision:
  - Scanner still runs every minute.
  - KV persistence remains throttled.
  - Compact short-term candidate memory is maintained.
  - Historical observations help identify early momentum.
  - Existing safety filters remain intact.
  - Duplicate extreme 1h penalty removed.
  - No live transaction execution.
  - Discovery diagnostics enabled.
  - DexScreener batch hydration enabled.
  - Jupiter Price API v3 root-level response parsing fixed.
  - Liquidity-source diagnostics enabled.
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

/* ============================================================
   KV PROTECTION
   ============================================================ */

const MIN_PERSIST_INTERVAL_SECONDS = 120;
const CHECKPOINT_INTERVAL_SECONDS = 300;

/* ============================================================
   CANDIDATE MEMORY
   ============================================================ */

const MAX_MEMORY_CANDIDATES = 12;
const MAX_MEMORY_OBSERVATIONS = 4;
const MIN_HISTORY_OBSERVATIONS = 2;

/* ============================================================
   PROGRESSIVE PAPER POSITION SIZING
   ============================================================ */

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

const MIN_ENTRY_SCORE = 45;
const MIN_MOMENTUM_SCORE = 5;
const MIN_SETUP_SCORE = 5;
const MAX_HISTORICAL_SETUP_BONUS = 15;

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
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";

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

function errorText(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

function cloneObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }

  Object.assign(target, snapshot);
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

async function fetchJsonDiagnostic(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.headers || {})
      }
    });

    const status = response.status;

    if (!response.ok) {
      let bodyText = "";

      try {
        bodyText = await response.text();
      } catch {
        bodyText = "";
      }

      return {
        ok: false,
        status,
        data: null,
        error:
          `HTTP ${status}` +
          (
            bodyText
              ? `: ${bodyText.slice(0, 500)}`
              : ""
          )
      };
    }

    try {
      const data = await response.json();

      return {
        ok: true,
        status,
        data,
        error: null
      };
    } catch (error) {
      return {
        ok: false,
        status,
        data: null,
        error:
          `INVALID_JSON_RESPONSE: ${errorText(error)}`
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      data: null,
      error:
        `FETCH_EXCEPTION: ${errorText(error)}`
    };
  }
}

function responseShape(value) {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "object") {
    return "object";
  }

  return typeof value;
}

/* ============================================================
   PAPER PORTFOLIO
   ============================================================ */

function createEmptyPortfolio() {
  return {
    schema_version: PAPER_SCHEMA_VERSION,

    starting_cash_usd:
      STARTING_CASH_USD,

    cash_usd:
      STARTING_CASH_USD,

    realized_pnl_usd: 0,

    positions: [],

    history: [],

    cooldowns: {},

    market_memory: {},

    created_at:
      nowIso(),

    updated_at:
      nowIso(),

    last_persist_at:
      0,

    last_persist_reason:
      null
  };
}

async function loadPortfolio(env) {
  const raw =
    await env.BOT_KV.get(
      "PAPER_PORTFOLIO"
    );

  if (!raw) {
    return createEmptyPortfolio();
  }

  try {
    const portfolio =
      JSON.parse(raw);

    if (
      safeNumber(
        portfolio.schema_version
      ) !== PAPER_SCHEMA_VERSION
    ) {
      return createEmptyPortfolio();
    }

    portfolio.positions ||= [];
    portfolio.history ||= [];
    portfolio.cooldowns ||= {};
    portfolio.market_memory ||= {};

    portfolio.cash_usd =
      safeNumber(
        portfolio.cash_usd,
        STARTING_CASH_USD
      );

    portfolio.realized_pnl_usd =
      safeNumber(
        portfolio.realized_pnl_usd
      );

    portfolio.last_persist_at =
      safeNumber(
        portfolio.last_persist_at
      );

    portfolio.last_persist_reason ||=
      null;

    delete portfolio.last_scan;

    cleanupMarketMemory(
      portfolio
    );

    return portfolio;
  } catch {
    return createEmptyPortfolio();
  }
}

/* ============================================================
   PERSISTENCE CONTROL
   ============================================================ */

function persistenceAgeMs(portfolio) {
  const last =
    safeNumber(
      portfolio.last_persist_at
    );

  if (!last) {
    return Infinity;
  }

  return Date.now() - last;
}

function canPersistNow(portfolio) {
  return (
    persistenceAgeMs(portfolio) >=
    MIN_PERSIST_INTERVAL_SECONDS * 1000
  );
}

function checkpointDue(portfolio) {
  return (
    persistenceAgeMs(portfolio) >=
    CHECKPOINT_INTERVAL_SECONDS * 1000
  );
}

async function savePortfolio(
  env,
  portfolio,
  reason = "UNKNOWN",
  options = {}
) {
  const force =
    options.force === true;

  if (
    !force &&
    !canPersistNow(portfolio)
  ) {
    return {
      saved: false,
      throttled: true,
      reason
    };
  }

  const persistedAt =
    Date.now();

  const payload =
    cloneObject(portfolio);

  delete payload.last_scan;

  payload.updated_at =
    new Date(
      persistedAt
    ).toISOString();

  payload.last_persist_at =
    persistedAt;

  payload.last_persist_reason =
    reason;

  await env.BOT_KV.put(
    "PAPER_PORTFOLIO",
    JSON.stringify(payload)
  );

  portfolio.updated_at =
    payload.updated_at;

  portfolio.last_persist_at =
    persistedAt;

  portfolio.last_persist_reason =
    reason;

  delete portfolio.last_scan;

  return {
    saved: true,
    throttled: false,
    reason,
    time:
      payload.updated_at
  };
}

/* ============================================================
   HISTORY
   ============================================================ */

function addHistory(
  portfolio,
  event
) {
  portfolio.history.push({
    time: nowIso(),
    ...event
  });

  if (
    portfolio.history.length >
    500
  ) {
    portfolio.history =
      portfolio.history.slice(-500);
  }
}

/* ============================================================
   POSITION SIZE
   ============================================================ */

function getPositionSize(equity) {
  let amount =
    POSITION_SIZE_TIERS[0].amount;

  for (
    const tier of
    POSITION_SIZE_TIERS
  ) {
    if (
      equity >= tier.equity
    ) {
      amount =
        tier.amount;
    }
  }

  return Math.min(
    amount,
    MAX_PAPER_POSITION_USD
  );
}

/* ============================================================
   DISCOVERY DIAGNOSTICS
   ============================================================ */

function createDiscoveryDiagnostics() {
  return {
    dexscreener_profiles: {
      attempted: true,
      http_status: null,
      response_shape: null,
      total_items: 0,
      solana_items: 0,
      extracted_mints: 0,
      error: null,
      sample: []
    },

    dexscreener_boosts: {
      attempted: true,
      http_status: null,
      response_shape: null,
      total_items: 0,
      solana_items: 0,
      extracted_mints: 0,
      error: null,
      sample: []
    },

    dexscreener_top_boosts: {
      attempted: true,
      http_status: null,
      response_shape: null,
      total_items: 0,
      solana_items: 0,
      extracted_mints: 0,
      error: null,
      sample: []
    },

    dexscreener_search: {
      attempted: 0,
      queries: {},
      total_pairs: 0,
      solana_pairs: 0,
      extracted_mints: 0,
      errors: []
    },

    gecko_trending: {
      attempted: true,
      http_status: null,
      response_shape: null,
      pool_count: 0,
      tokens_extracted: 0,
      error: null,
      sample: []
    },

    gecko_top_pools: {
      attempted: true,
      http_status: null,
      response_shape: null,
      pool_count: 0,
      tokens_extracted: 0,
      error: null,
      sample: []
    },

    gecko_new_pools: {
      attempted: true,
      http_status: null,
      response_shape: null,
      pool_count: 0,
      tokens_extracted: 0,
      error: null,
      sample: []
    }
  };
}

function discoveryItemSample(item) {
  return {
    chain_id:
      item?.chainId ||
      null,

    token_address:
      item?.tokenAddress ||
      item?.address ||
      null,

    symbol:
      item?.symbol ||
      item?.baseToken?.symbol ||
      null,

    name:
      item?.name ||
      item?.baseToken?.name ||
      null
  };
}

/* ============================================================
   DEXSCREENER DISCOVERY
   ============================================================ */

async function getDexDiscovery() {
  const diagnostics =
    createDiscoveryDiagnostics();

  const endpoints = [
    {
      key:
        "dexscreener_profiles",

      url:
        `${DEX_BASE}/token-profiles/latest/v1`
    },

    {
      key:
        "dexscreener_boosts",

      url:
        `${DEX_BASE}/token-boosts/latest/v1`
    },

    {
      key:
        "dexscreener_top_boosts",

      url:
        `${DEX_BASE}/token-boosts/top/v1`
    }
  ];

  const results = [];

  for (
    const endpoint of
    endpoints
  ) {
    const result =
      await fetchJsonDiagnostic(
        endpoint.url
      );

    const diagnostic =
      diagnostics[
        endpoint.key
      ];

    diagnostic.http_status =
      result.status;

    if (!result.ok) {
      diagnostic.error =
        result.error;

      continue;
    }

    diagnostic.response_shape =
      responseShape(
        result.data
      );

    if (
      !Array.isArray(
        result.data
      )
    ) {
      diagnostic.error =
        "EXPECTED_ARRAY_RESPONSE";

      continue;
    }

    diagnostic.total_items =
      result.data.length;

    diagnostic.sample =
      result.data
        .slice(0, 5)
        .map(
          discoveryItemSample
        );

    for (
      const item of
      result.data
    ) {
      const chainId =
        String(
          item?.chainId ||
          ""
        ).toLowerCase();

      if (
        chainId !==
        "solana"
      ) {
        continue;
      }

      diagnostic.solana_items++;

      const mint =
        item?.tokenAddress ||
        item?.address;

      if (!mint) {
        continue;
      }

      diagnostic.extracted_mints++;

      results.push({
        mint,

        source:
          endpoint.key ===
          "dexscreener_top_boosts"
            ? "DEXSCREENER_TOP_BOOSTS"
            : endpoint.key ===
              "dexscreener_boosts"
              ? "DEXSCREENER_BOOSTS"
              : "DEXSCREENER"
      });
    }
  }

  return {
    results:
      results.slice(
        0,
        MAX_DEX_TOKENS_ANALYZED
      ),

    diagnostics
  };
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

  const diagnostics =
    createDiscoveryDiagnostics()
      .dexscreener_search;

  for (
    const query of
    queries
  ) {
    diagnostics.attempted++;

    const queryDiagnostic = {
      attempted: true,
      http_status: null,
      response_shape: null,
      total_pairs: 0,
      solana_pairs: 0,
      extracted_mints: 0,
      error: null,
      sample: []
    };

    diagnostics.queries[
      query
    ] =
      queryDiagnostic;

    const result =
      await fetchJsonDiagnostic(
        `${DEX_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`
      );

    queryDiagnostic.http_status =
      result.status;

    if (!result.ok) {
      queryDiagnostic.error =
        result.error;

      diagnostics.errors.push({
        query,
        error:
          result.error
      });

      continue;
    }

    queryDiagnostic.response_shape =
      responseShape(
        result.data
      );

    const pairs =
      Array.isArray(
        result.data?.pairs
      )
        ? result.data.pairs
        : null;

    if (!pairs) {
      queryDiagnostic.error =
        "EXPECTED_OBJECT_WITH_PAIRS_ARRAY";

      diagnostics.errors.push({
        query,
        error:
          queryDiagnostic.error
      });

      continue;
    }

    queryDiagnostic.total_pairs =
      pairs.length;

    diagnostics.total_pairs +=
      pairs.length;

    queryDiagnostic.sample =
      pairs
        .slice(0, 5)
        .map(
          pair => ({
            chain_id:
              pair?.chainId ||
              null,

            dex_id:
              pair?.dexId ||
              null,

            pair_address:
              pair?.pairAddress ||
              null,

            base_symbol:
              pair?.baseToken?.symbol ||
              null,

            base_address:
              pair?.baseToken?.address ||
              null,

            price_usd:
              pair?.priceUsd ||
              null,

            liquidity_usd:
              pair?.liquidity?.usd ??
              null
          })
        );

    for (
      const pair of
      pairs
    ) {
      if (
        String(
          pair?.chainId ||
          ""
        ).toLowerCase() !==
        "solana"
      ) {
        continue;
      }

      queryDiagnostic.solana_pairs++;
      diagnostics.solana_pairs++;

      const mint =
        pair?.baseToken?.address;

      if (!mint) {
        continue;
      }

      queryDiagnostic.extracted_mints++;
      diagnostics.extracted_mints++;

      results.push({
        mint,

        source:
          "DEXSCREENER_SEARCH"
      });
    }
  }

  return {
    results:
      results.slice(
        0,
        MAX_DEX_TOKENS_ANALYZED
      ),

    diagnostics
  };
}

/* ============================================================
   GECKO HELPERS
   ============================================================ */

function extractGeckoMint(item) {
  const id =
    item?.relationships
      ?.base_token
      ?.data
      ?.id;

  if (id) {
    return String(id)
      .replace(
        /^solana_/,
        ""
      );
  }

  const directAddress =
    item?.attributes?.address ||
    item?.address;

  if (
    directAddress
  ) {
    return String(
      directAddress
    );
  }

  return null;
}

function geckoPoolSample(item) {
  return {
    id:
      item?.id ||
      null,

    type:
      item?.type ||
      null,

    address:
      item?.attributes?.address ||
      null,

    name:
      item?.attributes?.name ||
      null,

    base_token_price_usd:
      item?.attributes
        ?.base_token_price_usd ||
      null,

    reserve_usd:
      item?.attributes
        ?.reserve_in_usd ||
      null
  };
}

/* ============================================================
   GECKOTERMINAL DISCOVERY
   ============================================================ */

async function getGeckoCandidates() {
  const mints =
    new Set();

  const diagnostics =
    createDiscoveryDiagnostics();

  async function readGeckoEndpoint(
    key,
    url
  ) {
    const diagnostic =
      diagnostics[key];

    const result =
      await fetchJsonDiagnostic(
        url,
        {
          headers: {
            accept:
              "application/json;version=20230203"
          }
        }
      );

    diagnostic.http_status =
      result.status;

    if (!result.ok) {
      diagnostic.error =
        result.error;

      return;
    }

    diagnostic.response_shape =
      responseShape(
        result.data
      );

    const items =
      Array.isArray(
        result.data?.data
      )
        ? result.data.data
        : null;

    if (!items) {
      diagnostic.error =
        "EXPECTED_OBJECT_WITH_DATA_ARRAY";

      return;
    }

    diagnostic.pool_count =
      items.length;

    diagnostic.sample =
      items
        .slice(0, 5)
        .map(
          geckoPoolSample
        );

    for (
      const item of
      items
    ) {
      const mint =
        extractGeckoMint(
          item
        );

      if (!mint) {
        continue;
      }

      diagnostic.tokens_extracted++;

      mints.add(
        mint
      );
    }
  }

  /*
    Gecko's public API is rate-limited, so use trending first.
    Only fall back when it produced no usable token addresses.
  */
  await readGeckoEndpoint(
    "gecko_trending",
    `${GECKO_BASE}/networks/solana/trending_pools?page=1`
  );

  if (
    mints.size === 0
  ) {
    await readGeckoEndpoint(
      "gecko_top_pools",
      `${GECKO_BASE}/networks/solana/pools?page=1&include=base_token`
    );
  }

  if (
    mints.size === 0
  ) {
    await readGeckoEndpoint(
      "gecko_new_pools",
      `${GECKO_BASE}/networks/solana/new_pools?page=1&include=base_token`
    );
  }

  return {
    mints: [
      ...mints
    ].slice(
      0,
      MAX_GECKO_POOLS_ANALYZED
    ),

    diagnostics
  };
}

/* ============================================================
   BEST DEX PAIR — LIQUIDITY DIAGNOSTIC VERSION
   ============================================================ */

function summarizeDexPair(
  pair,
  index
) {
  const hasLiquidityField =
    !!(
      pair &&
      pair.liquidity &&
      Object.prototype.hasOwnProperty.call(
        pair.liquidity,
        "usd"
      )
    );

  const rawLiquidity =
    hasLiquidityField
      ? pair.liquidity.usd
      : null;

  const normalizedLiquidity =
    safeNumber(
      rawLiquidity,
      0
    );

  return {
    rank:
      index + 1,

    pair_address:
      pair?.pairAddress ||
      null,

    dex_id:
      pair?.dexId ||
      null,

    url:
      pair?.url ||
      null,

    base_symbol:
      pair?.baseToken?.symbol ||
      null,

    quote_symbol:
      pair?.quoteToken?.symbol ||
      null,

    liquidity_field_present:
      hasLiquidityField,

    liquidity_raw:
      rawLiquidity,

    liquidity_usd:
      normalizedLiquidity,

    volume_24h_raw:
      pair?.volume?.h24 ??
      null,

    volume_1h_raw:
      pair?.volume?.h1 ??
      null,

    price_usd_raw:
      pair?.priceUsd ??
      null,

    pair_created_at:
      pair?.pairCreatedAt ??
      null
  };
}

/* ============================================================
   BATCH DEXSCREENER HYDRATION
   ============================================================ */

async function hydrateDexPairs(
  mints
) {
  const pairsByMint =
    new Map();

  const diagnostics = {
    attempted:
      mints.length,

    http_status:
      null,

    response_shape:
      null,

    requested_mints:
      mints.length,

    returned_pairs:
      0,

    solana_pairs:
      0,

    error:
      null
  };

  if (!mints.length) {
    return {
      pairsByMint,
      diagnostics
    };
  }

  const url =
    `${DEX_BASE}/tokens/v1/solana/${mints
      .slice(
        0,
        30
      )
      .map(
        encodeURIComponent
      )
      .join(",")}`;

  const result =
    await fetchJsonDiagnostic(
      url
    );

  diagnostics.http_status =
    result.status;

  if (!result.ok) {
    diagnostics.error =
      result.error;

    return {
      pairsByMint,
      diagnostics
    };
  }

  diagnostics.response_shape =
    responseShape(
      result.data
    );

  if (
    !Array.isArray(
      result.data
    )
  ) {
    diagnostics.error =
      "EXPECTED_ARRAY_RESPONSE";

    return {
      pairsByMint,
      diagnostics
    };
  }

  diagnostics.returned_pairs =
    result.data.length;

  for (
    const pair of
    result.data
  ) {
    if (
      String(
        pair?.chainId ||
        ""
      ).toLowerCase() !==
      "solana"
    ) {
      continue;
    }

    diagnostics.solana_pairs++;

    const mint =
      pair?.baseToken?.address;

    if (!mint) {
      continue;
    }

    if (
      !pairsByMint.has(
        mint
      )
    ) {
      pairsByMint.set(
        mint,
        []
      );
    }

    pairsByMint
      .get(mint)
      .push(pair);
  }

  return {
    pairsByMint,
    diagnostics
  };
}

/* ============================================================
   SELECT BEST PAIR FROM BATCH DATA
   ============================================================ */

function selectBestDexPair(
  mint,
  allPairs
) {
  const solanaPairs =
    allPairs.filter(
      pair =>
        String(
          pair?.chainId ||
          ""
        ).toLowerCase() ===
        "solana"
    );

  if (
    solanaPairs.length === 0
  ) {
    return {
      pair: null,

      diagnostic: {
        mint,

        status:
          "NO_SOLANA_PAIRS",

        total_pairs:
          allPairs.length,

        solana_pairs:
          0,

        error:
          "NO_SOLANA_PAIRS"
      }
    };
  }

  const rankedPairs =
    [...solanaPairs].sort(
      (a, b) => {
        const liquidityDifference =
          safeNumber(
            b?.liquidity?.usd,
            0
          ) -
          safeNumber(
            a?.liquidity?.usd,
            0
          );

        if (
          liquidityDifference !== 0
        ) {
          return liquidityDifference;
        }

        return (
          safeNumber(
            b?.volume?.h24,
            0
          ) -
          safeNumber(
            a?.volume?.h24,
            0
          )
        );
      }
    );

  const selectedPair =
    rankedPairs[0];

  const selectedIndex =
    rankedPairs.indexOf(
      selectedPair
    );

  const selectedLiquidityFieldPresent =
    !!(
      selectedPair?.liquidity &&
      Object.prototype.hasOwnProperty.call(
        selectedPair.liquidity,
        "usd"
      )
    );

  const selectedRawLiquidity =
    selectedLiquidityFieldPresent
      ? selectedPair.liquidity.usd
      : null;

  const selectedLiquidity =
    safeNumber(
      selectedRawLiquidity,
      0
    );

  const zeroLiquidityCount =
    solanaPairs.filter(
      pair =>
        safeNumber(
          pair?.liquidity?.usd,
          0
        ) === 0
    ).length;

  const missingLiquidityCount =
    solanaPairs.filter(
      pair =>
        !pair?.liquidity ||
        !Object.prototype.hasOwnProperty.call(
          pair.liquidity,
          "usd"
        )
    ).length;

  const positiveLiquidityCount =
    solanaPairs.filter(
      pair =>
        safeNumber(
          pair?.liquidity?.usd,
          0
        ) > 0
    ).length;

  const topPairs =
    rankedPairs
      .slice(0, 5)
      .map(
        summarizeDexPair
      );

  let liquiditySource =
    "DEXSCREENER_LIQUIDITY_USD";

  if (
    !selectedLiquidityFieldPresent
  ) {
    liquiditySource =
      "DEXSCREENER_LIQUIDITY_FIELD_MISSING";
  } else if (
    selectedLiquidity <= 0
  ) {
    liquiditySource =
      "DEXSCREENER_LIQUIDITY_USD_ZERO";
  }

  let selectionReason =
    "HIGHEST_LIQUIDITY";

  if (
    selectedLiquidity <= 0 &&
    positiveLiquidityCount === 0 &&
    solanaPairs.length > 1
  ) {
    selectionReason =
      "ALL_SOLANA_PAIRS_ZERO_OR_MISSING_LIQUIDITY";
  } else if (
    selectedLiquidity <= 0 &&
    positiveLiquidityCount > 0
  ) {
    selectionReason =
      "SELECTED_ZERO_LIQUIDITY_DESPITE_POSITIVE_ALTERNATIVE";
  } else if (
    selectedLiquidity > 0 &&
    selectedIndex > 0
  ) {
    selectionReason =
      "SELECTED_BY_LIQUIDITY_RANKING";
  }

  return {
    pair:
      selectedPair,

    diagnostic: {
      mint,

      status:
        "HYDRATION_SUCCESS",

      total_pairs:
        allPairs.length,

      solana_pairs:
        solanaPairs.length,

      positive_liquidity_pairs:
        positiveLiquidityCount,

      zero_liquidity_pairs:
        zeroLiquidityCount,

      missing_liquidity_pairs:
        missingLiquidityCount,

      selected_pair_rank:
        selectedIndex + 1,

      selected_pair_address:
        selectedPair?.pairAddress ||
        null,

      selected_dex_id:
        selectedPair?.dexId ||
        null,

      selected_pair_url:
        selectedPair?.url ||
        null,

      selected_base_symbol:
        selectedPair?.baseToken?.symbol ||
        null,

      selected_quote_symbol:
        selectedPair?.quoteToken?.symbol ||
        null,

      selected_liquidity_raw:
        selectedRawLiquidity,

      selected_liquidity_usd:
        selectedLiquidity,

      selected_liquidity_field_present:
        selectedLiquidityFieldPresent,

      selected_liquidity_source:
        liquiditySource,

      selected_volume_24h_raw:
        selectedPair?.volume?.h24 ??
        null,

      selected_volume_1h_raw:
        selectedPair?.volume?.h1 ??
        null,

      selected_price_usd_raw:
        selectedPair?.priceUsd ??
        null,

      selection_reason:
        selectionReason,

      top_pairs:
        topPairs
    }
  };
}

/* ============================================================
   NORMALIZE DEX DATA
   ============================================================ */

function normalizeDexPair(
  pair,
  mint,
  pairDiagnostic = null
) {
  if (!pair) {
    return null;
  }

  const liquidityFieldPresent =
    !!(
      pair.liquidity &&
      Object.prototype.hasOwnProperty.call(
        pair.liquidity,
        "usd"
      )
    );

  const rawLiquidity =
    liquidityFieldPresent
      ? pair.liquidity.usd
      : null;

  const price =
    safeNumber(
      pair.priceUsd
    );

  const liquidity =
    safeNumber(
      rawLiquidity
    );

  const volume24h =
    safeNumber(
      pair.volume?.h24
    );

  const volume1h =
    safeNumber(
      pair.volume?.h1
    );

  const tx5m =
    pair.txns?.m5 || {};

  const tx1h =
    pair.txns?.h1 || {};

  const buys5m =
    safeNumber(
      tx5m.buys
    );

  const sells5m =
    safeNumber(
      tx5m.sells
    );

  const buys1h =
    safeNumber(
      tx1h.buys
    );

  const sells1h =
    safeNumber(
      tx1h.sells
    );

  const total5m =
    buys5m +
    sells5m;

  const total1h =
    buys1h +
    sells1h;

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
    safeNumber(
      pair.pairCreatedAt
    );

  let ageDays = null;

  if (createdAt > 0) {
    ageDays =
      (
        Date.now() -
        createdAt
      ) /
      86400000;
  }

  const priceChange =
    pair.priceChange || {};

  let liquiditySource =
    "DEXSCREENER_LIQUIDITY_USD";

  if (
    !liquidityFieldPresent
  ) {
    liquiditySource =
      "DEXSCREENER_LIQUIDITY_FIELD_MISSING";
  } else if (
    liquidity <= 0
  ) {
    liquiditySource =
      "DEXSCREENER_LIQUIDITY_USD_ZERO";
  }

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

    liquidity_usd:
      liquidity,

    liquidity_raw:
      rawLiquidity,

    liquidity_field_present:
      liquidityFieldPresent,

    liquidity_source:
      liquiditySource,

    volume_24h_usd:
      volume24h,

    volume_1h_usd:
      volume1h,

    volume_24h_raw:
      pair.volume?.h24 ??
      null,

    volume_1h_raw:
      pair.volume?.h1 ??
      null,

    change_5m:
      safeNumber(
        priceChange.m5
      ) / 100,

    change_1h:
      safeNumber(
        priceChange.h1
      ) / 100,

    change_6h:
      safeNumber(
        priceChange.h6
      ) / 100,

    change_24h:
      safeNumber(
        priceChange.h24
      ) / 100,

    buys_5m:
      buys5m,

    sells_5m:
      sells5m,

    buys_1h:
      buys1h,

    sells_1h:
      sells1h,

    buy_pressure_5m:
      buyPressure5m,

    buy_pressure_1h:
      buyPressure1h,

    sell_ratio_5m:
      sellRatio5m,

    age_days:
      ageDays,

    pair_address:
      pair.pairAddress ||
      null,

    dex_id:
      pair.dexId ||
      null,

    url:
      pair.url ||
      null,

    pair_count:
      pairDiagnostic?.solana_pairs ||
      null,

    positive_liquidity_pair_count:
      pairDiagnostic?.positive_liquidity_pairs ||
      null,

    zero_liquidity_pair_count:
      pairDiagnostic?.zero_liquidity_pairs ||
      null,

    missing_liquidity_pair_count:
      pairDiagnostic?.missing_liquidity_pairs ||
      null,

    selected_pair_rank:
      pairDiagnostic?.selected_pair_rank ||
      null,

    liquidity_selection_reason:
      pairDiagnostic?.selection_reason ||
      null
  };
}

/* ============================================================
   JUPITER SUPPLEMENTAL PRICE CHECK
   ============================================================ */

async function getJupiterPrices(
  mints,
  env
) {
  const prices =
    new Map();

  const diagnostics = {
    requested: 0,
    returned: 0,
    priced: 0,
    confirmed_candidates: 0,
    mismatched_prices: 0,

    missing_prices: [],
    invalid_prices: [],

    price_samples: [],
    mismatch_samples: [],

    error: null,
    http_status: null,
    request_url: null,

    response_shape:
      null,

    response_key_count:
      0,

    response_key_sample:
      [],

    root_level_response:
      false,

    nested_data_response:
      false
  };

  if (!mints.length) {
    return {
      prices,
      diagnostics
    };
  }

  const batch =
    mints.slice(
      0,
      MAX_JUPITER_PRICE_CHECKS
    );

  diagnostics.requested =
    batch.length;

  diagnostics.request_url =
    `${JUPITER_PRICE_API}?ids=${encodeURIComponent(
      batch.join(",")
    )}`;

  try {
    const headers = {};

    if (
      env.JUPITER_API_KEY
    ) {
      headers["x-api-key"] =
        env.JUPITER_API_KEY;
    }

    const result =
      await fetchJsonDiagnostic(
        diagnostics.request_url,
        {
          headers
        }
      );

    diagnostics.http_status =
      result.status;

    if (!result.ok) {
      diagnostics.error =
        result.error;

      return {
        prices,
        diagnostics
      };
    }

    const data =
      result.data;

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      diagnostics.response_shape =
        "INVALID_NON_OBJECT";

      diagnostics.error =
        "JUPITER_INVALID_RESPONSE_SHAPE";

      return {
        prices,
        diagnostics
      };
    }

    const rootKeys =
      Object.keys(data);

    diagnostics.response_key_count =
      rootKeys.length;

    diagnostics.response_key_sample =
      rootKeys.slice(0, 10);

    let priceData =
      data;

    diagnostics.root_level_response =
      true;

    diagnostics.response_shape =
      "ROOT_LEVEL_MINT_MAP";

    const rootHasPriceRecords =
      rootKeys.some(
        key =>
          data[key] &&
          typeof data[key] === "object" &&
          !Array.isArray(data[key]) &&
          (
            Object.prototype.hasOwnProperty.call(
              data[key],
              "usdPrice"
            ) ||
            Object.prototype.hasOwnProperty.call(
              data[key],
              "blockId"
            ) ||
            Object.prototype.hasOwnProperty.call(
              data[key],
              "decimals"
            )
          )
      );

    if (
      !rootHasPriceRecords &&
      data.data &&
      typeof data.data === "object" &&
      !Array.isArray(data.data)
    ) {
      priceData =
        data.data;

      diagnostics.root_level_response =
        false;

      diagnostics.nested_data_response =
        true;

      diagnostics.response_shape =
        "NESTED_DATA_MINT_MAP";

      const nestedKeys =
        Object.keys(
          priceData
        );

      diagnostics.response_key_count =
        nestedKeys.length;

      diagnostics.response_key_sample =
        nestedKeys.slice(
          0,
          10
        );
    }

    for (
      const mint of batch
    ) {
      const item =
        priceData[mint];

      if (!item) {
        diagnostics.missing_prices.push(
          mint
        );

        continue;
      }

      const price =
        safeNumber(
          item.usdPrice
        );

      if (
        price <= 0
      ) {
        diagnostics.invalid_prices.push(
          mint
        );

        continue;
      }

      prices.set(
        mint,
        price
      );

      diagnostics.returned++;
      diagnostics.priced++;

      if (
        diagnostics.price_samples.length < 10
      ) {
        diagnostics.price_samples.push({
          mint,
          usd_price:
            price
        });
      }
    }

    if (
      diagnostics.returned === 0 &&
      diagnostics.missing_prices.length ===
        batch.length
    ) {
      diagnostics.error =
        "JUPITER_RETURNED_200_BUT_NO_REQUESTED_MINTS_WERE_PRICED";
    }
  } catch (error) {
    diagnostics.error =
      errorText(error);
  }

  return {
    prices,
    diagnostics
  };
}

/* ============================================================
   JUPITER PRICE CONFIRMATION
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
      difference: null,
      status:
        "NO_JUPITER_PRICE"
    };
  }

  const difference =
    Math.abs(
      jupiterPrice -
      candidate.price
    ) /
    candidate.price;

  const confirmed =
    difference <= 0.15;

  return {
    confirmed,

    difference,

    status:
      confirmed
        ? "CONFIRMED"
        : "PRICE_MISMATCH"
  };
}

/* ============================================================
   MARKET SHAPE
   ============================================================ */

function analyzeMarketShape(
  candidate
) {
  const reasons = [];

  let penalty = 0;

  if (
    candidate.change_1h >=
    EXTREME_1H_MOVE
  ) {
    penalty += 10;

    reasons.push(
      "EXTREME_1H_MOVE"
    );
  }

  if (
    candidate.change_6h >=
    1.00
  ) {
    penalty += 8;

    reasons.push(
      "EXTREME_6H_MOVE"
    );
  }

  if (
    candidate.change_5m >=
    0.15
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

  if (
    candidate.change_5m >=
      BOUNCE_5M &&
    candidate.change_1h < 0
  ) {
    penalty -= 4;

    reasons.push(
      "BOUNCE_ATTEMPT"
    );
  }

  return {
    penalty:
      Math.max(
        0,
        penalty
      ),

    reasons
  };
}

/* ============================================================
   SCORE CANDIDATE
   ============================================================ */

function scoreCandidate(
  candidate
) {
  let score = 0;

  const breakdown = {};

  let momentum = 0;

  if (
    candidate.change_5m > 0
  ) {
    momentum += 5;
  }

  if (
    candidate.change_1h > 0
  ) {
    momentum += 5;
  }

  if (
    candidate.change_6h > 0
  ) {
    momentum += 5;
  }

  if (
    candidate.change_24h > 0
  ) {
    momentum += 5;
  }

  momentum =
    clamp(
      momentum,
      0,
      20
    );

  breakdown.momentum =
    momentum;

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

  volume =
    clamp(
      volume,
      0,
      17
    );

  breakdown.volume =
    volume;

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

  liquidity =
    clamp(
      liquidity,
      0,
      15
    );

  breakdown.liquidity =
    liquidity;

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

  buyPressure =
    clamp(
      buyPressure,
      0,
      15
    );

  breakdown.buy_pressure =
    buyPressure;

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

  acceleration =
    clamp(
      acceleration,
      0,
      9
    );

  breakdown.acceleration =
    acceleration;

  let crossSource = 0;

  if (
    candidate.dex_confirmed
  ) {
    crossSource += 5;
  }

  if (
    candidate.gecko_confirmed
  ) {
    crossSource += 3;
  }

  if (
    candidate.jupiter_confirmed
  ) {
    crossSource += 2;
  }

  crossSource =
    clamp(
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

  score =
    clamp(
      score,
      0,
      100
    );

  return {
    score:
      round(
        score,
        2
      ),

    momentum_score:
      round(
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
      candidate.change_1h >=
      0.25
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

function assessRisk(
  candidate
) {
  const reasons = [];

  if (
    !Number.isFinite(
      candidate.price
    ) ||
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

async function buildCandidates(
  env
) {
  const sourceCounts = {
    dexscreener_discovery: 0,
    dexscreener_search: 0,
    dexscreener_top_boosts: 0,

    gecko_trending: 0,
    gecko_confirmed_tokens: 0,

    jupiter_price_checked: 0,
    jupiter_price_confirmed: 0,

    hydrated_pairs: 0,

    gecko_tokens_received: 0,
    gecko_tokens_with_address: 0,

    gecko_hydration_attempts: 0,
    gecko_hydration_successes: 0,
    gecko_hydration_failures: 0,

    dex_pairs_returned: 0,
    dex_solana_pairs_returned: 0,

    dex_zero_liquidity_pairs: 0,
    dex_below_min_liquidity_pairs: 0
  };

  const hydrationDiagnostics = {
    attempted: 0,
    successes: 0,
    failures: 0,

    batch_requests: 0,
    batch_http_statuses: [],

    failure_reasons: {},
    samples: [],

    pairs_examined: 0,
    pairs_with_positive_liquidity: 0,
    pairs_with_zero_liquidity: 0,
    pairs_with_missing_liquidity: 0,

    zero_liquidity_samples: [],
    missing_liquidity_samples: [],

    selected_liquidity_sources: {},
    selected_pair_samples: []
  };

  const discoveryDiagnostics =
    createDiscoveryDiagnostics();

  /* ==========================================================
     DISCOVERY
     ========================================================== */

  const dexDiscoveryResult =
    await getDexDiscovery();

  Object.assign(
    discoveryDiagnostics.dexscreener_profiles,
    dexDiscoveryResult.diagnostics.dexscreener_profiles
  );

  Object.assign(
    discoveryDiagnostics.dexscreener_boosts,
    dexDiscoveryResult.diagnostics.dexscreener_boosts
  );

  Object.assign(
    discoveryDiagnostics.dexscreener_top_boosts,
    dexDiscoveryResult.diagnostics.dexscreener_top_boosts
  );

  const dexDiscovery =
    dexDiscoveryResult.results;

  sourceCounts.dexscreener_discovery =
    dexDiscovery.filter(
      item =>
        item.source ===
        "DEXSCREENER"
    ).length;

  sourceCounts.dexscreener_top_boosts =
    dexDiscovery.filter(
      item =>
        item.source ===
        "DEXSCREENER_TOP_BOOSTS"
    ).length;

  const dexSearchResult =
    await getDexSearch();

  discoveryDiagnostics.dexscreener_search =
    dexSearchResult.diagnostics;

  const dexSearch =
    dexSearchResult.results;

  sourceCounts.dexscreener_search =
    dexSearch.length;

  const geckoResult =
    await getGeckoCandidates();

  discoveryDiagnostics.gecko_trending =
    geckoResult.diagnostics.gecko_trending;

  discoveryDiagnostics.gecko_top_pools =
    geckoResult.diagnostics.gecko_top_pools;

  discoveryDiagnostics.gecko_new_pools =
    geckoResult.diagnostics.gecko_new_pools;

  const geckoMints =
    geckoResult.mints;

  sourceCounts.gecko_trending =
    discoveryDiagnostics.gecko_trending
      .tokens_extracted;

  sourceCounts.gecko_confirmed_tokens =
    geckoMints.length;

  sourceCounts.gecko_tokens_received =
    geckoMints.length;

  sourceCounts.gecko_tokens_with_address =
    geckoMints.filter(Boolean).length;

  /* ==========================================================
     COMBINE / DEDUPE
     ========================================================== */

  const combined = [
    ...dexDiscovery,
    ...dexSearch,
    ...geckoMints.map(
      mint => ({
        mint,
        source:
          "GECKOTERMINAL"
      })
    )
  ];

  const limited = [];

  const seen =
    new Set();

  for (
    const item of
    combined
  ) {
    if (!item.mint) {
      continue;
    }

    if (
      seen.has(
        item.mint
      )
    ) {
      continue;
    }

    seen.add(
      item.mint
    );

    limited.push(
      item
    );

    if (
      limited.length >=
      MAX_CANDIDATES
    ) {
      break;
    }
  }

  /* ==========================================================
     BATCH HYDRATION
     ========================================================== */

  const hydrationMints =
    limited.map(
      item =>
        item.mint
    );

  const batchResults = [];

  for (
    let offset = 0;
    offset < hydrationMints.length;
    offset += 30
  ) {
    const batch =
      hydrationMints.slice(
        offset,
        offset + 30
      );

    if (!batch.length) {
      continue;
    }

    hydrationDiagnostics.batch_requests++;

    const result =
      await hydrateDexPairs(
        batch
      );

    hydrationDiagnostics.batch_http_statuses.push({
      batch:
        hydrationDiagnostics.batch_requests,

      requested:
        batch.length,

      http_status:
        result.diagnostics.http_status,

      returned_pairs:
        result.diagnostics.returned_pairs,

      solana_pairs:
        result.diagnostics.solana_pairs,

      error:
        result.diagnostics.error
    });

    sourceCounts.dex_pairs_returned +=
      result.diagnostics.returned_pairs;

    sourceCounts.dex_solana_pairs_returned +=
      result.diagnostics.solana_pairs;

    batchResults.push(
      result
    );
  }

  const pairsByMint =
    new Map();

  for (
    const batchResult of
    batchResults
  ) {
    for (
      const [
        mint,
        pairs
      ] of
      batchResult.pairsByMint
    ) {
      pairsByMint.set(
        mint,
        pairs
      );
    }
  }

  const candidates = [];

  for (
    const item of
    limited
  ) {
    const isGecko =
      item.source ===
      "GECKOTERMINAL";

    if (isGecko) {
      sourceCounts.gecko_hydration_attempts++;
    }

    hydrationDiagnostics.attempted++;

    const allPairs =
      pairsByMint.get(
        item.mint
      ) || [];

    const pairResult =
      selectBestDexPair(
        item.mint,
        allPairs
      );

    const pair =
      pairResult.pair;

    const pairDiagnostic =
      pairResult.diagnostic;

    if (
      pairDiagnostic &&
      pairDiagnostic.status ===
        "HYDRATION_SUCCESS"
    ) {
      hydrationDiagnostics.successes++;

      hydrationDiagnostics.pairs_examined +=
        safeNumber(
          pairDiagnostic.solana_pairs
        );

      hydrationDiagnostics.pairs_with_positive_liquidity +=
        safeNumber(
          pairDiagnostic.positive_liquidity_pairs
        );

      hydrationDiagnostics.pairs_with_zero_liquidity +=
        safeNumber(
          pairDiagnostic.zero_liquidity_pairs
        );

      hydrationDiagnostics.pairs_with_missing_liquidity +=
        safeNumber(
          pairDiagnostic.missing_liquidity_pairs
        );

      sourceCounts.dex_zero_liquidity_pairs +=
        safeNumber(
          pairDiagnostic.zero_liquidity_pairs
        );

      if (
        safeNumber(
          pairDiagnostic.selected_liquidity_usd
        ) <
        MIN_LIQUIDITY_USD
      ) {
        sourceCounts.dex_below_min_liquidity_pairs++;
      }

      const liquiditySource =
        pairDiagnostic.selected_liquidity_source ||
        "UNKNOWN";

      hydrationDiagnostics.selected_liquidity_sources[
        liquiditySource
      ] =
        (
          hydrationDiagnostics.selected_liquidity_sources[
            liquiditySource
          ] || 0
        ) + 1;

      if (
        hydrationDiagnostics.selected_pair_samples.length <
        10
      ) {
        hydrationDiagnostics.selected_pair_samples.push({
          mint:
            item.mint,

          symbol:
            pairDiagnostic.selected_base_symbol,

          pair_address:
            pairDiagnostic.selected_pair_address,

          dex_id:
            pairDiagnostic.selected_dex_id,

          pair_count:
            pairDiagnostic.solana_pairs,

          positive_liquidity_pairs:
            pairDiagnostic.positive_liquidity_pairs,

          zero_liquidity_pairs:
            pairDiagnostic.zero_liquidity_pairs,

          missing_liquidity_pairs:
            pairDiagnostic.missing_liquidity_pairs,

          selected_pair_rank:
            pairDiagnostic.selected_pair_rank,

          liquidity_raw:
            pairDiagnostic.selected_liquidity_raw,

          liquidity_usd:
            pairDiagnostic.selected_liquidity_usd,

          liquidity_field_present:
            pairDiagnostic.selected_liquidity_field_present,

          liquidity_source:
            pairDiagnostic.selected_liquidity_source,

          volume_24h_raw:
            pairDiagnostic.selected_volume_24h_raw,

          volume_1h_raw:
            pairDiagnostic.selected_volume_1h_raw,

          selection_reason:
            pairDiagnostic.selection_reason
        });
      }

      if (
        pairDiagnostic.selected_liquidity_usd <=
        0 &&
        hydrationDiagnostics.zero_liquidity_samples.length <
        10
      ) {
        hydrationDiagnostics.zero_liquidity_samples.push({
          mint:
            item.mint,

          symbol:
            pairDiagnostic.selected_base_symbol,

          pair_address:
            pairDiagnostic.selected_pair_address,

          dex_id:
            pairDiagnostic.selected_dex_id,

          liquidity_raw:
            pairDiagnostic.selected_liquidity_raw,

          volume_24h_raw:
            pairDiagnostic.selected_volume_24h_raw,

          volume_1h_raw:
            pairDiagnostic.selected_volume_1h_raw,

          pair_count:
            pairDiagnostic.solana_pairs,

          positive_liquidity_pairs:
            pairDiagnostic.positive_liquidity_pairs,

          selection_reason:
            pairDiagnostic.selection_reason,

          top_pairs:
            pairDiagnostic.top_pairs
        });
      }

      if (
        pairDiagnostic.selected_liquidity_source ===
        "DEXSCREENER_LIQUIDITY_FIELD_MISSING" &&
        hydrationDiagnostics.missing_liquidity_samples.length <
        10
      ) {
        hydrationDiagnostics.missing_liquidity_samples.push({
          mint:
            item.mint,

          symbol:
            pairDiagnostic.selected_base_symbol,

          pair_address:
            pairDiagnostic.selected_pair_address,

          dex_id:
            pairDiagnostic.selected_dex_id,

          pair_count:
            pairDiagnostic.solana_pairs,

          selection_reason:
            pairDiagnostic.selection_reason,

          top_pairs:
            pairDiagnostic.top_pairs
        });
      }
    }

    if (!pair) {
      hydrationDiagnostics.failures++;

      if (isGecko) {
        sourceCounts.gecko_hydration_failures++;
      }

      const reason =
        pairDiagnostic?.status ||
        "UNKNOWN_HYDRATION_FAILURE";

      hydrationDiagnostics.failure_reasons[
        reason
      ] =
        (
          hydrationDiagnostics.failure_reasons[
            reason
          ] || 0
        ) + 1;

      if (
        hydrationDiagnostics.samples.length <
        10
      ) {
        hydrationDiagnostics.samples.push({
          ...pairDiagnostic,
          source:
            item.source
        });
      }

      continue;
    }

    if (isGecko) {
      sourceCounts.gecko_hydration_successes++;
    }

    const candidate =
      normalizeDexPair(
        pair,
        item.mint,
        pairDiagnostic
      );

    if (!candidate) {
      hydrationDiagnostics.failures++;

      hydrationDiagnostics.failure_reasons[
        "NORMALIZATION_FAILED"
      ] =
        (
          hydrationDiagnostics.failure_reasons[
            "NORMALIZATION_FAILED"
          ] || 0
        ) + 1;

      continue;
    }

    candidate.sources =
      unique([
        item.source,

        ...(dexDiscovery.some(
          x =>
            x.mint ===
            item.mint
        )
          ? ["DEXSCREENER"]
          : []),

        ...(geckoMints.includes(
          item.mint
        )
          ? ["GECKOTERMINAL"]
          : [])
      ]);

    candidate.dex_confirmed =
      true;

    candidate.gecko_confirmed =
      geckoMints.includes(
        item.mint
      );

    sourceCounts.hydrated_pairs++;

    candidates.push(
      candidate
    );
  }

  hydrationDiagnostics.failure_reasons =
    Object.fromEntries(
      Object.entries(
        hydrationDiagnostics.failure_reasons
      ).sort(
        (a, b) =>
          b[1] -
          a[1]
      )
    );

  hydrationDiagnostics.selected_liquidity_sources =
    Object.fromEntries(
      Object.entries(
        hydrationDiagnostics.selected_liquidity_sources
      ).sort(
        (a, b) =>
          b[1] -
          a[1]
      )
    );

  /* ==========================================================
     JUPITER PRICE CHECK
     ========================================================== */

  const jupiterMints =
    candidates
      .slice(
        0,
        MAX_JUPITER_PRICE_CHECKS
      )
      .map(
        x => x.mint
      );

  sourceCounts.jupiter_price_checked =
    jupiterMints.length;

  const jupiterResult =
    await getJupiterPrices(
      jupiterMints,
      env
    );

  const jupiterPrices =
    jupiterResult.prices;

  const jupiterDiagnostics =
    jupiterResult.diagnostics;

  for (
    const candidate of
    candidates
  ) {
    const jupiterPrice =
      jupiterPrices.get(
        candidate.mint
      );

    candidate.jupiter_price =
      jupiterPrice ||
      null;

    const confirmation =
      addJupiterConfirmation(
        candidate,
        jupiterPrice
      );

    candidate.jupiter_confirmed =
      confirmation.confirmed;

    candidate.jupiter_price_difference =
      confirmation.difference;

    candidate.jupiter_confirmation_status =
      confirmation.status;

    if (
      confirmation.status ===
      "PRICE_MISMATCH"
    ) {
      jupiterDiagnostics.mismatched_prices++;

      if (
        jupiterDiagnostics.mismatch_samples.length <
        10
      ) {
        jupiterDiagnostics.mismatch_samples.push({
          mint:
            candidate.mint,

          dex_price:
            candidate.price,

          jupiter_price:
            jupiterPrice,

          difference_percent:
            round(
              safeNumber(
                confirmation.difference
              ) * 100,
              2
            )
        });
      }
    }
  }

  sourceCounts.jupiter_price_confirmed =
    candidates.filter(
      candidate =>
        candidate.jupiter_confirmed
    ).length;

  jupiterDiagnostics.confirmed_candidates =
    sourceCounts.jupiter_price_confirmed;

  /* ==========================================================
     SCORE CANDIDATES
     ========================================================== */

  for (
    const candidate of
    candidates
  ) {
    const scoring =
      scoreCandidate(
        candidate
      );

    candidate.score =
      scoring.score;

    candidate.base_score =
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
      b.score -
      a.score
  );

  return {
    candidates:
      candidates.slice(
        0,
        MAX_CANDIDATES
      ),

    sourceCounts,

    discoveryDiagnostics,

    jupiterDiagnostics,

    hydrationDiagnostics
  };
}

/* ============================================================
   MARKET MEMORY
   ============================================================ */

function createMemoryObservation(
  candidate
) {
  return {
    time:
      Date.now(),

    price:
      safeNumber(
        candidate.price
      ),

    change_5m:
      safeNumber(
        candidate.change_5m
      ),

    change_1h:
      safeNumber(
        candidate.change_1h
      ),

    change_6h:
      safeNumber(
        candidate.change_6h
      ),

    volume_1h:
      safeNumber(
        candidate.volume_1h_usd
      ),

    volume_24h:
      safeNumber(
        candidate.volume_24h_usd
      ),

    liquidity:
      safeNumber(
        candidate.liquidity_usd
      ),

    buy_pressure_5m:
      safeNumber(
        candidate.buy_pressure_5m
      ),

    buy_pressure_1h:
      safeNumber(
        candidate.buy_pressure_1h
      )
  };
}

function memoryCandidatePriority(
  candidate
) {
  let priority = 0;

  if (
    candidate.risk_pass
  ) {
    priority += 100;
  }

  if (
    candidate.entry_eligible
  ) {
    priority += 40;
  }

  priority +=
    safeNumber(
      candidate.score
    );

  priority +=
    safeNumber(
      candidate.liquidity_usd
    ) /
    50000;

  priority +=
    safeNumber(
      candidate.volume_1h_usd
    ) /
    10000;

  return priority;
}

function shouldRememberCandidate(
  candidate
) {
  if (
    !candidate.mint
  ) {
    return false;
  }

  if (
    !Number.isFinite(
      candidate.price
    ) ||
    candidate.price <= 0
  ) {
    return false;
  }

  if (
    candidate.risk_pass ||
    candidate.score >= 35 ||
    candidate.liquidity_usd >=
      MIN_LIQUIDITY_USD
  ) {
    return true;
  }

  return false;
}

function cleanupMarketMemory(
  portfolio
) {
  if (
    !portfolio.market_memory ||
    typeof portfolio.market_memory !==
      "object"
  ) {
    portfolio.market_memory = {};
    return;
  }

  const entries =
    Object.entries(
      portfolio.market_memory
    );

  const cleaned = {};

  for (
    const [mint, memory]
    of entries
  ) {
    if (
      !mint ||
      !memory ||
      !Array.isArray(
        memory.observations
      )
    ) {
      continue;
    }

    const observations =
      memory.observations
        .filter(
          observation =>
            observation &&
            safeNumber(
              observation.time
            ) > 0 &&
            safeNumber(
              observation.price
            ) > 0
        )
        .slice(
          -MAX_MEMORY_OBSERVATIONS
        );

    if (
      !observations.length
    ) {
      continue;
    }

    cleaned[mint] = {
      symbol:
        memory.symbol ||
        "UNKNOWN",

      name:
        memory.name ||
        "UNKNOWN",

      priority:
        safeNumber(
          memory.priority
        ),

      observations
    };
  }

  portfolio.market_memory =
    cleaned;
}

function getCandidateMemory(
  portfolio,
  mint
) {
  return (
    portfolio.market_memory?.[
      mint
    ] || null
  );
}

function evaluateHistoricalSetup(
  candidate,
  memory
) {
  const result = {
    observations:
      0,

    setup_score:
      0,

    setup_bonus:
      0,

    confirmed:
      false,

    signals: [],

    deltas: {
      change_5m:
        null,

      change_1h:
        null,

      volume_1h:
        null,

      buy_pressure_5m:
        null,

      buy_pressure_1h:
        null,

      liquidity:
        null
    }
  };

  if (
    !memory ||
    !Array.isArray(
      memory.observations
    )
  ) {
    return result;
  }

  const observations =
    memory.observations;

  result.observations =
    observations.length;

  if (
    observations.length <
    MIN_HISTORY_OBSERVATIONS
  ) {
    return result;
  }

  const previous =
    observations[
      observations.length - 1
    ];

  const current =
    createMemoryObservation(
      candidate
    );

  const delta5m =
    current.change_5m -
    safeNumber(
      previous.change_5m
    );

  const delta1h =
    current.change_1h -
    safeNumber(
      previous.change_1h
    );

  const deltaVolume1h =
    current.volume_1h -
    safeNumber(
      previous.volume_1h
    );

  const deltaBuy5m =
    current.buy_pressure_5m -
    safeNumber(
      previous.buy_pressure_5m
    );

  const deltaBuy1h =
    current.buy_pressure_1h -
    safeNumber(
      previous.buy_pressure_1h
    );

  const deltaLiquidity =
    current.liquidity -
    safeNumber(
      previous.liquidity
    );

  result.deltas = {
    change_5m:
      delta5m,

    change_1h:
      delta1h,

    volume_1h:
      deltaVolume1h,

    buy_pressure_5m:
      deltaBuy5m,

    buy_pressure_1h:
      deltaBuy1h,

    liquidity:
      deltaLiquidity
  };

  let score = 0;

  if (
    delta5m >= 0.01
  ) {
    score += 3;

    result.signals.push(
      "IMPROVING_5M_MOMENTUM"
    );
  }

  if (
    delta5m >= 0.03
  ) {
    score += 2;

    result.signals.push(
      "STRONG_5M_ACCELERATION"
    );
  }

  if (
    delta1h >= 0.01
  ) {
    score += 2;

    result.signals.push(
      "1H_RECOVERY"
    );
  }

  if (
    deltaBuy5m >= 0.05
  ) {
    score += 2;

    result.signals.push(
      "IMPROVING_5M_BUY_PRESSURE"
    );
  }

  if (
    deltaBuy1h >= 0.03
  ) {
    score += 2;

    result.signals.push(
      "IMPROVING_1H_BUY_PRESSURE"
    );
  }

  const previousVolume =
    safeNumber(
      previous.volume_1h
    );

  if (
    deltaVolume1h > 0 &&
    previousVolume > 0 &&
    deltaVolume1h /
      previousVolume >=
      0.10
  ) {
    score += 2;

    result.signals.push(
      "RISING_1H_VOLUME"
    );
  }

  if (
    current.liquidity > 0 &&
    previous.liquidity > 0
  ) {
    const liquidityRatio =
      current.liquidity /
      previous.liquidity;

    if (
      liquidityRatio >= 0.95
    ) {
      score += 1;

      result.signals.push(
        "LIQUIDITY_STABLE"
      );
    }
  }

  const hasMomentumImprovement =
    delta5m >= 0.01;

  const hasPressureImprovement =
    deltaBuy5m >= 0.03 ||
    deltaBuy1h >= 0.02;

  const hasTrendRecovery =
    delta1h >= 0.005;

  result.confirmed =
    score >= MIN_SETUP_SCORE &&
    (
      hasMomentumImprovement ||
      hasPressureImprovement
    ) &&
    (
      hasTrendRecovery ||
      hasPressureImprovement
    );

  result.setup_score =
    clamp(
      score,
      0,
      MAX_HISTORICAL_SETUP_BONUS
    );

  if (
    result.confirmed
  ) {
    result.setup_bonus =
      Math.min(
        result.setup_score,
        MAX_HISTORICAL_SETUP_BONUS
      );
  }

  return result;
}

function updateMarketMemory(
  portfolio,
  candidates
) {
  cleanupMarketMemory(
    portfolio
  );

  const ranked =
    candidates
      .filter(
        shouldRememberCandidate
      )
      .sort(
        (a, b) =>
          memoryCandidatePriority(b) -
          memoryCandidatePriority(a)
      )
      .slice(
        0,
        MAX_MEMORY_CANDIDATES
      );

  for (
    const candidate of
    ranked
  ) {
    const existing =
      portfolio.market_memory[
        candidate.mint
      ];

    const observation =
      createMemoryObservation(
        candidate
      );

    if (!existing) {
      portfolio.market_memory[
        candidate.mint
      ] = {
        symbol:
          candidate.symbol,

        name:
          candidate.name,

        priority:
          memoryCandidatePriority(
            candidate
          ),

        observations: [
          observation
        ]
      };

      continue;
    }

    const observations =
      Array.isArray(
        existing.observations
      )
        ? existing.observations
        : [];

    const last =
      observations[
        observations.length - 1
      ];

    if (
      last &&
      Math.abs(
        safeNumber(
          last.price
        ) -
        observation.price
      ) === 0 &&
      Date.now() -
        safeNumber(
          last.time
        ) <
        30000
    ) {
      continue;
    }

    observations.push(
      observation
    );

    existing.observations =
      observations.slice(
        -MAX_MEMORY_OBSERVATIONS
      );

    existing.symbol =
      candidate.symbol;

    existing.name =
      candidate.name;

    existing.priority =
      memoryCandidatePriority(
        candidate
      );
  }

  const entries =
    Object.entries(
      portfolio.market_memory
    );

  entries.sort(
    (a, b) =>
      safeNumber(
        b[1]?.priority
      ) -
      safeNumber(
        a[1]?.priority
      )
  );

  const trimmed = {};

  for (
    const [mint, memory]
    of entries.slice(
      0,
      MAX_MEMORY_CANDIDATES
    )
  ) {
    trimmed[mint] =
      memory;
  }

  portfolio.market_memory =
    trimmed;
}

function applyHistoricalSetup(
  portfolio,
  candidates
) {
  for (
    const candidate of
    candidates
  ) {
    const memory =
      getCandidateMemory(
        portfolio,
        candidate.mint
      );

    const setup =
      evaluateHistoricalSetup(
        candidate,
        memory
      );

    candidate.history_observations =
      setup.observations;

    candidate.setup_score =
      setup.setup_score;

    candidate.setup_bonus =
      setup.setup_bonus;

    candidate.setup_confirmed =
      setup.confirmed;

    candidate.setup_signals =
      setup.signals;

    candidate.setup_deltas =
      setup.deltas;

    if (
      setup.confirmed &&
      setup.setup_bonus > 0
    ) {
      candidate.score =
        clamp(
          candidate.base_score +
            setup.setup_bonus,
          0,
          100
        );
    }

    const entry =
      evaluateEntryQuality(
        candidate
      );

    candidate.entry_eligible =
      entry.eligible;

    candidate.entry_reasons =
      entry.reasons;

    if (
      candidate.entry_eligible &&
      !candidate.setup_confirmed
    ) {
      candidate.entry_eligible =
        false;

      candidate.entry_reasons =
        [
          ...candidate.entry_reasons,
          "WAITING_FOR_HISTORICAL_CONFIRMATION"
        ];
    }
  }
}

/* ============================================================
   REJECTION DIAGNOSTICS
   ============================================================ */

function countReasons(
  candidates,
  field
) {
  const counts = {};

  for (
    const candidate of
    candidates
  ) {
    for (
      const reason of
      candidate[field] || []
    ) {
      counts[reason] =
        (
          counts[reason] ||
          0
        ) + 1;
    }
  }

  return Object.fromEntries(
    Object.entries(counts)
      .sort(
        (a, b) =>
          b[1] -
          a[1]
      )
  );
}

function buildRejectionDiagnostics(
  candidates
) {
  const riskRejected =
    candidates.filter(
      x =>
        !x.risk_pass
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
      portfolio.cooldowns?.[
        mint
      ]
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
      reason:
        "MAX_POSITIONS"
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
      reason:
        "INSUFFICIENT_CASH"
    };
  }

  if (
    portfolio.positions.some(
      p =>
        p.mint ===
        candidate.mint
    )
  ) {
    return {
      ok: false,
      reason:
        "ALREADY_HOLDING"
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

    pnl_percent:
      0,

    pnl_usd:
      0,

    trailing_active:
      false,

    reversal_confirmations:
      0,

    entry_score:
      candidate.score,

    entry_momentum_score:
      candidate.momentum_score,

    entry_setup_score:
      candidate.setup_score,

    entry_setup_confirmed:
      candidate.setup_confirmed,

    entry_history_observations:
      candidate.history_observations,

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
      type:
        "PAPER_BUY",

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

      setup_score:
        candidate.setup_score,

      setup_confirmed:
        candidate.setup_confirmed,

      history_observations:
        candidate.history_observations,

      reason:
        "ENTRY_ELIGIBLE_HISTORICAL_SETUP"
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
        p.id !==
        position.id
    );

  setCooldown(
    portfolio,
    position.mint
  );

  addHistory(
    portfolio,
    {
      type:
        "PAPER_SELL",

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
  const beforeTrailing =
    position.trailing_active;

  const beforeReversal =
    safeNumber(
      position.reversal_confirmations
    );

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

  if (
    pnl <=
    STOP_LOSS
  ) {
    return {
      sell: true,
      reason:
        "HARD_STOP",
      important_state_change:
        true
    };
  }

  if (
    pnl >=
    TRAILING_ACTIVATION
  ) {
    position.trailing_active =
      true;
  }

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
          "TRAILING_STOP",
        important_state_change:
          true
      };
    }
  }

  const shortTermSelling =
    candidate.sell_ratio_5m <=
    SHORT_TERM_SELL_RATIO;

  const hourlySelling =
    candidate.buy_pressure_1h <
    1 /
      HOURLY_SELL_RATIO;

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
  } else if (
    !reversalSignal
  ) {
    position.reversal_confirmations =
      0;
  }

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
          "PROFIT_REVERSAL",
        important_state_change:
          true
      };
    }
  }

  const importantStateChange =
    beforeTrailing !==
      position.trailing_active ||
    beforeReversal !==
      safeNumber(
        position.reversal_confirmations
      );

  return {
    sell: false,
    reason: null,
    important_state_change:
      importantStateChange
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
    actual -
    expected;

  return {
    actual_basis_usd:
      round(
        actual,
        8
      ),

    expected_basis_usd:
      round(
        expected,
        8
      ),

    difference_usd:
      round(
        difference,
        8
      ),

    ok:
      Math.abs(
        difference
      ) < 0.000001
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
        candidate => [
          candidate.mint,
          candidate
        ]
      )
    );

  let positionValue = 0;
  let unrealizedPnl = 0;

  for (
    const position of
    portfolio.positions
  ) {
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
   SCAN RESULT FORMATTER
   ============================================================ */

function buildScanResult(
  candidates,
  sourceCounts,
  diagnostics,
  jupiterDiagnostics = null,
  hydrationDiagnostics = null,
  discoveryDiagnostics = null
) {
  return {
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
      sourceCounts,

    rejection_diagnostics:
      diagnostics,

    discovery_diagnostics:
      discoveryDiagnostics,

    jupiter_diagnostics:
      jupiterDiagnostics,

    hydration_diagnostics:
      hydrationDiagnostics,

    top_candidates:
      candidates
        .slice(0, 15)
        .map(
          candidate => ({
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

            base_score:
              candidate.base_score,

            momentum_score:
              candidate.momentum_score,

            setup_score:
              candidate.setup_score,

            setup_bonus:
              candidate.setup_bonus,

            setup_confirmed:
              candidate.setup_confirmed,

            history_observations:
              candidate.history_observations,

            setup_signals:
              candidate.setup_signals,

            liquidity_usd:
              round(
                candidate.liquidity_usd,
                2
              ),

            liquidity_raw:
              candidate.liquidity_raw,

            liquidity_field_present:
              candidate.liquidity_field_present,

            liquidity_source:
              candidate.liquidity_source,

            pair_address:
              candidate.pair_address,

            dex_id:
              candidate.dex_id,

            pair_url:
              candidate.url,

            pair_count:
              candidate.pair_count,

            positive_liquidity_pair_count:
              candidate.positive_liquidity_pair_count,

            zero_liquidity_pair_count:
              candidate.zero_liquidity_pair_count,

            missing_liquidity_pair_count:
              candidate.missing_liquidity_pair_count,

            selected_pair_rank:
              candidate.selected_pair_rank,

            liquidity_selection_reason:
              candidate.liquidity_selection_reason,

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
              candidate.age_days ===
              null
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
              candidate.jupiter_confirmed,

            jupiter_price:
              candidate.jupiter_price,

            jupiter_price_difference:
              candidate.jupiter_price_difference ===
              null
                ? null
                : round(
                    candidate.jupiter_price_difference *
                      100,
                    2
                  ),

            jupiter_confirmation_status:
              candidate.jupiter_confirmation_status
          })
        )
  };
}

/* ============================================================
   RUN PAPER ENGINE
   ============================================================ */

async function runPaperEngine(
  env
) {
  if (!PAPER_MODE) {
    throw new Error(
      "This build is configured for PAPER MODE only."
    );
  }

  const portfolio =
    await loadPortfolio(env);

  const beforeRun =
    cloneObject(
      portfolio
    );

  const buys = [];
  const sells = [];
  const blockedSells = [];

  let importantStateChanged =
    false;

  const persistenceReady =
    canPersistNow(
      portfolio
    );

  const scan =
    await buildCandidates(
      env
    );

  const candidates =
    scan.candidates;

  applyHistoricalSetup(
    portfolio,
    candidates
  );

  updateMarketMemory(
    portfolio,
    candidates
  );

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
      decision.important_state_change
    ) {
      importantStateChanged =
        true;
    }

    if (
      decision.sell
    ) {
      if (
        !persistenceReady
      ) {
        blockedSells.push({
          mint:
            position.mint,

          symbol:
            position.symbol,

          reason:
            "PERSISTENCE_THROTTLE"
        });

        continue;
      }

      const result =
        paperSell(
          portfolio,
          position,
          candidate.price,
          decision.reason
        );

      if (result.ok) {
        sells.push(
          result
        );
      }
    }
  }

  let buysRemaining =
    MAX_NEW_BUYS_PER_RUN;

  let tradeBlocked =
    !persistenceReady;

  if (
    persistenceReady &&
    portfolio.positions.length <
      MAX_POSITIONS
  ) {
    const eligible =
      candidates.filter(
        candidate =>
          candidate.risk_pass &&
          candidate.entry_eligible &&
          candidate.setup_confirmed &&
          candidate.history_observations >=
            MIN_HISTORY_OBSERVATIONS &&
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

    eligible.sort(
      (a, b) => {
        const setupDifference =
          safeNumber(
            b.setup_score
          ) -
          safeNumber(
            a.setup_score
          );

        if (
          setupDifference !== 0
        ) {
          return setupDifference;
        }

        return (
          safeNumber(
            b.score
          ) -
          safeNumber(
            a.score
          )
        );
      }
    );

    for (
      const candidate of
      eligible
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

          base_score:
            candidate.base_score,

          momentum_score:
            candidate.momentum_score,

          setup_score:
            candidate.setup_score,

          history_observations:
            candidate.history_observations,

          setup_signals:
            candidate.setup_signals
        });

        buysRemaining--;
      }
    }
  }

  const portfolioMark =
    markPortfolio(
      portfolio,
      candidates
    );

  const accounting =
    calculateAccountingCheck(
      portfolio
    );

  const diagnostics =
    buildRejectionDiagnostics(
      candidates
    );

  const riskPassCount =
    candidates.filter(
      c =>
        c.risk_pass
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
      !persistenceReady
    ) {
      noTradeReason =
        "PERSISTENCE_THROTTLE";
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

  const scanResult =
    buildScanResult(
      candidates,
      scan.sourceCounts,
      diagnostics,
      scan.jupiterDiagnostics,
      scan.hydrationDiagnostics,
      scan.discoveryDiagnostics
    );

  const hadTrades =
    buys.length > 0 ||
    sells.length > 0;

  const checkpoint =
    checkpointDue(
      portfolio
    );

  let persistence = {
    attempted: false,
    saved: false,
    throttled: false,
    reason:
      "NOT_NEEDED"
  };

  if (hadTrades) {
    persistence.attempted =
      true;

    try {
      persistence =
        await savePortfolio(
          env,
          portfolio,
          "TRADE",
          {
            force: true
          }
        );
    } catch (error) {
      restoreObject(
        portfolio,
        beforeRun
      );

      throw new Error(
        `PAPER_TRADE_ROLLED_BACK_PERSISTENCE_FAILED: ${errorText(error)}`
      );
    }
  } else if (
    importantStateChanged &&
    persistenceReady
  ) {
    persistence.attempted =
      true;

    try {
      persistence =
        await savePortfolio(
          env,
          portfolio,
          "IMPORTANT_STATE_CHANGE"
        );
    } catch (error) {
      persistence = {
        attempted: true,
        saved: false,
        throttled: false,
        reason:
          "IMPORTANT_STATE_CHANGE",
        error:
          errorText(error)
      };
    }
  } else if (
    checkpoint &&
    canPersistNow(portfolio)
  ) {
    persistence.attempted =
      true;

    try {
      persistence =
        await savePortfolio(
          env,
          portfolio,
          "CHECKPOINT"
        );
    } catch (error) {
      persistence = {
        attempted: true,
        saved: false,
        throttled: false,
        reason:
          "CHECKPOINT",
        error:
          errorText(error)
      };
    }
  } else if (
    !persistenceReady
  ) {
    persistence = {
      attempted: false,
      saved: false,
      throttled: true,
      reason:
        "PERSISTENCE_INTERVAL"
    };
  }

  return {
    ok: true,

    bot:
      BOT_NAME,

    mode: {
      type:
        "PAPER",

      transaction_execution:
        false
    },

    buys:
      buys.length,

    sells:
      sells.length,

    buy_details:
      buys,

    sell_details:
      sells,

    blocked_sells:
      blockedSells,

    scanner_status:
      "OK",

    no_trade_reason:
      noTradeReason,

    portfolio:
      portfolioMark,

    sizing: {
      current_position_size_usd:
        getPositionSize(
          portfolioMark.equity_usd
        ),

      max_position_size_usd:
        MAX_PAPER_POSITION_USD,

      max_positions:
        MAX_POSITIONS,

      max_new_buys_per_run:
        MAX_NEW_BUYS_PER_RUN
    },

    accounting,

    persistence,

    storage_policy: {
      min_persist_interval_seconds:
        MIN_PERSIST_INTERVAL_SECONDS,

      checkpoint_interval_seconds:
        CHECKPOINT_INTERVAL_SECONDS,

      scan_writes_portfolio:
        false,

      market_memory_enabled:
        true,

      max_memory_candidates:
        MAX_MEMORY_CANDIDATES,

      max_memory_observations:
        MAX_MEMORY_OBSERVATIONS,

      minimum_history_observations:
        MIN_HISTORY_OBSERVATIONS
    },

    scan:
      scanResult
  };
}

/* ============================================================
   TEST SCAN
   ============================================================ */

async function runScanOnly(
  env
) {
  const scan =
    await buildCandidates(
      env
    );

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
      type:
        "PAPER",

      transaction_execution:
        false
    },

    scanner_status:
      "OK",

    scan:
      buildScanResult(
        candidates,
        scan.sourceCounts,
        diagnostics,
        scan.jupiterDiagnostics,
        scan.hydrationDiagnostics,
        scan.discoveryDiagnostics
      ),

    storage_policy: {
      write_performed:
        false,

      reason:
        "SCAN_ONLY_IS_READ_ONLY",

      market_memory_updated:
        false
    }
  };
}

/* ============================================================
   STATUS
   ============================================================ */

async function getStatus(
  env
) {
  const portfolio =
    await loadPortfolio(
      env
    );

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

  const memoryEntries =
    Object.entries(
      portfolio.market_memory || {}
    );

  return {
    ok: true,

    bot:
      BOT_NAME,

    mode: {
      type:
        "PAPER",

      transaction_execution:
        false
    },

    settings: {
      min_entry_score:
        MIN_ENTRY_SCORE,

      min_momentum_score:
        MIN_MOMENTUM_SCORE,

      min_setup_score:
        MIN_SETUP_SCORE,

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
        REVERSAL_CONFIRMATIONS_REQUIRED,

      minimum_history_observations:
        MIN_HISTORY_OBSERVATIONS
    },

    storage: {
      last_persist_at:
        portfolio.last_persist_at ||
        null,

      last_persist_reason:
        portfolio.last_persist_reason ||
        null,

      min_persist_interval_seconds:
        MIN_PERSIST_INTERVAL_SECONDS,

      checkpoint_interval_seconds:
        CHECKPOINT_INTERVAL_SECONDS,

      next_persist_allowed_at:
        portfolio.last_persist_at
          ? new Date(
              portfolio.last_persist_at +
              MIN_PERSIST_INTERVAL_SECONDS *
                1000
            ).toISOString()
          : null
    },

    market_memory: {
      candidates:
        memoryEntries.length,

      max_candidates:
        MAX_MEMORY_CANDIDATES,

      max_observations_per_candidate:
        MAX_MEMORY_OBSERVATIONS,

      entries:
        memoryEntries.map(
          ([mint, memory]) => ({
            mint,

            symbol:
              memory.symbol,

            observations:
              memory.observations?.length ||
              0,

            latest_observation:
              memory.observations?.length
                ? memory.observations[
                    memory.observations.length - 1
                  ]
                : null
          })
        )
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

          entry_setup_score:
            position.entry_setup_score ||
            0,

          entry_setup_confirmed:
            position.entry_setup_confirmed ||
            false,

          entry_history_observations:
            position.entry_history_observations ||
            0,

          entry_time:
            position.entry_time
        })
      )
  };
}

/* ============================================================
   RESET PAPER ACCOUNT
   ============================================================ */

async function resetPaper(
  env
) {
  const portfolio =
    createEmptyPortfolio();

  const persistence =
    await savePortfolio(
      env,
      portfolio,
      "RESET",
      {
        force: true
      }
    );

  return {
    ok: true,

    bot:
      BOT_NAME,

    mode: {
      type:
        "PAPER",

      transaction_execution:
        false
    },

    message:
      "Paper portfolio reset.",

    persistence,

    portfolio:
      markPortfolio(
        portfolio,
        []
      )
  };
}

/* ============================================================
   HTTP RESPONSE HELPER
   ============================================================ */

function jsonResponse(
  body,
  status = 200
) {
  return new Response(
    JSON.stringify(
      body,
      null,
      2
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json"
      }
    }
  );
}

/* ============================================================
   HTTP ROUTER
   ============================================================ */

export default {
  async fetch(
    request,
    env
  ) {
    try {
      const url =
        new URL(
          request.url
        );

      const path =
        url.pathname;

      if (
        request.method !== "GET" &&
        request.method !== "POST"
      ) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Method not allowed"
          },
          405
        );
      }

      if (
        path === "/" ||
        path === "/health"
      ) {
        return jsonResponse({
          ok: true,

          bot:
            BOT_NAME,

          mode:
            "PAPER",

          transaction_execution:
            false,

          time:
            nowIso()
        });
      }

      if (
        path === "/run"
      ) {
        const result =
          await runPaperEngine(
            env
          );

        return jsonResponse(
          result
        );
      }

      if (
        path === "/scan"
      ) {
        const result =
          await runScanOnly(
            env
          );

        return jsonResponse(
          result
        );
      }

      if (
        path === "/status"
      ) {
        const result =
          await getStatus(
            env
          );

        return jsonResponse(
          result
        );
      }

      if (
        path === "/reset"
      ) {
        const confirm =
          url.searchParams.get(
            "confirm"
          );

        if (
          confirm !==
          "RESET"
        ) {
          return jsonResponse(
            {
              ok: false,

              error:
                "Reset requires ?confirm=RESET"
            },
            400
          );
        }

        const result =
          await resetPaper(
            env
          );

        return jsonResponse(
          result
        );
      }

      return jsonResponse(
        {
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
        },
        404
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          bot:
            BOT_NAME,

          type:
            "ENGINE_ERROR",

          error:
            errorText(error),

          time:
            nowIso()
        })
      );

      return jsonResponse(
        {
          ok: false,

          bot:
            BOT_NAME,

          mode: {
            type:
              "PAPER",

            transaction_execution:
              false
          },

          error:
            errorText(error),

          time:
            nowIso()
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
      (async () => {
        try {
          const result =
            await runPaperEngine(
              env
            );

          console.log(
            JSON.stringify({
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

              blocked_sells:
                result.blocked_sells?.length ||
                0,

              no_trade_reason:
                result.no_trade_reason,

              equity:
                result.portfolio
                  .equity_usd,

              eligible:
                result.scan
                  .eligible_candidates,

              persistence:
                result.persistence,

              discovery:
                result.scan
                  .discovery_diagnostics,

              hydration:
                result.scan
                  .hydration_diagnostics,

              jupiter:
                result.scan
                  .jupiter_diagnostics
            })
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              cron:
                true,

              bot:
                BOT_NAME,

              type:
                "CRON_ERROR",

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
