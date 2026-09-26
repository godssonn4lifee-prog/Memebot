const BOT_NAME = "memebott";

/*
============================================================
MEMEBOTT — LIVE BETA / CONFIRMATION GATED
============================================================
Strategy revision:
- Scanner still runs every minute.
- KV persistence remains throttled.
- Compact short-term candidate memory is maintained.
- Historical observations help identify early momentum.
- Existing safety filters remain intact.
- Duplicate extreme 1h penalty removed.
- Live beta path is confirmation-gated; no automatic transaction execution.
- Discovery diagnostics enabled.
- DexScreener batch hydration enabled.
- Jupiter Price API v3 robust response parsing enabled.
- Jupiter fallback price diagnostics enabled.
- Liquidity-source diagnostics enabled.
*/
const PAPER_MODE = true;
const LIVE_BETA_MODE = true;
const TRANSACTION_EXECUTION = false;
const PAPER_SCHEMA_VERSION = 4;

/* ============================================================
BASIC SETTINGS
============================================================ */
const STARTING_CASH_USD = 20;
const MIN_CASH_RESERVE_USD = 10;
const MAX_POSITIONS = 7;
const MAX_NEW_BUYS_PER_RUN = 1;
const MAX_PAPER_POSITION_USD = 2;
const MAX_LIVE_TRADE_USD = 2;
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
  { equity: 0, amount: 2 },
  { equity: 1000000, amount: 2 }
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

/*
Jupiter fallback is deliberately limited.
If the batch endpoint returns HTTP 200 but no usable prices,
we perform a small number of individual requests. This gives
us a real diagnostic signal without turning every scan into
a large number of API calls.
*/
const MAX_JUPITER_FALLBACK_CHECKS = 5;

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
  return error instanceof Error ? error.message : String(error);
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
    throw new Error(`HTTP ${response.status} from ${url}`);
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
          (bodyText ? `: ${bodyText.slice(0, 500)}` : "")
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
        error: `INVALID_JSON_RESPONSE: ${errorText(error)}`
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      data: null,
      error: `FETCH_EXCEPTION: ${errorText(error)}`
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
    starting_cash_usd: STARTING_CASH_USD,
    cash_usd: STARTING_CASH_USD,
    realized_pnl_usd: 0,
    positions: [],
    history: [],
    cooldowns: {},
    market_memory: {},
    created_at: nowIso(),
    updated_at: nowIso(),
    last_persist_at: 0,
    last_persist_reason: null
  };
}

async function loadPortfolio(env) {
  const raw = await env.BOT_KV.get("LIVE_BETA_PORTFOLIO");

  if (!raw) {
    return createEmptyPortfolio();
  }

  try {
    const portfolio = JSON.parse(raw);

    if (
      safeNumber(portfolio.schema_version) !==
      PAPER_SCHEMA_VERSION
    ) {
      return createEmptyPortfolio();
    }

    portfolio.positions ||= [];
    portfolio.history ||= [];
    portfolio.cooldowns ||= {};
    portfolio.market_memory ||= {};

    portfolio.cash_usd = safeNumber(
      portfolio.cash_usd,
      STARTING_CASH_USD
    );

    portfolio.realized_pnl_usd = safeNumber(
      portfolio.realized_pnl_usd
    );

    portfolio.last_persist_at = safeNumber(
      portfolio.last_persist_at
    );

    portfolio.last_persist_reason ||= null;

    delete portfolio.last_scan;

    cleanupMarketMemory(portfolio);

    return portfolio;
  } catch {
    return createEmptyPortfolio();
  }
}

/* ============================================================
PERSISTENCE CONTROL
============================================================ */
function persistenceAgeMs(portfolio) {
  const last = safeNumber(portfolio.last_persist_at);

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
  const force = options.force === true;

  if (!force && !canPersistNow(portfolio)) {
    return {
      saved: false,
      throttled: true,
      reason
    };
  }

  const persistedAt = Date.now();
  const payload = cloneObject(portfolio);

  delete payload.last_scan;

  payload.updated_at =
    new Date(persistedAt).toISOString();

  payload.last_persist_at = persistedAt;
  payload.last_persist_reason = reason;

  await env.BOT_KV.put(
    "LIVE_BETA_PORTFOLIO",
    JSON.stringify(payload)
  );

  portfolio.updated_at = payload.updated_at;
  portfolio.last_persist_at = persistedAt;
  portfolio.last_persist_reason = reason;

  delete portfolio.last_scan;

  return {
    saved: true,
    throttled: false,
    reason,
    time: payload.updated_at
  };
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
      key: "dexscreener_profiles",
      url:
        `${DEX_BASE}/token-profiles/latest/v1`
    },
    {
      key: "dexscreener_boosts",
      url:
        `${DEX_BASE}/token-boosts/latest/v1`
    },
    {
      key: "dexscreener_top_boosts",
      url:
        `${DEX_BASE}/token-boosts/top/v1`
    }
  ];

  const results = [];

  for (const endpoint of endpoints) {
    const result =
      await fetchJsonDiagnostic(endpoint.url);

    const diagnostic =
      diagnostics[endpoint.key];

    diagnostic.http_status = result.status;

    if (!result.ok) {
      diagnostic.error = result.error;
      continue;
    }

    diagnostic.response_shape =
      responseShape(result.data);

    if (!Array.isArray(result.data)) {
      diagnostic.error =
        "EXPECTED_ARRAY_RESPONSE";
      continue;
    }

    diagnostic.total_items =
      result.data.length;

    diagnostic.sample =
      result.data
        .slice(0, 5)
        .map(discoveryItemSample);

    for (const item of result.data) {
      const chainId =
        String(
          item?.chainId || ""
        ).toLowerCase();

      if (chainId !== "solana") {
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

  for (const query of queries) {
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

    diagnostics.queries[query] =
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
        error: result.error
      });

      continue;
    }

    queryDiagnostic.response_shape =
      responseShape(result.data);

    const pairs =
      Array.isArray(result.data?.pairs)
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
        .map(pair => ({
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
        }));

    for (const pair of pairs) {
      if (
        String(
          pair?.chainId || ""
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
      .replace(/^solana_/, "");
  }

  const directAddress =
    item?.attributes?.address ||
    item?.address;

  if (directAddress) {
    return String(directAddress);
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
  const mints = new Set();

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
      responseShape(result.data);

    const items =
      Array.isArray(result.data?.data)
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
        .map(geckoPoolSample);

    for (const item of items) {
      const mint =
        extractGeckoMint(item);

      if (!mint) {
        continue;
      }

      diagnostic.tokens_extracted++;
      mints.add(mint);
    }
  }

  await readGeckoEndpoint(
    "gecko_trending",
    `${GECKO_BASE}/networks/solana/trending_pools?page=1`
  );

  if (mints.size === 0) {
    await readGeckoEndpoint(
      "gecko_top_pools",
      `${GECKO_BASE}/networks/solana/pools?page=1&include=base_token`
    );
  }

  if (mints.size === 0) {
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
function summarizeDexPair(pair, index) {
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
    rank: index + 1,
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
async function hydrateDexPairs(mints) {
  const uniqueMints =
    unique(mints);

  const diagnostics = {
    attempted: uniqueMints.length,
    successful: 0,
    failed: 0,
    empty: 0,
    errors: [],
    samples: []
  };

  const hydrated = new Map();

  for (const mint of uniqueMints) {
    try {
      const result =
        await fetchJsonDiagnostic(
          `${DEX_BASE}/latest/dex/tokens/${encodeURIComponent(mint)}`
        );

      if (!result.ok) {
        diagnostics.failed++;

        diagnostics.errors.push({
          mint,
          error: result.error
        });

        continue;
      }

      const pairs =
        Array.isArray(result.data?.pairs)
          ? result.data.pairs
          : [];

      if (!pairs.length) {
        diagnostics.empty++;
        continue;
      }

      const solanaPairs =
        pairs.filter(
          pair =>
            String(
              pair?.chainId ||
              ""
            ).toLowerCase() ===
            "solana"
        );

      if (!solanaPairs.length) {
        diagnostics.empty++;
        continue;
      }

      solanaPairs.sort(
        (a, b) =>
          safeNumber(
            b?.liquidity?.usd
          ) -
          safeNumber(
            a?.liquidity?.usd
          )
      );

      const best =
        solanaPairs[0];

      hydrated.set(
        mint,
        best
      );

      diagnostics.successful++;

      if (
        diagnostics.samples.length <
        10
      ) {
        diagnostics.samples.push(
          summarizeDexPair(
            best,
            0
          )
        );
      }
    } catch (error) {
      diagnostics.failed++;

      diagnostics.errors.push({
        mint,
        error:
          errorText(error)
      });
    }
  }

  return {
    hydrated,
    diagnostics
  };
}

/* ============================================================
GECKO TOKEN / POOL HYDRATION
============================================================ */
async function hydrateGeckoPools(mints) {
  const hydrated = new Map();

  const diagnostics = {
    attempted: mints.length,
    successful: 0,
    failed: 0,
    empty: 0,
    errors: [],
    samples: []
  };

  for (const mint of mints) {
    try {
      const url =
        `${GECKO_BASE}/networks/solana/tokens/${encodeURIComponent(mint)}/pools?page=1`;

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

      if (!result.ok) {
        diagnostics.failed++;

        diagnostics.errors.push({
          mint,
          error: result.error
        });

        continue;
      }

      const pools =
        Array.isArray(
          result.data?.data
        )
          ? result.data.data
          : [];

      if (!pools.length) {
        diagnostics.empty++;
        continue;
      }

      const best =
        pools
          .slice()
          .sort(
            (a, b) =>
              safeNumber(
                b?.attributes
                  ?.reserve_in_usd
              ) -
              safeNumber(
                a?.attributes
                  ?.reserve_in_usd
              )
          )[0];

      if (!best) {
        diagnostics.empty++;
        continue;
      }

      hydrated.set(
        mint,
        best
      );

      diagnostics.successful++;

      if (
        diagnostics.samples.length <
        10
      ) {
        diagnostics.samples.push({
          mint,
          pool:
            geckoPoolSample(best)
        });
      }
    } catch (error) {
      diagnostics.failed++;

      diagnostics.errors.push({
        mint,
        error:
          errorText(error)
      });
    }
  }

  return {
    hydrated,
    diagnostics
  };
}

/* ============================================================
JUPITER PRICE HELPERS
============================================================ */
function extractJupiterPrice(
  data,
  mint
) {
  if (!data) {
    return null;
  }

  const direct =
    data?.data?.[mint] ||
    data?.[mint] ||
    data?.data ||
    null;

  if (
    direct &&
    typeof direct === "object" &&
    !Array.isArray(direct)
  ) {
    const candidates = [
      direct.usdPrice,
      direct.usd_price,
      direct.price,
      direct.priceUsd,
      direct.price_usd
    ];

    for (const value of candidates) {
      const number =
        Number(value);

      if (
        Number.isFinite(number) &&
        number > 0
      ) {
        return number;
      }
    }
  }

  if (
    Array.isArray(
      data?.data
    )
  ) {
    for (
      const item of
      data.data
    ) {
      const address =
        item?.id ||
        item?.mint ||
        item?.address;

      if (
        address === mint
      ) {
        const number =
          Number(
            item?.usdPrice ??
            item?.usd_price ??
            item?.price ??
            item?.priceUsd
          );

        if (
          Number.isFinite(number) &&
          number > 0
        ) {
          return number;
        }
      }
    }
  }

  return null;
}

async function getJupiterPrices(mints) {
  const uniqueMints =
    unique(mints)
      .slice(
        0,
        MAX_JUPITER_PRICE_CHECKS
      );

  const prices = {};
  const diagnostics = {
    attempted:
      uniqueMints.length,
    http_status: null,
    response_shape: null,
    returned_keys: 0,
    usable_prices: 0,
    invalid_response: false,
    batch_error: null,
    fallback_attempted: 0,
    fallback_successful: 0,
    fallback_errors: []
  };

  if (!uniqueMints.length) {
    return {
      prices,
      diagnostics
    };
  }

  const url =
    `${JUPITER_PRICE_API}?ids=${encodeURIComponent(
      uniqueMints.join(",")
    )}`;

  const batch =
    await fetchJsonDiagnostic(url);

  diagnostics.http_status =
    batch.status;

  if (
    batch.ok
  ) {
    diagnostics.response_shape =
      responseShape(batch.data);

    const dataObject =
      batch.data?.data &&
      typeof batch.data.data === "object"
        ? batch.data.data
        : batch.data &&
          typeof batch.data === "object"
          ? batch.data
          : null;

    if (
      dataObject &&
      typeof dataObject === "object" &&
      !Array.isArray(dataObject)
    ) {
      diagnostics.returned_keys =
        Object.keys(
          dataObject
        ).length;
    }

    for (const mint of uniqueMints) {
      const price =
        extractJupiterPrice(
          batch.data,
          mint
        );

      if (
        Number.isFinite(price) &&
        price > 0
      ) {
        prices[mint] = price;
        diagnostics.usable_prices++;
      }
    }

    if (
      diagnostics.usable_prices === 0
    ) {
      diagnostics.invalid_response =
        true;
      diagnostics.batch_error =
        "HTTP_200_BUT_ZERO_USABLE_PRICES";
    }
  } else {
    diagnostics.batch_error =
      batch.error;
  }

  /*
  Individual fallback requests are deliberately capped.
  */
  const fallbackMints =
    uniqueMints
      .filter(
        mint =>
          !prices[mint]
      )
      .slice(
        0,
        MAX_JUPITER_FALLBACK_CHECKS
      );

  for (const mint of fallbackMints) {
    diagnostics.fallback_attempted++;

    try {
      const result =
        await fetchJsonDiagnostic(
          `${JUPITER_PRICE_API}?ids=${encodeURIComponent(mint)}`
        );

      if (!result.ok) {
        diagnostics.fallback_errors.push({
          mint,
          error: result.error
        });
        continue;
      }

      const price =
        extractJupiterPrice(
          result.data,
          mint
        );

      if (
        Number.isFinite(price) &&
        price > 0
      ) {
        prices[mint] =
          price;

        diagnostics.fallback_successful++;
      } else {
        diagnostics.fallback_errors.push({
          mint,
          error:
            "ZERO_USABLE_PRICE"
        });
      }
    } catch (error) {
      diagnostics.fallback_errors.push({
        mint,
        error:
          errorText(error)
      });
    }
  }

  return {
    prices,
    diagnostics
  };
}

/* ============================================================
GECKO PRICE / LIQUIDITY FALLBACK
============================================================ */
function geckoFallbackData(item) {
  const attributes =
    item?.attributes ||
    {};

  const price =
    safeNumber(
      attributes.base_token_price_usd,
      0
    );

  const reserve =
    safeNumber(
      attributes.reserve_in_usd ??
      attributes.total_reserve_in_usd,
      0
    );

  return {
    price_usd: price,
    liquidity_usd: reserve,
    volume_24h_usd:
      safeNumber(
        attributes.volume_usd
          ?.h24,
        0
      ),
    volume_1h_usd:
      safeNumber(
        attributes.volume_usd
          ?.h1,
        0
      ),
    price_change_5m:
      safeNumber(
        attributes
          .price_change_percentage
          ?.m5,
        0
      ) / 100,
    price_change_1h:
      safeNumber(
        attributes
          .price_change_percentage
          ?.h1,
        0
      ) / 100,
    price_change_6h:
      safeNumber(
        attributes
          .price_change_percentage
          ?.h6,
        0
      ) / 100,
    price_change_24h:
      safeNumber(
        attributes
          .price_change_percentage
          ?.h24,
        0
      ) / 100
  };
}

/* ============================================================
PAIR NORMALIZATION
============================================================ */
function normalizeCandidate(
  mint,
  dexPair,
  geckoPool,
  jupiterPrice,
  source
) {
  const dexLiquidity =
    safeNumber(
      dexPair?.liquidity?.usd,
      0
    );

  const gecko =
    geckoFallbackData(
      geckoPool
    );

  const price =
    safeNumber(
      dexPair?.priceUsd,
      0
    ) ||
    safeNumber(
      jupiterPrice,
      0
    ) ||
    gecko.price_usd;

  const liquidity =
    dexLiquidity ||
    gecko.liquidity_usd;

  const volume24h =
    safeNumber(
      dexPair?.volume?.h24,
      0
    ) ||
    gecko.volume_24h_usd;

  const volume1h =
    safeNumber(
      dexPair?.volume?.h1,
      0
    ) ||
    gecko.volume_1h_usd;

  const changes =
    dexPair?.priceChange ||
    {};

  const change5m =
    Number.isFinite(
      Number(changes.m5)
    )
      ? Number(changes.m5) / 100
      : gecko.price_change_5m;

  const change1h =
    Number.isFinite(
      Number(changes.h1)
    )
      ? Number(changes.h1) / 100
      : gecko.price_change_1h;

  const change6h =
    Number.isFinite(
      Number(changes.h6)
    )
      ? Number(changes.h6) / 100
      : gecko.price_change_6h;

  const change24h =
    Number.isFinite(
      Number(changes.h24)
    )
      ? Number(changes.h24) / 100
      : gecko.price_change_24h;

  const pairCreatedAt =
    safeNumber(
      dexPair?.pairCreatedAt,
      0
    );

  const ageDays =
    pairCreatedAt > 0
      ? Math.max(
          0,
          (
            Date.now() -
            pairCreatedAt
          ) /
          86400000
        )
      : null;

  return {
    mint,
    symbol:
      dexPair?.baseToken?.symbol ||
      null,
    name:
      dexPair?.baseToken?.name ||
      null,
    source,
    dex_id:
      dexPair?.dexId ||
      null,
    pair_address:
      dexPair?.pairAddress ||
      null,
    pair_url:
      dexPair?.url ||
      null,
    price_usd:
      price,
    liquidity_usd:
      liquidity,
    volume_24h_usd:
      volume24h,
    volume_1h_usd:
      volume1h,
    change_5m:
      change5m,
    change_1h:
      change1h,
    change_6h:
      change6h,
    change_24h:
      change24h,
    pair_created_at:
      pairCreatedAt || null,
    age_days:
      ageDays,
    quote_symbol:
      dexPair?.quoteToken?.symbol ||
      null,
    jupiter_price_usd:
      safeNumber(
        jupiterPrice,
        0
      ) || null,
    liquidity_source:
      dexLiquidity > 0
        ? "DEXSCREENER"
        : gecko.liquidity_usd > 0
          ? "GECKOTERMINAL"
          : jupiterPrice > 0
            ? "JUPITER"
            : "NONE",
    price_source:
      safeNumber(
        dexPair?.priceUsd,
        0
      ) > 0
        ? "DEXSCREENER"
        : jupiterPrice > 0
          ? "JUPITER"
          : gecko.price_usd > 0
            ? "GECKOTERMINAL"
            : "NONE"
  };
}

/* ============================================================
MARKET MEMORY
============================================================ */
function cleanupMarketMemory(
  portfolio
) {
  const memory =
    portfolio.market_memory ||
    {};

  const cutoff =
    Date.now() -
    24 * 60 * 60 * 1000;

  for (
    const [mint, entry] of
    Object.entries(memory)
  ) {
    if (
      !entry ||
      safeNumber(
        entry.last_seen_at
      ) < cutoff
    ) {
      delete memory[mint];
      continue;
    }

    entry.observations =
      Array.isArray(
        entry.observations
      )
        ? entry.observations
        : [];

    if (
      entry.observations.length >
      MAX_MEMORY_OBSERVATIONS
    ) {
      entry.observations =
        entry.observations.slice(
          -MAX_MEMORY_OBSERVATIONS
        );
    }
  }

  const entries =
    Object.entries(memory)
      .sort(
        (a, b) =>
          safeNumber(
            b[1]?.last_seen_at
          ) -
          safeNumber(
            a[1]?.last_seen_at
          )
      )
      .slice(
        0,
        MAX_MEMORY_CANDIDATES
      );

  portfolio.market_memory =
    Object.fromEntries(
      entries
    );
}

function recordMarketObservation(
  portfolio,
  candidate
) {
  if (!candidate?.mint) {
    return;
  }

  const mint =
    candidate.mint;

  const existing =
    portfolio.market_memory[mint] ||
    {
      mint,
      symbol:
        candidate.symbol ||
        null,
      name:
        candidate.name ||
        null,
      observations: []
    };

  existing.symbol =
    candidate.symbol ||
    existing.symbol ||
    null;

  existing.name =
    candidate.name ||
    existing.name ||
    null;

  existing.last_seen_at =
    Date.now();

  existing.observations.push({
    time:
      Date.now(),
    price_usd:
      safeNumber(
        candidate.price_usd
      ),
    liquidity_usd:
      safeNumber(
        candidate.liquidity_usd
      ),
    volume_1h_usd:
      safeNumber(
        candidate.volume_1h_usd
      ),
    volume_24h_usd:
      safeNumber(
        candidate.volume_24h_usd
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
    change_24h:
      safeNumber(
        candidate.change_24h
      )
  });

  if (
    existing.observations.length >
    MAX_MEMORY_OBSERVATIONS
  ) {
    existing.observations =
      existing.observations.slice(
        -MAX_MEMORY_OBSERVATIONS
      );
  }

  portfolio.market_memory[mint] =
    existing;

  cleanupMarketMemory(
    portfolio
  );
}

function getHistoricalSetupBonus(
  portfolio,
  candidate
) {
  const memory =
    portfolio.market_memory?.[
      candidate.mint
    ];

  if (!memory) {
    return 0;
  }

  const observations =
    Array.isArray(
      memory.observations
    )
      ? memory.observations
      : [];

  if (
    observations.length <
    MIN_HISTORY_OBSERVATIONS
  ) {
    return 0;
  }

  let bonus = 0;

  const previous =
    observations[
      observations.length - 1
    ];

  if (
    safeNumber(
      previous.price_usd
    ) > 0 &&
    safeNumber(
      candidate.price_usd
    ) > 0
  ) {
    const delta =
      (
        candidate.price_usd -
        previous.price_usd
      ) /
      previous.price_usd;

    if (delta > 0) {
      bonus += 5;
    }

    if (
      delta >= 0.01
    ) {
      bonus += 3;
    }
  }

  if (
    safeNumber(
      candidate.volume_1h_usd
    ) >
    safeNumber(
      previous.volume_1h_usd
    )
  ) {
    bonus += 3;
  }

  if (
    safeNumber(
      candidate.liquidity_usd
    ) >
    safeNumber(
      previous.liquidity_usd
    )
  ) {
    bonus += 2;
  }

  return clamp(
    bonus,
    0,
    MAX_HISTORICAL_SETUP_BONUS
  );
}

/* ============================================================
SCORING
============================================================ */
function scoreCandidate(
  portfolio,
  candidate
) {
  const liquidity =
    safeNumber(
      candidate.liquidity_usd
    );

  const volume24h =
    safeNumber(
      candidate.volume_24h_usd
    );

  const volume1h =
    safeNumber(
      candidate.volume_1h_usd
    );

  const change5m =
    safeNumber(
      candidate.change_5m
    );

  const change1h =
    safeNumber(
      candidate.change_1h
    );

  const change6h =
    safeNumber(
      candidate.change_6h
    );

  const change24h =
    safeNumber(
      candidate.change_24h
    );

  let momentumScore = 0;
  let setupScore = 0;
  let riskPenalty = 0;

  if (
    change5m > 0
  ) {
    momentumScore += 4;
  }

  if (
    change5m >= 0.02
  ) {
    momentumScore += 3;
  }

  if (
    change1h > 0
  ) {
    momentumScore += 3;
  }

  if (
    change1h >= 0.05
  ) {
    momentumScore += 3;
  }

  if (
    change6h > 0
  ) {
    momentumScore += 2;
  }

  if (
    volume1h >=
    MIN_VOLUME_1H_USD
  ) {
    setupScore += 5;
  }

  if (
    volume24h >=
    MIN_VOLUME_24H_USD
  ) {
    setupScore += 5;
  }

  if (
    liquidity >=
    MIN_LIQUIDITY_USD
  ) {
    setupScore += 8;
  }

  if (
    liquidity >=
    2 *
    MIN_LIQUIDITY_USD
  ) {
    setupScore += 3;
  }

  if (
    change6h <=
    STRONG_NEGATIVE_6H &&
    change5m >=
    BOUNCE_5M
  ) {
    setupScore += 6;
  }

  if (
    change5m <=
    STRONG_NEGATIVE_5M
  ) {
    riskPenalty += 8;
  }

  if (
    change1h >=
    EXTREME_1H_MOVE
  ) {
    riskPenalty += 10;
  }

  if (
    change5m >
    MAX_5M_GAIN
  ) {
    riskPenalty += 10;
  }

  if (
    change1h >
    MAX_1H_GAIN
  ) {
    riskPenalty += 10;
  }

  if (
    change6h >
    MAX_6H_GAIN
  ) {
    riskPenalty += 8;
  }

  if (
    change24h >
    MAX_24H_GAIN
  ) {
    riskPenalty += 8;
  }

  let newTokenPenalty = 0;

  if (
    candidate.age_days !== null &&
    candidate.age_days <=
    NEW_TOKEN_MAX_AGE_DAYS
  ) {
    if (
      liquidity <
      NEW_TOKEN_MIN_LIQUIDITY_USD
    ) {
      newTokenPenalty += 20;
    } else {
      setupScore += 5;
    }
  }

  const historicalBonus =
    getHistoricalSetupBonus(
      portfolio,
      candidate
    );

  const score =
    momentumScore +
    setupScore +
    historicalBonus -
    riskPenalty -
    newTokenPenalty;

  return {
    score: round(score, 2),
    momentum_score:
      round(momentumScore, 2),
    setup_score:
      round(setupScore, 2),
    historical_bonus:
      round(
        historicalBonus,
        2
      ),
    risk_penalty:
      round(
        riskPenalty,
        2
      ),
    new_token_penalty:
      round(
        newTokenPenalty,
        2
      )
  };
}

/* ============================================================
FILTERS
============================================================ */
function evaluateCandidate(
  portfolio,
  candidate
) {
  const reasons = [];

  if (
    !candidate?.mint
  ) {
    reasons.push(
      "MISSING_MINT"
    );
  }

  if (
    safeNumber(
      candidate.price_usd
    ) <
    MIN_TOKEN_PRICE
  ) {
    reasons.push(
      "PRICE_TOO_LOW"
    );
  }

  if (
    safeNumber(
      candidate.liquidity_usd
    ) <
    MIN_LIQUIDITY_USD
  ) {
    reasons.push(
      "LIQUIDITY_TOO_LOW"
    );
  }

  if (
    safeNumber(
      candidate.volume_24h_usd
    ) <
    MIN_VOLUME_24H_USD
  ) {
    reasons.push(
      "VOLUME_24H_TOO_LOW"
    );
  }

  if (
    safeNumber(
      candidate.volume_1h_usd
    ) <
    MIN_VOLUME_1H_USD
  ) {
    reasons.push(
      "VOLUME_1H_TOO_LOW"
    );
  }

  if (
    candidate.age_days !== null &&
    candidate.age_days <=
    NEW_TOKEN_MAX_AGE_DAYS &&
    safeNumber(
      candidate.liquidity_usd
    ) <
    NEW_TOKEN_MIN_LIQUIDITY_USD
  ) {
    reasons.push(
      "NEW_TOKEN_LIQUIDITY_TOO_LOW"
    );
  }

  if (
    safeNumber(
      candidate.change_5m
    ) >
    MAX_5M_GAIN
  ) {
    reasons.push(
      "CHASE_5M"
    );
  }

  if (
    safeNumber(
      candidate.change_1h
    ) >
    MAX_1H_GAIN
  ) {
    reasons.push(
      "CHASE_1H"
    );
  }

  if (
    safeNumber(
      candidate.change_6h
    ) >
    MAX_6H_GAIN
  ) {
    reasons.push(
      "CHASE_6H"
    );
  }

  if (
    safeNumber(
      candidate.change_24h
    ) >
    MAX_24H_GAIN
  ) {
    reasons.push(
      "CHASE_24H"
    );
  }

  const cooldownUntil =
    safeNumber(
      portfolio.cooldowns?.[
        candidate.mint
      ]
    );

  if (
    cooldownUntil >
    Date.now()
  ) {
    reasons.push(
      "COOLDOWN"
    );
  }

  const duplicate =
    portfolio.positions.some(
      position =>
        position.mint ===
        candidate.mint
    );

  if (duplicate) {
    reasons.push(
      "ALREADY_HELD"
    );
  }

  return reasons;
}

/* ============================================================
PORTFOLIO VALUE
============================================================ */
function getPositionValue(
  position,
  candidate
) {
  if (
    !position ||
    !candidate
  ) {
    return 0;
  }

  const quantity =
    safeNumber(
      position.quantity
    );

  const price =
    safeNumber(
      candidate.price_usd
    );

  return quantity * price;
}

function calculateEquity(
  portfolio,
  candidateMap
) {
  let equity =
    safeNumber(
      portfolio.cash_usd
    );

  for (
    const position of
    portfolio.positions
  ) {
    const candidate =
      candidateMap.get(
        position.mint
      );

    if (candidate) {
      equity +=
        getPositionValue(
          position,
          candidate
        );
    } else {
      equity +=
        safeNumber(
          position.cost_usd
        );
    }
  }

  return equity;
}

/* ============================================================
COOLDOWNS
============================================================ */
function setCooldown(
  portfolio,
  mint
) {
  portfolio.cooldowns[mint] =
    Date.now() +
    COOLDOWN_SECONDS * 1000;
}

function cleanupCooldowns(
  portfolio
) {
  const now =
    Date.now();

  for (
    const [mint, until] of
    Object.entries(
      portfolio.cooldowns
    )
  ) {
    if (
      safeNumber(until) <=
      now
    ) {
      delete portfolio.cooldowns[mint];
    }
  }
}

/* ============================================================
PAPER BUY
============================================================ */
function paperBuy(
  portfolio,
  candidate,
  amountUsd
) {
  const price =
    safeNumber(
      candidate.price_usd
    );

  if (
    price <= 0
  ) {
    throw new Error(
      "INVALID_BUY_PRICE"
    );
  }

  if (
    amountUsd <= 0
  ) {
    throw new Error(
      "INVALID_BUY_AMOUNT"
    );
  }

  if (
    portfolio.cash_usd <
    amountUsd
  ) {
    throw new Error(
      "INSUFFICIENT_PAPER_CASH"
    );
  }

  const quantity =
    amountUsd /
    price;

  portfolio.cash_usd -=
    amountUsd;

  const position = {
    mint:
      candidate.mint,
    symbol:
      candidate.symbol ||
      null,
    name:
      candidate.name ||
      null,
    entry_price_usd:
      price,
    quantity,
    cost_usd:
      amountUsd,
    peak_price_usd:
      price,
    trailing_active:
      false,
    reversal_confirmations:
      0,
    opened_at:
      nowIso(),
    source:
      candidate.source ||
      null
  };

  portfolio.positions.push(
    position
  );

  addHistory(
    portfolio,
    {
      type: "BUY",
      mode: "PAPER",
      mint:
        candidate.mint,
      symbol:
        candidate.symbol ||
        null,
      amount_usd:
        round(
          amountUsd,
          6
        ),
      price_usd:
        price,
      quantity,
      score:
        candidate.score
    }
  );

  setCooldown(
    portfolio,
    candidate.mint
  );

  return position;
}

/* ============================================================
PAPER SELL
============================================================ */
function paperSell(
  portfolio,
  position,
  candidate,
  reason
) {
  const price =
    safeNumber(
      candidate.price_usd
    );

  if (
    price <= 0
  ) {
    throw new Error(
      "INVALID_SELL_PRICE"
    );
  }

  const proceeds =
    safeNumber(
      position.quantity
    ) * price;

  const pnl =
    proceeds -
    safeNumber(
      position.cost_usd
    );

  portfolio.cash_usd +=
    proceeds;

  portfolio.realized_pnl_usd +=
    pnl;

  portfolio.positions =
    portfolio.positions.filter(
      item =>
        item.mint !==
        position.mint
    );

  addHistory(
    portfolio,
    {
      type: "SELL",
      mode: "PAPER",
      mint:
        position.mint,
      symbol:
        position.symbol ||
        candidate.symbol ||
        null,
      proceeds_usd:
        round(
          proceeds,
          6
        ),
      pnl_usd:
        round(
          pnl,
          6
        ),
      reason
    }
  );

  setCooldown(
    portfolio,
    position.mint
  );

  return {
    proceeds,
    pnl
  };
}

/* ============================================================
EXIT SIGNAL
============================================================ */
function getSellReason(
  position,
  candidate
) {
  const entry =
    safeNumber(
      position.entry_price_usd
    );

  const price =
    safeNumber(
      candidate.price_usd
    );

  if (
    entry <= 0 ||
    price <= 0
  ) {
    return null;
  }

  const pnl =
    (
      price -
      entry
    ) / entry;

  if (
    price >
    safeNumber(
      position.peak_price_usd,
      entry
    )
  ) {
    position.peak_price_usd =
      price;
  }

  if (
    pnl <=
    STOP_LOSS
  ) {
    return "STOP_LOSS";
  }

  if (
    pnl >=
    TRAILING_ACTIVATION
  ) {
    position.trailing_active =
      true;
  }

  if (
    position.trailing_active
  ) {
    const peak =
      safeNumber(
        position.peak_price_usd
      );

    if (
      peak > 0 &&
      price <=
        peak *
        (1 - TRAILING_STOP)
    ) {
      return "TRAILING_STOP";
    }
  }

  if (
    safeNumber(
      candidate.change_5m
    ) <
    -0.03 &&
    safeNumber(
      candidate.change_1h
    ) <
    0
  ) {
    position.reversal_confirmations =
      safeNumber(
        position.reversal_confirmations
      ) + 1;
  } else {
    position.reversal_confirmations =
      0;
  }

  if (
    position.reversal_confirmations >=
    REVERSAL_CONFIRMATIONS_REQUIRED
  ) {
    if (
      pnl >=
      0 &&
      safeNumber(
        candidate.change_1h
      ) <
      -0.05
    ) {
      return "REVERSAL";
    }

    if (
      pnl >
      0 &&
      safeNumber(
        candidate.change_5m
      ) <
      -0.05
    ) {
      return "SHORT_TERM_REVERSAL";
    }
  }

  return null;
}

/* ============================================================
BASE58
============================================================ */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value) {
  const input =
    String(value || "")
      .trim();

  if (!input) {
    throw new Error(
      "EMPTY_BASE58_VALUE"
    );
  }

  const bytes = [0];

  for (const char of input) {
    const index =
      BASE58_ALPHABET.indexOf(
        char
      );

    if (index < 0) {
      throw new Error(
        "INVALID_BASE58_CHARACTER"
      );
    }

    let carry = index;

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {
      const x =
        bytes[i] *
          58 +
        carry;

      bytes[i] =
        x & 0xff;

      carry =
        Math.floor(
          x / 256
        );
    }

    while (carry > 0) {
      bytes.push(
        carry & 0xff
      );

      carry =
        Math.floor(
          carry / 256
        );
    }
  }

  for (
    let i = 0;
    i < input.length &&
    input[i] === "1";
    i++
  ) {
    bytes.push(0);
  }

  return new Uint8Array(
    bytes.reverse()
  );
}

function base58Encode(bytes) {
  if (!bytes?.length) {
    return "";
  }

  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;

    for (
      let i = 0;
      i < digits.length;
      i++
    ) {
      const x =
        digits[i] *
          256 +
        carry;

      digits[i] =
        x % 58;

      carry =
        Math.floor(
          x / 58
        );
    }

    while (carry > 0) {
      digits.push(
        carry % 58
      );

      carry =
        Math.floor(
          carry / 58
        );
    }
  }

  let result = "";

  for (
    let i = 0;
    i < bytes.length &&
    bytes[i] === 0;
    i++
  ) {
    result += "1";
  }

  for (
    let i =
      digits.length - 1;
    i >= 0;
    i--
  ) {
    result +=
      BASE58_ALPHABET[
        digits[i]
      ];
  }

  return result;
}

/* ============================================================
BASE64
============================================================ */
function bytesToBase64(bytes) {
  let binary = "";

  const chunkSize =
    0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(
        i,
        Math.min(
          i + chunkSize,
          bytes.length
        )
      )
    );
  }

  return btoa(binary);
}

function base64ToBytes(value) {
  const binary =
    atob(value);

  const bytes =
    new Uint8Array(
      binary.length
    );

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return bytes;
}

/* ============================================================
LIVE CONFIGURATION
============================================================ */
function requireLiveConfig(env) {
  if (
    PAPER_MODE ||
    !TRANSACTION_EXECUTION
  ) {
    throw new Error(
      "LIVE_TRANSACTION_EXECUTION_DISABLED"
    );
  }

  if (
    !env.SOLANA_RPC_URL
  ) {
    throw new Error(
      "MISSING_SOLANA_RPC_URL"
    );
  }

  if (
    !env.WALLET_PRIVATE_KEY
  ) {
    throw new Error(
      "MISSING_WALLET_PRIVATE_KEY"
    );
  }
}

function parseWalletSecret(env) {
  const raw =
    String(
      env.WALLET_PRIVATE_KEY ||
      ""
    ).trim();

  if (!raw) {
    throw new Error(
      "EMPTY_WALLET_PRIVATE_KEY"
    );
  }

  let bytes = null;

  if (
    raw.startsWith("[")
  ) {
    let parsed;

    try {
      parsed =
        JSON.parse(raw);
    } catch {
      throw new Error(
        "INVALID_WALLET_JSON"
      );
    }

    if (
      !Array.isArray(parsed)
    ) {
      throw new Error(
        "WALLET_JSON_NOT_ARRAY"
      );
    }

    bytes =
      new Uint8Array(
        parsed.map(
          Number
        )
      );
  } else if (
    /^[0-9a-fA-F]+$/.test(raw) &&
    raw.length % 2 === 0
  ) {
    bytes =
      new Uint8Array(
        raw.length / 2
      );

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {
      bytes[i] =
        parseInt(
          raw.slice(
            i * 2,
            i * 2 + 2
          ),
          16
        );
    }
  } else {
    bytes =
      base58Decode(raw);
  }

  if (
    bytes.length !== 64
  ) {
    throw new Error(
      `WALLET_SECRET_MUST_BE_64_BYTES_GOT_${bytes.length}`
    );
  }

  return bytes;
}

/* ============================================================
SOLANA TRANSACTION PARSING
============================================================ */
function readCompactU16(
  bytes,
  offset
) {
  let value = 0;
  let shift = 0;
  let index = offset;

  while (true) {
    if (
      index >= bytes.length
    ) {
      throw new Error(
        "SHORTVEC_OUT_OF_RANGE"
      );
    }

    const byte =
      bytes[index++];

    value |=
      (byte & 0x7f) <<
      shift;

    if (
      (byte & 0x80) === 0
    ) {
      break;
    }

    shift += 7;

    if (shift > 28) {
      throw new Error(
        "SHORTVEC_TOO_LARGE"
      );
    }
  }

  return {
    value,
    nextOffset: index
  };
}

async function signSolanaTransaction(
  serializedTransaction,
  walletSecret
) {
  const transaction =
    base64ToBytes(
      serializedTransaction
    );

  const {
    value: signatureCount,
    nextOffset
  } =
    readCompactU16(
      transaction,
      0
    );

  if (
    signatureCount !== 1
  ) {
    throw new Error(
      `EXPECTED_ONE_REQUIRED_SIGNER_GOT_${signatureCount}`
    );
  }

  const message =
    transaction.slice(
      nextOffset +
        signatureCount * 64
    );

  if (
    message.length === 0
  ) {
    throw new Error(
      "EMPTY_SOLANA_MESSAGE"
    );
  }

  const headerOffset =
    0;

  const numRequiredSignatures =
    message[
      headerOffset
    ];

  if (
    numRequiredSignatures !== 1
  ) {
    throw new Error(
      `EXPECTED_ONE_MESSAGE_SIGNER_GOT_${numRequiredSignatures}`
    );
  }

  const accountCountResult =
    readCompactU16(
      message,
      3
    );

  const accountCount =
    accountCountResult.value;

  const accountStart =
    accountCountResult.nextOffset;

  const accountBytesLength =
    accountCount * 32;

  if (
    accountStart +
      accountBytesLength >
    message.length
  ) {
    throw new Error(
      "ACCOUNT_KEYS_OUT_OF_RANGE"
    );
  }

  const feePayer =
    message.slice(
      accountStart,
      accountStart + 32
    );

  const walletPublicKey =
    walletSecret.slice(
      32,
      64
    );

  if (
    base58Encode(
      feePayer
    ) !==
    base58Encode(
      walletPublicKey
    )
  ) {
    throw new Error(
      "TRANSACTION_FEE_PAYER_DOES_NOT_MATCH_CONFIGURED_WALLET"
    );
  }

  const privateSeed =
    walletSecret.slice(
      0,
      32
    );

  const pkcs8Prefix =
    new Uint8Array([
      0x30,
      0x2e,
      0x02,
      0x01,
      0x00,
      0x30,
      0x05,
      0x06,
      0x03,
      0x2b,
      0x65,
      0x70,
      0x04,
      0x22,
      0x04,
      0x20
    ]);

  const pkcs8 =
    new Uint8Array(
      pkcs8Prefix.length +
      privateSeed.length
    );

  pkcs8.set(
    pkcs8Prefix,
    0
  );

  pkcs8.set(
    privateSeed,
    pkcs8Prefix.length
  );

  const privateKey =
    await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      {
        name: "Ed25519"
      },
      false,
      ["sign"]
    );

  const signature =
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        privateKey,
        message
      )
    );

  if (
    signature.length !== 64
  ) {
    throw new Error(
      "INVALID_ED25519_SIGNATURE_LENGTH"
    );
  }

  const signed =
    new Uint8Array(
      transaction.length
    );

  signed.set(
    transaction
  );

  signed.set(
    signature,
    nextOffset
  );

  return bytesToBase64(
    signed
  );
}

/* ============================================================
SOLANA RPC
============================================================ */
async function solanaRpc(
  env,
  method,
  params = []
) {
  const response =
    await fetch(
      env.SOLANA_RPC_URL,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
          accept:
            "application/json"
        },
        body:
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params
          })
      }
    );

  if (!response.ok) {
    throw new Error(
      `SOLANA_RPC_HTTP_${response.status}`
    );
  }

  const data =
    await response.json();

  if (data.error) {
    throw new Error(
      `SOLANA_RPC_${method}: ${JSON.stringify(
        data.error
      )}`
    );
  }

  return data.result;
}

async function getLiveWalletPublicKey(
  env
) {
  requireLiveConfig(env);

  const secret =
    parseWalletSecret(env);

  return base58Encode(
    secret.slice(
      32,
      64
    )
  );
}

/* ============================================================
SOL USD PRICE
============================================================ */
async function getSolUsdPrice() {
  const result =
    await fetchJsonDiagnostic(
      `${JUPITER_PRICE_API}?ids=${encodeURIComponent(
        "So11111111111111111111111111111111111111112"
      )}`
    );

  if (!result.ok) {
    throw new Error(
      result.error ||
      "SOL_PRICE_LOOKUP_FAILED"
    );
  }

  const price =
    extractJupiterPrice(
      result.data,
      "So11111111111111111111111111111111111111112"
    );

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      "INVALID_SOL_USD_PRICE"
    );
  }

  return price;
}

/* ============================================================
JUPITER LIVE QUOTE
============================================================ */
async function jupiterQuote(
  env,
  inputMint,
  outputMint,
  amount
) {
  const url =
    new URL(
      "https://quote-api.jup.ag/v6/quote"
    );

  url.searchParams.set(
    "inputMint",
    inputMint
  );

  url.searchParams.set(
    "outputMint",
    outputMint
  );

  url.searchParams.set(
    "amount",
    String(amount)
  );

  url.searchParams.set(
    "slippageBps",
    "100"
  );

  const headers = {
    accept:
      "application/json"
  };

  if (
    env.JUPITER_API_KEY
  ) {
    headers["x-api-key"] =
      env.JUPITER_API_KEY;
  }

  return await fetchJson(
    url.toString(),
    {
      headers
    }
  );
}

/* ============================================================
JUPITER SWAP TRANSACTION
============================================================ */
async function jupiterSwapTransaction(
  env,
  quoteResponse,
  userPublicKey
) {
  const headers = {
    "content-type":
      "application/json",
    accept:
      "application/json"
  };

  if (
    env.JUPITER_API_KEY
  ) {
    headers["x-api-key"] =
      env.JUPITER_API_KEY;
  }

  const response =
    await fetch(
      "https://quote-api.jup.ag/v6/swap",
      {
        method: "POST",
        headers,
        body:
          JSON.stringify({
            quoteResponse,
            userPublicKey,
            wrapAndUnwrapSol:
              true,
            dynamicComputeUnitLimit:
              true,
            prioritizationFeeLamports:
              "auto"
          })
      }
    );

  if (!response.ok) {
    let body = "";

    try {
      body =
        await response.text();
    } catch {
      body = "";
    }

    throw new Error(
      `JUPITER_SWAP_HTTP_${response.status}` +
      (
        body
          ? `: ${body.slice(
              0,
              500
            )}`
          : ""
      )
    );
  }

  const data =
    await response.json();

  if (
    !data?.swapTransaction
  ) {
    throw new Error(
      "JUPITER_SWAP_TRANSACTION_MISSING"
    );
  }

  return data;
}

/* ============================================================
BROADCAST / CONFIRM
============================================================ */
async function broadcastAndConfirmLiveTransaction(
  env,
  serializedTransaction
) {
  const walletSecret =
    parseWalletSecret(env);

  const signedTransaction =
    await signSolanaTransaction(
      serializedTransaction,
      walletSecret
    );

  const signature =
    await solanaRpc(
      env,
      "sendTransaction",
      [
        signedTransaction,
        {
          encoding:
            "base64",
          skipPreflight:
            false,
          preflightCommitment:
            "confirmed",
          maxRetries: 2
        }
      ]
    );

  const deadline =
    Date.now() +
    45000;

  let status = null;

  while (
    Date.now() <
    deadline
  ) {
    const result =
      await solanaRpc(
        env,
        "getSignatureStatuses",
        [
          [signature],
          {
            searchTransactionHistory:
              true
          }
        ]
      );

    status =
      result?.value?.[0] ||
      null;

    if (
      status?.err
    ) {
      throw new Error(
        `LIVE_TRANSACTION_FAILED:${JSON.stringify(
          status.err
        )}`
      );
    }

    if (
      status?.confirmationStatus ===
        "confirmed" ||
      status?.confirmationStatus ===
        "finalized"
    ) {
      return {
        signature,
        status
      };
    }

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          1000
        )
    );
  }

  throw new Error(
    `LIVE_TRANSACTION_CONFIRMATION_TIMEOUT:${signature}`
  );
}

/* ============================================================
LIVE SWAP
============================================================ */
async function executeLiveSwap(
  env,
  inputMint,
  outputMint,
  amount,
  userPublicKey
) {
  requireLiveConfig(env);

  const quote =
    await jupiterQuote(
      env,
      inputMint,
      outputMint,
      amount
    );

  if (
    !quote?.outAmount
  ) {
    throw new Error(
      "JUPITER_QUOTE_MISSING_OUT_AMOUNT"
    );
  }

  const swap =
    await jupiterSwapTransaction(
      env,
      quote,
      userPublicKey
    );

  const confirmation =
    await broadcastAndConfirmLiveTransaction(
      env,
      swap.swapTransaction
    );

  return {
    quote,
    swap,
    ...confirmation
  };
}

/* ============================================================
LIVE BUY
============================================================ */
async function liveBuy(
  env,
  portfolio,
  candidate,
  amountUsd
) {
  requireLiveConfig(env);

  if (
    amountUsd >
    MAX_LIVE_TRADE_USD
  ) {
    throw new Error(
      "LIVE_TRADE_LIMIT_EXCEEDED"
    );
  }

  if (
    amountUsd <= 0
  ) {
    throw new Error(
      "INVALID_LIVE_BUY_AMOUNT"
    );
  }

  if (
    portfolio.positions.length >=
    MAX_POSITIONS
  ) {
    throw new Error(
      "MAX_POSITIONS_REACHED"
    );
  }

  if (
    portfolio.positions.some(
      position =>
        position.mint ===
        candidate.mint
    )
  ) {
    throw new Error(
      "TOKEN_ALREADY_HELD"
    );
  }

  if (
    portfolio.cash_usd <
    amountUsd
  ) {
    throw new Error(
      "INSUFFICIENT_LIVE_LEDGER_CASH"
    );
  }

  const solPrice =
    await getSolUsdPrice();

  const lamports =
    Math.floor(
      (
        amountUsd /
        solPrice
      ) *
      1_000_000_000
    );

  if (
    lamports <= 0
  ) {
    throw new Error(
      "LIVE_BUY_LAMPORT_AMOUNT_TOO_SMALL"
    );
  }

  const walletPublicKey =
    await getLiveWalletPublicKey(
      env
    );

  const balance =
    await solanaRpc(
      env,
      "getBalance",
      [
        walletPublicKey,
        {
          commitment:
            "confirmed"
        }
      ]
    );

  const reserveLamports =
    Math.floor(
      0.01 *
      1_000_000_000
    );

  if (
    safeNumber(
      balance?.value
    ) <
    lamports +
    reserveLamports
  ) {
    throw new Error(
      "INSUFFICIENT_ONCHAIN_SOL_RESERVE"
    );
  }

  const result =
    await executeLiveSwap(
      env,
      "So11111111111111111111111111111111111111112",
      candidate.mint,
      lamports,
      walletPublicKey
    );

  const quantityRaw =
    String(
      result.quote.outAmount
    );

  const quantity =
    safeNumber(
      candidate.price_usd
    ) > 0
      ? (
          amountUsd /
          candidate.price_usd
        )
      : 0;

  portfolio.cash_usd -=
    amountUsd;

  const position = {
    mint:
      candidate.mint,
    symbol:
      candidate.symbol ||
      null,
    name:
      candidate.name ||
      null,
    entry_price_usd:
      safeNumber(
        candidate.price_usd
      ),
    quantity,
    quantity_raw:
      quantityRaw,
    cost_usd:
      amountUsd,
    peak_price_usd:
      safeNumber(
        candidate.price_usd
      ),
    trailing_active:
      false,
    reversal_confirmations:
      0,
    opened_at:
      nowIso(),
    source:
      candidate.source ||
      null,
    transaction_signature:
      result.signature,
    input_lamports:
      lamports
  };

  portfolio.positions.push(
    position
  );

  addHistory(
    portfolio,
    {
      type: "BUY",
      mode: "LIVE",
      mint:
        candidate.mint,
      symbol:
        candidate.symbol ||
        null,
      amount_usd:
        round(
          amountUsd,
          6
        ),
      price_usd:
        candidate.price_usd,
      quantity,
      quantity_raw:
        quantityRaw,
      transaction_signature:
        result.signature,
      score:
        candidate.score
    }
  );

  setCooldown(
    portfolio,
    candidate.mint
  );

  return position;
}

/* ============================================================
LIVE SELL
============================================================ */
async function liveSell(
  env,
  portfolio,
  position,
  candidate,
  reason
) {
  requireLiveConfig(env);

  const quantityRaw =
    String(
      position.quantity_raw ||
      ""
    );

  if (
    !quantityRaw ||
    quantityRaw === "0"
  ) {
    throw new Error(
      "LIVE_POSITION_MISSING_RAW_TOKEN_AMOUNT"
    );
  }

  const walletPublicKey =
    await getLiveWalletPublicKey(
      env
    );

  const result =
    await executeLiveSwap(
      env,
      candidate.mint,
      "So11111111111111111111111111111111111111112",
      quantityRaw,
      walletPublicKey
    );

  const solOutLamports =
    safeNumber(
      result.quote.outAmount
    );

  const solPrice =
    await getSolUsdPrice();

  const proceeds =
    (
      solOutLamports /
      1_000_000_000
    ) *
    solPrice;

  const pnl =
    proceeds -
    safeNumber(
      position.cost_usd
    );

  portfolio.cash_usd +=
    proceeds;

  portfolio.realized_pnl_usd +=
    pnl;

  portfolio.positions =
    portfolio.positions.filter(
      item =>
        item.mint !==
        position.mint
    );

  addHistory(
    portfolio,
    {
      type: "SELL",
      mode: "LIVE",
      mint:
        position.mint,
      symbol:
        position.symbol ||
        candidate.symbol ||
        null,
      proceeds_usd:
        round(
          proceeds,
          6
        ),
      pnl_usd:
        round(
          pnl,
          6
        ),
      output_lamports:
        solOutLamports,
      transaction_signature:
        result.signature,
      reason
    }
  );

  setCooldown(
    portfolio,
    position.mint
  );

  return {
    proceeds,
    pnl,
    signature:
      result.signature
  };
}

/* ============================================================
LIVE STATUS
============================================================ */
function liveBetaExecutionStatus(
  env
) {
  return {
    paper_mode:
      PAPER_MODE,
    live_beta_mode:
      LIVE_BETA_MODE,
    transaction_execution:
      TRANSACTION_EXECUTION,
    automatic_signing:
      !PAPER_MODE &&
      TRANSACTION_EXECUTION &&
      !!env.WALLET_PRIVATE_KEY,
    automatic_broadcast:
      !PAPER_MODE &&
      TRANSACTION_EXECUTION &&
      !!env.SOLANA_RPC_URL &&
      !!env.WALLET_PRIVATE_KEY,
    required_secrets: {
      SOLANA_RPC_URL:
        !!env.SOLANA_RPC_URL,
      WALLET_PRIVATE_KEY:
        !!env.WALLET_PRIVATE_KEY,
      LIVE_EXECUTION_TOKEN:
        !!env.LIVE_EXECUTION_TOKEN
    }
  };
}

/* ============================================================
SCAN
============================================================ */
async function runScan(env) {
  const discovery =
    createDiscoveryDiagnostics();

  const [
    dexDiscovery,
    dexSearch,
    geckoDiscovery
  ] =
    await Promise.all([
      getDexDiscovery(),
      getDexSearch(),
      getGeckoCandidates()
    ]);

  Object.assign(
    discovery,
    dexDiscovery.diagnostics
  );

  discovery.dexscreener_search =
    dexSearch.diagnostics;

  discovery.gecko_trending =
    geckoDiscovery
      .diagnostics
      .gecko_trending;

  discovery.gecko_top_pools =
    geckoDiscovery
      .diagnostics
      .gecko_top_pools;

  discovery.gecko_new_pools =
    geckoDiscovery
      .diagnostics
      .gecko_new_pools;

  const sources = [
    ...dexDiscovery.results,
    ...dexSearch.results,
    ...geckoDiscovery.mints.map(
      mint => ({
        mint,
        source:
          "GECKOTERMINAL"
      })
    )
  ];

  const mintSource =
    new Map();

  for (const item of sources) {
    if (
      !item?.mint
    ) {
      continue;
    }

    if (
      !mintSource.has(
        item.mint
      )
    ) {
      mintSource.set(
        item.mint,
        item.source
      );
    }
  }

  const mints =
    [
      ...mintSource.keys()
    ].slice(
      0,
      MAX_CANDIDATES
    );

  const [
    dexHydration,
    geckoHydration,
    jupiter
  ] =
    await Promise.all([
      hydrateDexPairs(
        mints
      ),
      hydrateGeckoPools(
        mints
      ),
      getJupiterPrices(
        mints
      )
    ]);

  const candidates = [];

  for (const mint of mints) {
    const candidate =
      normalizeCandidate(
        mint,
        dexHydration.hydrated.get(
          mint
        ),
        geckoHydration.hydrated.get(
          mint
        ),
        jupiter.prices[mint],
        mintSource.get(mint)
      );

    const scoring =
      scoreCandidate(
        await loadPortfolio(env),
        candidate
      );

    Object.assign(
      candidate,
      scoring
    );

    candidate.filter_reasons =
      evaluateCandidate(
        await loadPortfolio(env),
        candidate
      );

    candidates.push(
      candidate
    );
  }

  candidates.sort(
    (a, b) =>
      safeNumber(
        b.score
      ) -
      safeNumber(
        a.score
      )
  );

  return {
    candidates:
      candidates.slice(
        0,
        MAX_CANDIDATES
      ),
    diagnostics: {
      discovery,
      dex_hydration:
        dexHydration.diagnostics,
      gecko_hydration:
        geckoHydration.diagnostics,
      jupiter:
        jupiter.diagnostics
    }
  };
}

/* ============================================================
ENGINE
============================================================ */
async function runPaperEngine(
  env,
  portfolio,
  scan
) {
  if (
    !PAPER_MODE &&
    !TRANSACTION_EXECUTION
  ) {
    throw new Error(
      "NO_EXECUTION_MODE_ENABLED"
    );
  }

  cleanupCooldowns(
    portfolio
  );

  const candidateMap =
    new Map(
      scan.candidates.map(
        candidate => [
          candidate.mint,
          candidate
        ]
      )
    );

  let sells = 0;

  for (
    const position of
    [...portfolio.positions]
  ) {
    const candidate =
      candidateMap.get(
        position.mint
      );

    if (!candidate) {
      continue;
    }

    const reason =
      getSellReason(
        position,
        candidate
      );

    if (!reason) {
      continue;
    }

    if (PAPER_MODE) {
      paperSell(
        portfolio,
        position,
        candidate,
        reason
      );
    } else {
      await liveSell(
        env,
        portfolio,
        position,
        candidate,
        reason
      );
    }

    sells++;
  }

  let buys = 0;

  if (
    portfolio.positions.length <
    MAX_POSITIONS
  ) {
    const equity =
      calculateEquity(
        portfolio,
        candidateMap
      );

    const positionSize =
      PAPER_MODE
        ? getPositionSize(
            equity
          )
        : MAX_LIVE_TRADE_USD;

    for (
      const candidate of
      scan.candidates
    ) {
      if (
        buys >=
        MAX_NEW_BUYS_PER_RUN
      ) {
        break;
      }

      if (
        candidate.score <
        MIN_ENTRY_SCORE
      ) {
        continue;
      }

      if (
        candidate.momentum_score <
        MIN_MOMENTUM_SCORE
      ) {
        continue;
      }

      if (
        candidate.setup_score <
        MIN_SETUP_SCORE
      ) {
        continue;
      }

      const reasons =
        evaluateCandidate(
          portfolio,
          candidate
        );

      if (
        reasons.length
      ) {
        continue;
      }

      if (
        portfolio.cash_usd <
        positionSize
      ) {
        continue;
      }

      if (
        portfolio.cash_usd -
        positionSize <
        MIN_CASH_RESERVE_USD
      ) {
        continue;
      }

      if (PAPER_MODE) {
        paperBuy(
          portfolio,
          candidate,
          positionSize
        );
      } else {
        await liveBuy(
          env,
          portfolio,
          candidate,
          positionSize
        );
      }

      buys++;
    }
  }

  for (
    const candidate of
    scan.candidates
  ) {
    recordMarketObservation(
      portfolio,
      candidate
    );
  }

  return {
    buys,
    sells,
    positions:
      portfolio.positions.length
  };
}

/* ============================================================
AUTHORIZATION
============================================================ */
async function requireExecutionAuthorization(
  request,
  env
) {
  if (
    PAPER_MODE ||
    !TRANSACTION_EXECUTION
  ) {
    return;
  }

  const expected =
    String(
      env.LIVE_EXECUTION_TOKEN ||
      ""
    );

  if (!expected) {
    throw new Error(
      "MISSING_LIVE_EXECUTION_TOKEN"
    );
  }

  const header =
    request.headers.get(
      "authorization"
    ) || "";

  const prefix =
    "Bearer ";

  if (
    !header.startsWith(
      prefix
    )
  ) {
    throw new Error(
      "LIVE_EXECUTION_AUTH_REQUIRED"
    );
  }

  const supplied =
    header.slice(
      prefix.length
    );

  const encoder =
    new TextEncoder();

  const a =
    encoder.encode(
      supplied
    );

  const b =
    encoder.encode(
      expected
    );

  if (
    a.length !==
    b.length
  ) {
    throw new Error(
      "LIVE_EXECUTION_UNAUTHORIZED"
    );
  }

  const equal =
    crypto.subtle.timingSafeEqual(
      a,
      b
    );

  if (!equal) {
    throw new Error(
      "LIVE_EXECUTION_UNAUTHORIZED"
    );
  }
}

/* ============================================================
RESPONSE HELPERS
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
          "application/json; charset=utf-8",
        "cache-control":
          "no-store"
      }
    }
  );
}

/* ============================================================
HEALTH
============================================================ */
async function health(env) {
  return {
    ok: true,
    bot:
      BOT_NAME,
    mode: {
      type:
        PAPER_MODE
          ? "PAPER"
          : "LIVE",
      live_beta:
        LIVE_BETA_MODE,
      transaction_execution:
        TRANSACTION_EXECUTION
    },
    execution:
      liveBetaExecutionStatus(
        env
      ),
    scanner_status:
      "OK",
    time:
      nowIso()
  };
}

/* ============================================================
STATUS
============================================================ */
async function status(env) {
  const portfolio =
    await loadPortfolio(
      env
    );

  return {
    ok: true,
    bot:
      BOT_NAME,
    mode: {
      type:
        PAPER_MODE
          ? "PAPER"
          : "LIVE",
      live_beta:
        LIVE_BETA_MODE,
      transaction_execution:
        TRANSACTION_EXECUTION
    },
    execution:
      liveBetaExecutionStatus(
        env
      ),
    portfolio: {
      schema_version:
        portfolio.schema_version,
      starting_cash_usd:
        portfolio.starting_cash_usd,
      cash_usd:
        round(
          portfolio.cash_usd,
          6
        ),
      realized_pnl_usd:
        round(
          portfolio.realized_pnl_usd,
          6
        ),
      positions:
        portfolio.positions,
      history_count:
        portfolio.history.length,
      market_memory_count:
        Object.keys(
          portfolio.market_memory ||
            {}
        ).length
    },
    time:
      nowIso()
  };
}

/* ============================================================
RESET
============================================================ */
async function resetPortfolio(
  env
) {
  const portfolio =
    createEmptyPortfolio();

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
    reset: true,
    portfolio
  };
}

/* ============================================================
REQUEST HANDLER
============================================================ */
async function handleRequest(
  request,
  env
) {
  const url =
    new URL(
      request.url
    );

  const pathname =
    url.pathname;

  if (
    request.method ===
      "GET" &&
    pathname ===
      "/health"
  ) {
    return jsonResponse(
      await health(env)
    );
  }

  if (
    request.method ===
      "GET" &&
    pathname ===
      "/status"
  ) {
    return jsonResponse(
      await status(env)
    );
  }

  if (
    request.method ===
      "GET" &&
    pathname ===
      "/scan"
  ) {
    try {
      const scan =
        await runScan(
          env
        );

      return jsonResponse({
        ok: true,
        bot:
          BOT_NAME,
        scanner_status:
          "OK",
        scan
      });
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error:
            errorText(error)
        },
        500
      );
    }
  }

  if (
    request.method ===
      "POST" &&
    pathname ===
      "/run"
  ) {
    try {
      await requireExecutionAuthorization(
        request,
        env
      );

      const portfolio =
        await loadPortfolio(
          env
        );

      const scan =
        await runScan(
          env
        );

      const engine =
        await runPaperEngine(
          env,
          portfolio,
          scan
        );

      const persist =
        await savePortfolio(
          env,
          portfolio,
          PAPER_MODE
            ? "TRADE"
            : "LIVE_TRADE"
        );

      return jsonResponse({
        ok: true,
        bot:
          BOT_NAME,
        mode:
          PAPER_MODE
            ? "PAPER"
            : "LIVE",
        engine,
        persist,
        scan: {
          candidate_count:
            scan.candidates.length,
          top_candidates:
            scan.candidates.slice(
              0,
              10
            )
        },
        portfolio: {
          cash_usd:
            round(
              portfolio.cash_usd,
              6
            ),
          realized_pnl_usd:
            round(
              portfolio.realized_pnl_usd,
              6
            ),
          positions:
            portfolio.positions
        }
      });
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error:
            errorText(error)
        },
        500
      );
    }
  }

  if (
    request.method ===
      "POST" &&
    pathname ===
      "/reset"
  ) {
    try {
      await requireExecutionAuthorization(
        request,
        env
      );

      return jsonResponse(
        await resetPortfolio(
          env
        )
      );
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error:
            errorText(error)
        },
        500
      );
    }
  }

  return jsonResponse(
    {
      ok: false,
      error:
        "NOT_FOUND"
    },
    404
  );
}

/* ============================================================
SCHEDULED RUN
============================================================ */
async function scheduledRun(
  env
) {
  const portfolio =
    await loadPortfolio(
      env
    );

  const scan =
    await runScan(
      env
    );

  const engine =
    await runPaperEngine(
      env,
      portfolio,
      scan
    );

  if (
    checkpointDue(
      portfolio
    ) ||
    engine.buys > 0 ||
    engine.sells > 0
  ) {
    await savePortfolio(
      env,
      portfolio,
      PAPER_MODE
        ? "TRADE"
        : "LIVE_TRADE",
      {
        force:
          engine.buys > 0 ||
          engine.sells > 0
      }
    );
  }
}

/* ============================================================
WORKER EXPORT
============================================================ */
export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      return await handleRequest(
        request,
        env
      );
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          bot:
            BOT_NAME,
          error:
            errorText(error)
        },
        500
      );
    }
  },

  async scheduled(
    controller,
    env,
    ctx
  ) {
    ctx.waitUntil(
      scheduledRun(
        env
      )
    );
  }
};
