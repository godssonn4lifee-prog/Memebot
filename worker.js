const BOT_NAME = "memebott";

/*
============================================================
MEMEBOTT — LIVE TRADING — SCHEMA 5
============================================================

LIVE ONLY

- Jupiter price / quote / swap execution
- DexScreener discovery + search + token hydration
- $20 maximum tracked bankroll
- $2 maximum live trade
- $10 minimum ledger cash reserve
- 0.01 SOL on-chain reserve
- Maximum 7 positions
- Maximum 1 new buy per run
- Stop loss / trailing stop / reversal protection
- Candidate scoring and market memory
- BOT_KV persistence
- Scheduled automatic execution
- Persistent runtime diagnostics
- Bounded confirmation polling
- No public live execution HTTP endpoints

DEX DISCOVERY
- DexScreener token profiles
- DexScreener latest boosts
- DexScreener top boosts
- DexScreener SOL search
- DexScreener meme search
- DexScreener pump search
- DexScreener token hydration
- Jupiter remains the price verification layer
- GeckoTerminal is not used

LIVE SAFETY
- Minimum entry score: 15
- Minimum momentum score: 0
- DEX/Jupiter severe price mismatch rejection
- $2 maximum live trade
- $20 maximum tracked bankroll
- $10 minimum ledger reserve
- 0.01 SOL on-chain reserve
- Maximum 7 positions
- Maximum 1 new buy per scheduled run

DEX RATE-LIMIT PROTECTION
- One global DexScreener cooldown
- Global cooldown covers discovery, search, and hydration
- 429 / Cloudflare 1015 immediately stops further Dex calls
- Global cooldown is persisted in BOT_KV
- Cron runs do not clear an active Dex cooldown
- DexScreener is not contacted while global cooldown is active
- Jupiter continues refreshing known positions / market memory
============================================================
*/

/* ============================================================
CONFIG
============================================================ */

const LIVE_BETA_MODE = true;
const TRANSACTION_EXECUTION = true;
const SCHEMA_VERSION = 5;

const STARTING_CASH_USD = 20;
const MIN_CASH_RESERVE_USD = 10;
const MAX_LIVE_BANKROLL_USD = 20;

const MAX_POSITIONS = 7;
const MAX_NEW_BUYS_PER_RUN = 1;
const MAX_LIVE_TRADE_USD = 2;
const COOLDOWN_SECONDS = 60;

const MIN_SOL_RESERVE = 0.01;

const MIN_PERSIST_INTERVAL_SECONDS = 120;

const MAX_MEMORY_CANDIDATES = 12;
const MAX_MEMORY_OBSERVATIONS = 4;
const MIN_HISTORY_OBSERVATIONS = 2;

const STOP_LOSS = -0.01;
const TRAILING_ACTIVATION = 0.01;
const TRAILING_STOP = 0.03;

const REVERSAL_CONFIRMATIONS_REQUIRED = 2;
const SHORT_TERM_SELL_RATIO = 1.50;
const HOURLY_SELL_RATIO = 1.43;

const MIN_ENTRY_SCORE = 15;
const MIN_MOMENTUM_SCORE = 0;
const MIN_SETUP_SCORE = 3;

const MAX_HISTORICAL_SETUP_BONUS = 15;

const MIN_TOKEN_PRICE = 0.00000001;
const MIN_LIQUIDITY_USD = 10000;
const MIN_VOLUME_24H_USD = 5000;
const MIN_VOLUME_1H_USD = 500;

const MAX_5M_GAIN = 0.15;
const MAX_1H_GAIN = 0.45;
const MAX_6H_GAIN = 1.00;
const MAX_24H_GAIN = 5.00;

const NEW_TOKEN_MAX_AGE_DAYS = 1;
const NEW_TOKEN_MIN_LIQUIDITY_USD = 15000;

const EXTREME_1H_MOVE = 0.50;
const STRONG_NEGATIVE_6H = -0.15;
const STRONG_NEGATIVE_5M = -0.03;
const BOUNCE_5M = 0.07;

const MAX_CANDIDATES = 30;

const DEX_SEARCH_QUERIES = [
  "SOL",
  "meme",
  "pump"
];

const DEX_DISCOVERY_ENDPOINTS = [
  {
    name: "token_profiles",
    path: "/token-profiles/latest/v1"
  },
  {
    name: "latest_boosts",
    path: "/token-boosts/latest/v1"
  },
  {
    name: "top_boosts",
    path: "/token-boosts/top/v1"
  }
];

const MAX_DEX_HYDRATIONS = 20;

const MAX_JUPITER_PRICE_CHECKS = 20;

const MAX_EXTERNAL_REQUEST_BUDGET = 30;

const MAX_CONFIRMATION_POLLS = 3;
const CONFIRMATION_POLL_INTERVAL_MS = 2500;

/*
Global DexScreener backoff.

A single 429 / 1015 causes ALL DexScreener request types
to stop until this global cooldown expires.
*/
const DEX_BACKOFF_BASE_SECONDS = 60;
const DEX_BACKOFF_MAX_SECONDS = 300;

const MAX_PRICE_MISMATCH_RATIO = 0.25;

const DEX_BASE = "https://api.dexscreener.com";
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const PORTFOLIO_KEY = "LIVE_BETA_PORTFOLIO";

const RUNTIME_COUNTER_VERSION = 3;

/* ============================================================
UTILITY
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

function compactError(error) {
  return errorText(error).slice(0, 1000);
}

function logEvent(event, data = {}) {
  try {
    console.log(
      JSON.stringify({
        bot: BOT_NAME,
        event,
        time: nowIso(),
        ...data
      })
    );
  } catch {
    console.log(`MEMEBOTT ${event}`);
  }
}

function logError(event, error, data = {}) {
  try {
    console.error(
      JSON.stringify({
        bot: BOT_NAME,
        event,
        time: nowIso(),
        error: compactError(error),
        ...data
      })
    );
  } catch {
    console.error(
      `MEMEBOTT ${event}: ${compactError(error)}`
    );
  }
}

function relativePriceDifference(a, b) {
  const first = safeNumber(a);
  const second = safeNumber(b);

  if (first <= 0 || second <= 0) {
    return null;
  }

  return Math.abs(first - second) /
    Math.min(first, second);
}

/* ============================================================
FETCH
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

async function fetchJsonSafe(url, options = {}) {
  const started = Date.now();

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.headers || {})
      }
    });

    const duration = Date.now() - started;

    if (!response.ok) {
      let body = "";

      try {
        body = await response.text();
      } catch {}

      return {
        ok: false,
        status: response.status,
        data: null,
        error: `HTTP ${response.status}`,
        body_preview: body.slice(0, 300),
        duration_ms: duration
      };
    }

    let data;

    try {
      data = await response.json();
    } catch (error) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: `INVALID_JSON:${errorText(error)}`,
        body_preview: null,
        duration_ms: duration
      };
    }

    return {
      ok: true,
      status: response.status,
      data,
      error: null,
      body_preview: null,
      duration_ms: duration
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      data: null,
      error: errorText(error),
      body_preview: null,
      duration_ms: Date.now() - started
    };
  }
}

function responseWasRateLimited(response) {
  if (safeNumber(response?.status) === 429) {
    return true;
  }

  const text =
    `${response?.error || ""} ${response?.body_preview || ""}`
      .toLowerCase();

  return (
    text.includes("1015") ||
    text.includes("rate limit") ||
    text.includes("too many requests")
  );
}

/* ============================================================
PORTFOLIO
============================================================ */

function createRuntimeState() {
  return {
    last_scheduled_run_at: null,
    last_scheduled_run_ok: null,
    last_scheduled_error: null,
    last_run_duration_ms: 0,

    last_run_outcome: null,
    last_run_rate_limited: false,

    last_scan_candidate_count: 0,
    last_eligible_candidate_count: 0,
    last_buy_count: 0,
    last_sell_count: 0,
    last_positions_count: 0,
    last_top_candidate: null,

    last_trade_signature: null,
    last_trade_type: null,

    total_scheduled_runs: 0,
    total_successful_scheduled_runs: 0,
    total_failed_scheduled_runs: 0,
    total_rate_limited_runs: 0,

    last_scan_diagnostics: null,

    /*
    Global DexScreener protection.
    */
    dex_rate_limit_count: 0,
    dex_backoff_until: 0,
    dex_backoff_seconds: 0,
    last_dex_rate_limit_at: null,

    /*
    Retained for compatibility with previously stored
    diagnostics. These are no longer used as the primary
    protection mechanism.
    */
    dex_query_backoff_untils: {},
    dex_query_backoff_counts: {},

    runtime_counter_version:
      RUNTIME_COUNTER_VERSION,

    current_stage: null,
    current_stage_started_at: null,
    last_completed_stage: null,
    last_completed_stage_at: null,
    last_error_stage: null,
    last_error_time: null
  };
}

function createEmptyPortfolio() {
  return {
    schema_version: SCHEMA_VERSION,
    mode: "LIVE",

    starting_cash_usd:
      STARTING_CASH_USD,

    cash_usd:
      STARTING_CASH_USD,

    realized_pnl_usd: 0,

    positions: [],
    history: [],
    cooldowns: {},
    market_memory: {},

    runtime:
      createRuntimeState(),

    created_at:
      nowIso(),

    updated_at:
      nowIso(),

    last_persist_at: 0,
    last_persist_reason: null
  };
}

function migrateRuntimeCounters(portfolio) {
  const runtime =
    portfolio.runtime ||
    createRuntimeState();

  if (
    safeNumber(
      runtime.runtime_counter_version
    ) !== RUNTIME_COUNTER_VERSION
  ) {
    /*
    Do not erase the scheduled counters merely because
    the runtime diagnostic schema changed.
    */
    runtime.total_scheduled_runs =
      Math.max(
        0,
        Math.floor(
          safeNumber(
            runtime.total_scheduled_runs
          )
        )
      );

    runtime.total_successful_scheduled_runs =
      Math.max(
        0,
        Math.floor(
          safeNumber(
            runtime.total_successful_scheduled_runs
          )
        )
      );

    runtime.total_failed_scheduled_runs =
      Math.max(
        0,
        Math.floor(
          safeNumber(
            runtime.total_failed_scheduled_runs
          )
        )
      );

    runtime.total_rate_limited_runs =
      Math.max(
        0,
        Math.floor(
          safeNumber(
            runtime.total_rate_limited_runs
          )
        )
      );

    runtime.runtime_counter_version =
      RUNTIME_COUNTER_VERSION;

    logEvent(
      "RUNTIME_COUNTERS_MIGRATED",
      {
        version:
          RUNTIME_COUNTER_VERSION
      }
    );
  }

  runtime.total_scheduled_runs =
    Math.max(
      0,
      Math.floor(
        safeNumber(
          runtime.total_scheduled_runs
        )
      )
    );

  runtime.total_successful_scheduled_runs =
    Math.max(
      0,
      Math.floor(
        safeNumber(
          runtime.total_successful_scheduled_runs
        )
      )
    );

  runtime.total_failed_scheduled_runs =
    Math.max(
      0,
      Math.floor(
        safeNumber(
          runtime.total_failed_scheduled_runs
        )
      )
    );

  runtime.total_rate_limited_runs =
    Math.max(
      0,
      Math.floor(
        safeNumber(
          runtime.total_rate_limited_runs
        )
      )
    );

  portfolio.runtime = runtime;
}

/*
Normalize the persisted DexScreener backoff without clearing
an active cooldown.

This is the critical fix for the repeated cron 429 problem.
*/
function migrateDexBackoff(portfolio) {
  const runtime =
    portfolio.runtime ||
    createRuntimeState();

  const now =
    Date.now();

  const storedUntil =
    safeNumber(
      runtime.dex_backoff_until
    );

  const storedSeconds =
    safeNumber(
      runtime.dex_backoff_seconds
    );

  /*
  Never clear a future global cooldown.
  If an old cooldown has already expired, clear only the
  expired timer fields.
  */
  if (
    storedUntil > now
  ) {
    runtime.dex_backoff_until =
      storedUntil;

    runtime.dex_backoff_seconds =
      Math.ceil(
        (
          storedUntil -
          now
        ) / 1000
      );
  } else {
    runtime.dex_backoff_until = 0;
    runtime.dex_backoff_seconds = 0;
  }

  /*
  Preserve the accumulated global rate-limit count.
  */
  runtime.dex_rate_limit_count =
    Math.max(
      0,
      Math.floor(
        safeNumber(
          runtime.dex_rate_limit_count
        )
      )
    );

  /*
  Retain legacy query maps but clean expired entries.
  They are no longer used to decide whether DexScreener
  should be contacted.
  */
  runtime.dex_query_backoff_untils =
    runtime.dex_query_backoff_untils &&
    typeof runtime.dex_query_backoff_untils ===
      "object"
      ? runtime.dex_query_backoff_untils
      : {};

  runtime.dex_query_backoff_counts =
    runtime.dex_query_backoff_counts &&
    typeof runtime.dex_query_backoff_counts ===
      "object"
      ? runtime.dex_query_backoff_counts
      : {};

  for (
    const query of
    Object.keys(
      runtime.dex_query_backoff_untils
    )
  ) {
    const until =
      safeNumber(
        runtime.dex_query_backoff_untils[
          query
        ]
      );

    if (
      until <= now
    ) {
      delete runtime.dex_query_backoff_untils[
        query
      ];
    }
  }

  portfolio.runtime = runtime;
}

async function loadPortfolio(env) {
  if (!env.BOT_KV) {
    throw new Error(
      "MISSING_BOT_KV_BINDING"
    );
  }

  const raw =
    await env.BOT_KV.get(
      PORTFOLIO_KEY
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
      ) !== SCHEMA_VERSION ||
      portfolio.mode !== "LIVE"
    ) {
      logEvent(
        "PORTFOLIO_RESET_SCHEMA_MISMATCH",
        {
          stored_schema:
            portfolio.schema_version,
          stored_mode:
            portfolio.mode
        }
      );

      return createEmptyPortfolio();
    }

    portfolio.positions ||= [];
    portfolio.history ||= [];
    portfolio.cooldowns ||= {};
    portfolio.market_memory ||= {};

    portfolio.runtime = {
      ...createRuntimeState(),
      ...(portfolio.runtime || {})
    };

    portfolio.cash_usd =
      clamp(
        safeNumber(
          portfolio.cash_usd,
          STARTING_CASH_USD
        ),
        0,
        MAX_LIVE_BANKROLL_USD
      );

    portfolio.realized_pnl_usd =
      safeNumber(
        portfolio.realized_pnl_usd
      );

    portfolio.last_persist_at =
      safeNumber(
        portfolio.last_persist_at
      );

    migrateRuntimeCounters(
      portfolio
    );

    migrateDexBackoff(
      portfolio
    );

    cleanupCooldowns(
      portfolio
    );

    cleanupMarketMemory(
      portfolio
    );

    return portfolio;
  } catch (error) {
    logError(
      "PORTFOLIO_PARSE_FAILED_RESETTING",
      error
    );

    return createEmptyPortfolio();
  }
}

function persistenceAgeMs(portfolio) {
  const last =
    safeNumber(
      portfolio.last_persist_at
    );

  return last
    ? Date.now() - last
    : Infinity;
}

async function savePortfolio(
  env,
  portfolio,
  reason,
  force = false
) {
  if (!env.BOT_KV) {
    throw new Error(
      "MISSING_BOT_KV_BINDING"
    );
  }

  if (
    !force &&
    persistenceAgeMs(portfolio) <
      MIN_PERSIST_INTERVAL_SECONDS * 1000
  ) {
    return {
      saved: false,
      throttled: true,
      reason
    };
  }

  const persistedAt =
    Date.now();

  const payload = {
    ...portfolio,

    mode:
      "LIVE",

    schema_version:
      SCHEMA_VERSION,

    updated_at:
      new Date(
        persistedAt
      ).toISOString(),

    last_persist_at:
      persistedAt,

    last_persist_reason:
      reason
  };

  await env.BOT_KV.put(
    PORTFOLIO_KEY,
    JSON.stringify(payload)
  );

  portfolio.updated_at =
    payload.updated_at;

  portfolio.last_persist_at =
    persistedAt;

  portfolio.last_persist_reason =
    reason;

  return {
    saved: true,
    throttled: false,
    reason
  };
}

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

function setStage(
  portfolio,
  stage
) {
  if (!portfolio?.runtime) {
    return;
  }

  portfolio.runtime.current_stage =
    stage;

  portfolio.runtime.current_stage_started_at =
    nowIso();

  logEvent(
    "STAGE_START",
    { stage }
  );
}

function completeStage(
  portfolio,
  stage
) {
  if (!portfolio?.runtime) {
    return;
  }

  portfolio.runtime.last_completed_stage =
    stage;

  portfolio.runtime.last_completed_stage_at =
    nowIso();

  logEvent(
    "STAGE_COMPLETE",
    { stage }
  );
}

function failStage(
  portfolio,
  stage,
  error
) {
  if (!portfolio?.runtime) {
    return;
  }

  portfolio.runtime.last_error_stage =
    stage;

  portfolio.runtime.last_error_time =
    nowIso();

  portfolio.runtime.current_stage =
    stage;

  logError(
    "STAGE_FAILED",
    error,
    { stage }
  );
}

/* ============================================================
GLOBAL DEXSCREENER BACKOFF
============================================================ */

/*
Returns true whenever ANY global DexScreener cooldown is
currently active.

This is the only gate used before DexScreener network calls.
*/
function dexGlobalBackoffActive(
  portfolio
) {
  const until =
    safeNumber(
      portfolio?.runtime
        ?.dex_backoff_until
    );

  return until > Date.now();
}

function dexGlobalBackoffRemainingSeconds(
  portfolio
) {
  const until =
    safeNumber(
      portfolio?.runtime
        ?.dex_backoff_until
    );

  return Math.max(
    0,
    Math.ceil(
      (
        until -
        Date.now()
      ) / 1000
    )
  );
}

/*
Register one global DexScreener rate limit.

Important:
- discovery
- search
- hydration

all call this same function.

A 429 therefore creates one shared cooldown rather than
three independent retry loops.
*/
function registerDexRateLimit(
  portfolio,
  source = "UNKNOWN"
) {
  if (!portfolio.runtime) {
    portfolio.runtime =
      createRuntimeState();
  }

  const previousCount =
    safeNumber(
      portfolio.runtime.dex_rate_limit_count
    );

  const count =
    Math.min(
      previousCount + 1,
      6
    );

  /*
  1st hit  = 60s
  2nd hit  = 120s
  3rd+ hit = 240s
  capped at 300s.
  */
  const exponent =
    Math.min(
      count - 1,
      2
    );

  const seconds =
    Math.min(
      DEX_BACKOFF_MAX_SECONDS,
      DEX_BACKOFF_BASE_SECONDS *
        (2 ** exponent)
    );

  const now =
    Date.now();

  /*
  Never shorten an already-active cooldown.
  */
  const existingUntil =
    safeNumber(
      portfolio.runtime.dex_backoff_until
    );

  const newUntil =
    Math.max(
      existingUntil,
      now +
        seconds * 1000
    );

  portfolio.runtime.dex_rate_limit_count =
    count;

  portfolio.runtime.dex_backoff_until =
    newUntil;

  portfolio.runtime.dex_backoff_seconds =
    Math.ceil(
      (
        newUntil -
        now
      ) / 1000
    );

  portfolio.runtime.last_dex_rate_limit_at =
    nowIso();

  logEvent(
    "DEX_GLOBAL_RATE_LIMIT_BACKOFF",
    {
      source,
      count,
      backoff_seconds:
        portfolio.runtime
          .dex_backoff_seconds,
      backoff_until:
        new Date(
          newUntil
        ).toISOString()
    }
  );
}

/*
When the cooldown has naturally expired, remove only the
active timer. Keep the historical rate-limit count for
diagnostics.
*/
function clearExpiredDexBackoff(
  portfolio
) {
  if (!portfolio?.runtime) {
    return;
  }

  const until =
    safeNumber(
      portfolio.runtime.dex_backoff_until
    );

  if (
    until > 0 &&
    until <= Date.now()
  ) {
    portfolio.runtime.dex_backoff_until =
      0;

    portfolio.runtime.dex_backoff_seconds =
      0;
  }
}

/*
Compatibility helper for old query-level diagnostics.
The global cooldown supersedes individual query cooldowns.
*/
function queryBackoffActive(
  portfolio,
  query
) {
  if (
    dexGlobalBackoffActive(
      portfolio
    )
  ) {
    return true;
  }

  const until =
    safeNumber(
      portfolio?.runtime
        ?.dex_query_backoff_untils
        ?.[query]
    );

  return until > Date.now();
}

function activeDexBackoffQueries(
  portfolio
) {
  const result = {};

  if (
    dexGlobalBackoffActive(
      portfolio
    )
  ) {
    result.global =
      safeNumber(
        portfolio.runtime
          .dex_backoff_until
      );
  }

  const map =
    portfolio?.runtime
      ?.dex_query_backoff_untils ||
    {};

  for (
    const [
      query,
      untilValue
    ] of Object.entries(map)
  ) {
    const until =
      safeNumber(
        untilValue
      );

    if (
      until > Date.now()
    ) {
      result[query] =
        until;
    }
  }

  return result;
}

function anyDexQueryBackoffActive(
  portfolio
) {
  return dexGlobalBackoffActive(
    portfolio
  );
}

/*
Legacy compatibility function.

The actual protection is now global.
*/
function syncLegacyBackoffFields(
  portfolio
) {
  clearExpiredDexBackoff(
    portfolio
  );

  if (
    dexGlobalBackoffActive(
      portfolio
    )
  ) {
    portfolio.runtime.dex_backoff_seconds =
      dexGlobalBackoffRemainingSeconds(
        portfolio
      );
  } else {
    portfolio.runtime.dex_backoff_until =
      0;

    portfolio.runtime.dex_backoff_seconds =
      0;
  }
}

/*
Legacy per-query registration retained so old runtime fields
remain understandable. It ALSO registers the global cooldown.
*/
function registerDexQueryRateLimit(
  portfolio,
  query
) {
  registerDexRateLimit(
    portfolio,
    `QUERY:${query}`
  );

  if (!portfolio.runtime.dex_query_backoff_untils) {
    portfolio.runtime.dex_query_backoff_untils =
      {};
  }

  if (!portfolio.runtime.dex_query_backoff_counts) {
    portfolio.runtime.dex_query_backoff_counts =
      {};
  }

  const key =
    String(query);

  const previous =
    safeNumber(
      portfolio.runtime
        .dex_query_backoff_counts
        ?.[key]
    );

  const count =
    Math.min(
      previous + 1,
      6
    );

  portfolio.runtime
    .dex_query_backoff_counts[key] =
    count;

  portfolio.runtime
    .dex_query_backoff_untils[key] =
    portfolio.runtime
      .dex_backoff_until;

  syncLegacyBackoffFields(
    portfolio
  );
}

function clearDexQueryRateLimit(
  portfolio,
  query
) {
  if (
    !portfolio.runtime
      .dex_query_backoff_untils
  ) {
    portfolio.runtime
      .dex_query_backoff_untils =
      {};
  }

  delete portfolio.runtime
    .dex_query_backoff_untils[
      query
    ];

  /*
  Do not clear the GLOBAL cooldown here.
  */
}

/* ============================================================
DEX DISCOVERY
============================================================ */

function extractDiscoveryMints(
  data,
  source
) {
  const list =
    Array.isArray(data)
      ? data
      : Array.isArray(data?.data)
        ? data.data
        : [];

  const results = [];

  for (
    const item of list
  ) {
    const chainId =
      String(
        item?.chainId ||
        item?.chain ||
        ""
      ).toLowerCase();

    if (
      chainId &&
      chainId !== "solana"
    ) {
      continue;
    }

    const mint =
      item?.tokenAddress ||
      item?.address ||
      item?.baseToken?.address ||
      null;

    if (!mint) {
      continue;
    }

    results.push({
      mint,
      source
    });
  }

  return results;
}

async function getDexDiscovery(
  portfolio
) {
  const diagnostics = [];
  const discoveries = [];

  let requestCount = 0;
  let rateLimitedCount = 0;

  /*
  CRITICAL:
  Do not make even the first discovery request while the
  global DexScreener cooldown is active.
  */
  if (
    dexGlobalBackoffActive(
      portfolio
    )
  ) {
    const remaining =
      dexGlobalBackoffRemainingSeconds(
        portfolio
      );

    for (
      const endpoint of
      DEX_DISCOVERY_ENDPOINTS
    ) {
      diagnostics.push({
        endpoint:
          endpoint.name,

        path:
          endpoint.path,

        ok:
          false,

        status:
          null,

        duration_ms:
          0,

        error:
          null,

        body_preview:
          null,

        rate_limited:
          false,

        discovered_count:
          0,

        skipped:
          true,

        skip_reason:
          "GLOBAL_DEX_BACKOFF_ACTIVE",

        backoff_remaining_seconds:
          remaining
      });
    }

    return {
      discoveries,
      diagnostics,
      requestCount: 0,
      rateLimitedCount: 0,
      skipped: true
    };
  }

  for (
    const endpoint of
    DEX_DISCOVERY_ENDPOINTS
  ) {
    /*
    A previous endpoint in THIS SAME scan may have triggered
    the global cooldown. Stop immediately.
    */
    if (
      dexGlobalBackoffActive(
        portfolio
      )
    ) {
      diagnostics.push({
        endpoint:
          endpoint.name,

        path:
          endpoint.path,

        ok:
          false,

        status:
          null,

        duration_ms:
          0,

        error:
          null,

        body_preview:
          null,

        rate_limited:
          false,

        discovered_count:
          0,

        skipped:
          true,

        skip_reason:
          "GLOBAL_DEX_BACKOFF_ACTIVATED_DURING_SCAN",

        backoff_remaining_seconds:
          dexGlobalBackoffRemainingSeconds(
            portfolio
          )
      });

      break;
    }

    const url =
      `${DEX_BASE}${endpoint.path}`;

    requestCount++;

    const response =
      await fetchJsonSafe(url);

    const items =
      extractDiscoveryMints(
        response.data,
        endpoint.name
      );

    const rateLimited =
      responseWasRateLimited(
        response
      );

    if (rateLimited) {
      rateLimitedCount++;

      /*
      Immediately activate the global cooldown.
      */
      registerDexRateLimit(
        portfolio,
        `DISCOVERY:${endpoint.name}`
      );
    }

    diagnostics.push({
      endpoint:
        endpoint.name,

      path:
        endpoint.path,

      ok:
        response.ok,

      status:
        response.status,

      duration_ms:
        response.duration_ms,

      error:
        response.error,

      body_preview:
        response.body_preview,

      rate_limited:
        rateLimited,

      discovered_count:
        items.length
    });

    /*
    Do not continue hammering the other discovery endpoints
    after a 429/1015.
    */
    if (rateLimited) {
      break;
    }

    discoveries.push(
      ...items
    );
  }

  return {
    discoveries,
    diagnostics,
    requestCount,
    rateLimitedCount,
    skipped: false
  };
}

/* ============================================================
DEXSCREENER SEARCH
============================================================ */

async function getDexSearch(
  portfolio
) {
  const pairMap =
    new Map();

  const diagnostics = [];

  let requestCount = 0;
  let rateLimitedCount = 0;

  /*
  Global cooldown means ZERO DexScreener search requests.
  */
  if (
    dexGlobalBackoffActive(
      portfolio
    )
  ) {
    const remaining =
      dexGlobalBackoffRemainingSeconds(
        portfolio
      );

    for (
      const query of
      DEX_SEARCH_QUERIES
    ) {
      diagnostics.push({
        query,

        skipped:
          true,

        skip_reason:
          "GLOBAL_DEX_BACKOFF_ACTIVE",

        backoff_until:
          safeNumber(
            portfolio.runtime
              .dex_backoff_until
          ),

        backoff_remaining_seconds:
          remaining
      });
    }

    return {
      pairMap,
      diagnostics,
      requestCount: 0,
      rateLimitedCount: 0,
      skipped: true
    };
  }

  for (
    const query of
    DEX_SEARCH_QUERIES
  ) {
    /*
    Stop immediately if discovery or an earlier search request
    activated the global cooldown.
    */
    if (
      dexGlobalBackoffActive(
        portfolio
      )
    ) {
      diagnostics.push({
        query,

        skipped:
          true,

        skip_reason:
          "GLOBAL_DEX_BACKOFF_ACTIVE",

        backoff_until:
          safeNumber(
            portfolio.runtime
              .dex_backoff_until
          ),

        backoff_remaining_seconds:
          dexGlobalBackoffRemainingSeconds(
            portfolio
          )
      });

      break;
    }

    const url =
      `${DEX_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`;

    requestCount++;

    const response =
      await fetchJsonSafe(url);

    const pairs =
      Array.isArray(
        response.data?.pairs
      )
        ? response.data.pairs
        : [];

    const rateLimited =
      responseWasRateLimited(
        response
      );

    if (rateLimited) {
      rateLimitedCount++;

      registerDexQueryRateLimit(
        portfolio,
        query
      );
    } else if (
      response.ok
    ) {
      clearDexQueryRateLimit(
        portfolio,
        query
      );
    }

    diagnostics.push({
      query,

      ok:
        response.ok,

      status:
        response.status,

      duration_ms:
        response.duration_ms,

      error:
        response.error,

      body_preview:
        response.body_preview,

      rate_limited:
        rateLimited,

      response_pair_count:
        pairs.length,

      solana_pair_count:
        pairs.filter(
          pair =>
            String(
              pair?.chainId || ""
            ).toLowerCase() ===
            "solana"
        ).length
    });

    if (rateLimited) {
      /*
      Do not process another DexScreener query.
      */
      break;
    }

    for (
      const pair of pairs
    ) {
      if (
        String(
          pair?.chainId || ""
        ).toLowerCase() !==
        "solana"
      ) {
        continue;
      }

      const mint =
        pair?.baseToken?.address;

      if (!mint) {
        continue;
      }

      const existing =
        pairMap.get(mint);

      if (!existing) {
        pairMap.set(
          mint,
          pair
        );
        continue;
      }

      const oldLiquidity =
        safeNumber(
          existing?.liquidity?.usd
        );

      const newLiquidity =
        safeNumber(
          pair?.liquidity?.usd
        );

      const oldVolume =
        safeNumber(
          existing?.volume?.h24
        );

      const newVolume =
        safeNumber(
          pair?.volume?.h24
        );

      if (
        newLiquidity >
          oldLiquidity ||
        (
          newLiquidity ===
            oldLiquidity &&
          newVolume >
            oldVolume
        )
      ) {
        pairMap.set(
          mint,
          pair
        );
      }
    }
  }

  syncLegacyBackoffFields(
    portfolio
  );

  return {
    pairMap,
    diagnostics,
    requestCount,
    rateLimitedCount,
    skipped: false
  };
}

/* ============================================================
DEX TOKEN HYDRATION
============================================================ */

async function hydrateDexTokens(
  mintMap,
  portfolio
) {
  const pairMap =
    new Map();

  const diagnostics = [];

  let requestCount = 0;
  let rateLimitedCount = 0;

  /*
  Never hydrate while the global DexScreener cooldown is active.
  */
  if (
    dexGlobalBackoffActive(
      portfolio
    )
  ) {
    return {
      pairMap,
      diagnostics: [
        {
          skipped:
            true,

          skip_reason:
            "GLOBAL_DEX_BACKOFF_ACTIVE",

          backoff_remaining_seconds:
            dexGlobalBackoffRemainingSeconds(
              portfolio
            )
        }
      ],

      requestCount: 0,
      rateLimitedCount: 0,
      skipped: true
    };
  }

  const mints =
    unique(
      [...mintMap.keys()]
    ).slice(
      0,
      MAX_DEX_HYDRATIONS
    );

  for (
    const mint of mints
  ) {
    /*
    Stop hydration immediately if any previous hydration
    request triggered the global cooldown.
    */
    if (
      dexGlobalBackoffActive(
        portfolio
      )
    ) {
      diagnostics.push({
        mint,

        skipped:
          true,

        skip_reason:
          "GLOBAL_DEX_BACKOFF_ACTIVATED_DURING_HYDRATION",

        backoff_remaining_seconds:
          dexGlobalBackoffRemainingSeconds(
            portfolio
          )
      });

      break;
    }

    const url =
      `${DEX_BASE}/latest/dex/tokens/${encodeURIComponent(
        mint
      )}`;

    requestCount++;

    const response =
      await fetchJsonSafe(url);

    const pairs =
      Array.isArray(
        response.data?.pairs
      )
        ? response.data.pairs
        : [];

    const rateLimited =
      responseWasRateLimited(
        response
      );

    if (rateLimited) {
      rateLimitedCount++;

      registerDexRateLimit(
        portfolio,
        `HYDRATION:${mint}`
      );
    }

    let bestPair = null;

    for (
      const pair of pairs
    ) {
      if (
        String(
          pair?.chainId || ""
        ).toLowerCase() !==
        "solana"
      ) {
        continue;
      }

      if (
        String(
          pair?.baseToken?.address ||
          ""
        ) !==
        mint
      ) {
        continue;
      }

      if (!bestPair) {
        bestPair = pair;
        continue;
      }

      const bestLiquidity =
        safeNumber(
          bestPair?.liquidity?.usd
        );

      const currentLiquidity =
        safeNumber(
          pair?.liquidity?.usd
        );

      const bestVolume =
        safeNumber(
          bestPair?.volume?.h24
        );

      const currentVolume =
        safeNumber(
          pair?.volume?.h24
        );

      if (
        currentLiquidity >
          bestLiquidity ||
        (
          currentLiquidity ===
            bestLiquidity &&
          currentVolume >
            bestVolume
        )
      ) {
        bestPair = pair;
      }
    }

    if (bestPair) {
      pairMap.set(
        mint,
        bestPair
      );
    }

    diagnostics.push({
      mint,

      ok:
        response.ok,

      status:
        response.status,

      duration_ms:
        response.duration_ms,

      error:
        response.error,

      body_preview:
        response.body_preview,

      rate_limited:
        rateLimited,

      pair_count:
        pairs.length,

      solana_pair_count:
        pairs.filter(
          pair =>
            String(
              pair?.chainId || ""
            ).toLowerCase() ===
            "solana"
        ).length,

      selected:
        !!bestPair
    });

    if (rateLimited) {
      /*
      One 429 is enough. Do not continue hydration.
      */
      break;
    }
  }

  return {
    pairMap,
    diagnostics,
    requestCount,
    rateLimitedCount,
    skipped: false
  };
}

/* ============================================================
JUPITER PRICES
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
    null;

  if (
    direct &&
    typeof direct === "object" &&
    !Array.isArray(direct)
  ) {
    for (
      const value of [
        direct.usdPrice,
        direct.usd_price,
        direct.price,
        direct.priceUsd,
        direct.price_usd
      ]
    ) {
      const price =
        Number(value);

      if (
        Number.isFinite(price) &&
        price > 0
      ) {
        return price;
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
        address !== mint
      ) {
        continue;
      }

      const price =
        Number(
          item?.usdPrice ??
          item?.usd_price ??
          item?.price ??
          item?.priceUsd
        );

      if (
        Number.isFinite(price) &&
        price > 0
      ) {
        return price;
      }
    }
  }

  return null;
}

async function getJupiterPrices(
  mints
) {
  const targets =
    unique(mints).slice(
      0,
      MAX_JUPITER_PRICE_CHECKS
    );

  if (!targets.length) {
    return {
      prices: {},
      diagnostics: {
        requested: 0,
        ok: false,
        status: null,
        error:
          "NO_MINTS_TO_CHECK",
        returned_count: 0
      }
    };
  }

  const url =
    `${JUPITER_PRICE_API}?ids=${encodeURIComponent(
      targets.join(",")
    )}`;

  const response =
    await fetchJsonSafe(url);

  const diagnostics = {
    requested:
      targets.length,

    ok:
      response.ok,

    status:
      response.status,

    duration_ms:
      response.duration_ms,

    error:
      response.error,

    body_preview:
      response.body_preview,

    returned_count: 0
  };

  if (!response.ok) {
    return {
      prices: {},
      diagnostics
    };
  }

  const prices = {};

  for (
    const mint of targets
  ) {
    const price =
      extractJupiterPrice(
        response.data,
        mint
      );

    if (
      Number.isFinite(price) &&
      price > 0
    ) {
      prices[mint] =
        price;
    }
  }

  diagnostics.returned_count =
    Object.keys(prices).length;

  return {
    prices,
    diagnostics
  };
}

/* ============================================================
CANDIDATE NORMALIZATION
============================================================ */

function normalizeCandidate(
  mint,
  pair,
  jupiterPrice,
  source
) {
  const liquidityAvailable =
    pair?.liquidity &&
    Object.prototype.hasOwnProperty.call(
      pair.liquidity,
      "usd"
    );

  const volume24Available =
    Number.isFinite(
      Number(
        pair?.volume?.h24
      )
    );

  const volume1Available =
    Number.isFinite(
      Number(
        pair?.volume?.h1
      )
    );

  const dexPrice =
    safeNumber(
      pair?.priceUsd
    );

  const jupPrice =
    safeNumber(
      jupiterPrice
    );

  const price =
    dexPrice ||
    jupPrice;

  const priceMismatch =
    dexPrice > 0 &&
    jupPrice > 0
      ? relativePriceDifference(
          dexPrice,
          jupPrice
        )
      : null;

  const changes =
    pair?.priceChange ||
    {};

  const change5m =
    Number.isFinite(
      Number(changes.m5)
    )
      ? Number(changes.m5) / 100
      : 0;

  const change1h =
    Number.isFinite(
      Number(changes.h1)
    )
      ? Number(changes.h1) / 100
      : 0;

  const change6h =
    Number.isFinite(
      Number(changes.h6)
    )
      ? Number(changes.h6) / 100
      : 0;

  const change24h =
    Number.isFinite(
      Number(changes.h24)
    )
      ? Number(changes.h24) / 100
      : 0;

  const pairCreatedAt =
    safeNumber(
      pair?.pairCreatedAt
    );

  const ageDays =
    pairCreatedAt > 0
      ? Math.max(
          0,
          (
            Date.now() -
            pairCreatedAt
          ) / 86400000
        )
      : null;

  return {
    mint,

    symbol:
      pair?.baseToken?.symbol ||
      null,

    name:
      pair?.baseToken?.name ||
      null,

    source,

    dex_id:
      pair?.dexId ||
      null,

    pair_address:
      pair?.pairAddress ||
      null,

    pair_url:
      pair?.url ||
      null,

    price_usd:
      price,

    liquidity_usd:
      liquidityAvailable
        ? safeNumber(
            pair.liquidity.usd
          )
        : 0,

    liquidity_data_available:
      !!liquidityAvailable,

    volume_24h_usd:
      volume24Available
        ? safeNumber(
            pair.volume.h24
          )
        : 0,

    volume_24h_data_available:
      !!volume24Available,

    volume_1h_usd:
      volume1Available
        ? safeNumber(
            pair.volume.h1
          )
        : 0,

    volume_1h_data_available:
      !!volume1Available,

    change_5m:
      change5m,

    change_1h:
      change1h,

    change_6h:
      change6h,

    change_24h:
      change24h,

    pair_created_at:
      pairCreatedAt ||
      null,

    age_days:
      ageDays,

    quote_symbol:
      pair?.quoteToken?.symbol ||
      null,

    jupiter_price_usd:
      jupPrice ||
      null,

    price_mismatch_ratio:
      priceMismatch,

    price_source:
      dexPrice > 0
        ? "DEXSCREENER"
        : jupPrice > 0
          ? "JUPITER"
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
        ? entry.observations.slice(
            -MAX_MEMORY_OBSERVATIONS
          )
        : [];
  }

  portfolio.market_memory =
    Object.fromEntries(
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
        )
    );
}

function recordMarketObservation(
  portfolio,
  candidate
) {
  if (!candidate?.mint) {
    return;
  }

  const existing =
    portfolio.market_memory[
      candidate.mint
    ] ||
    {
      mint:
        candidate.mint,
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

  existing.observations =
    existing.observations.slice(
      -MAX_MEMORY_OBSERVATIONS
    );

  portfolio.market_memory[
    candidate.mint
  ] = existing;

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

  const observations =
    Array.isArray(
      memory?.observations
    )
      ? memory.observations
      : [];

  if (
    observations.length <
    MIN_HISTORY_OBSERVATIONS
  ) {
    return 0;
  }

  const previous =
    observations[
      observations.length - 1
    ];

  let bonus = 0;

  const oldPrice =
    safeNumber(
      previous.price_usd
    );

  const currentPrice =
    safeNumber(
      candidate.price_usd
    );

  if (
    oldPrice > 0 &&
    currentPrice > 0
  ) {
    const delta =
      (
        currentPrice -
        oldPrice
      ) / oldPrice;

    if (delta > 0) {
      bonus += 5;
    }

    if (delta >= 0.01) {
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

  let momentum = 0;
  let setup = 0;
  let risk = 0;

  if (change5m > 0) {
    momentum += 4;
  }

  if (change5m >= 0.02) {
    momentum += 3;
  }

  if (change1h > 0) {
    momentum += 3;
  }

  if (change1h >= 0.05) {
    momentum += 3;
  }

  if (change6h > 0) {
    momentum += 2;
  }

  if (
    volume1h >=
    MIN_VOLUME_1H_USD
  ) {
    setup += 5;
  }

  if (
    volume24h >=
    MIN_VOLUME_24H_USD
  ) {
    setup += 5;
  }

  if (
    liquidity >=
    MIN_LIQUIDITY_USD
  ) {
    setup += 8;
  }

  if (
    liquidity >=
    2 * MIN_LIQUIDITY_USD
  ) {
    setup += 3;
  }

  if (
    change6h <=
      STRONG_NEGATIVE_6H &&
    change5m >=
      BOUNCE_5M
  ) {
    setup += 6;
  }

  if (
    change5m <=
    STRONG_NEGATIVE_5M
  ) {
    risk += 8;
  }

  if (
    change1h >=
    EXTREME_1H_MOVE
  ) {
    risk += 10;
  }

  if (
    change5m >
    MAX_5M_GAIN
  ) {
    risk += 10;
  }

  if (
    change1h >
    MAX_1H_GAIN
  ) {
    risk += 10;
  }

  if (
    change6h >
    MAX_6H_GAIN
  ) {
    risk += 8;
  }

  if (
    safeNumber(
      candidate.change_24h
    ) >
    MAX_24H_GAIN
  ) {
    risk += 8;
  }

  if (
    safeNumber(
      candidate.price_mismatch_ratio
    ) >
    MAX_PRICE_MISMATCH_RATIO
  ) {
    risk += 50;
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
      setup += 5;
    }
  }

  const historical =
    getHistoricalSetupBonus(
      portfolio,
      candidate
    );

  return {
    score:
      round(
        momentum +
        setup +
        historical -
        risk -
        newTokenPenalty,
        2
      ),

    momentum_score:
      round(momentum, 2),

    setup_score:
      round(setup, 2),

    historical_bonus:
      round(historical, 2),

    risk_penalty:
      round(risk, 2),

    new_token_penalty:
      round(newTokenPenalty, 2)
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

  if (!candidate?.mint) {
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
    !candidate.liquidity_data_available
  ) {
    reasons.push(
      "LIQUIDITY_DATA_UNAVAILABLE"
    );
  } else if (
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
    !candidate.volume_24h_data_available
  ) {
    reasons.push(
      "VOLUME_24H_DATA_UNAVAILABLE"
    );
  } else if (
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
    !candidate.volume_1h_data_available
  ) {
    reasons.push(
      "VOLUME_1H_DATA_UNAVAILABLE"
    );
  } else if (
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

  if (
    safeNumber(
      candidate.price_mismatch_ratio
    ) >
    MAX_PRICE_MISMATCH_RATIO
  ) {
    reasons.push(
      "PRICE_SOURCE_MISMATCH"
    );
  }

  if (
    safeNumber(
      portfolio.cooldowns?.[
        candidate.mint
      ]
    ) >
    Date.now()
  ) {
    reasons.push(
      "COOLDOWN"
    );
  }

  if (
    portfolio.positions.some(
      position =>
        position.mint ===
        candidate.mint
    )
  ) {
    reasons.push(
      "ALREADY_HELD"
    );
  }

  return reasons;
}

function getEligibleCandidates(
  portfolio,
  candidates
) {
  return candidates.filter(
    candidate =>
      safeNumber(
        candidate.score
      ) >= MIN_ENTRY_SCORE &&
      safeNumber(
        candidate.momentum_score
      ) >= MIN_MOMENTUM_SCORE &&
      safeNumber(
        candidate.setup_score
      ) >= MIN_SETUP_SCORE &&
      evaluateCandidate(
        portfolio,
        candidate
      ).length === 0
  );
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
    const [
      mint,
      until
    ] of Object.entries(
      portfolio.cooldowns ||
        {}
    )
  ) {
    if (
      safeNumber(until) <=
      now
    ) {
      delete portfolio.cooldowns[
        mint
      ];
    }
  }
}

/* ============================================================
EXIT LOGIC
============================================================ */

function getSellReason(
  position,
  candidate
) {
  const entry =
    safeNumber(
      position.entry_price_usd
    );

  const current =
    safeNumber(
      candidate.price_usd
    );

  if (
    entry <= 0 ||
    current <= 0
  ) {
    return null;
  }

  const pnlRatio =
    (current - entry) /
    entry;

  if (
    pnlRatio <=
    STOP_LOSS
  ) {
    return "STOP_LOSS";
  }

  if (
    current >
    safeNumber(
      position.peak_price_usd,
      entry
    )
  ) {
    position.peak_price_usd =
      current;
  }

  if (
    !position.trailing_active &&
    current >=
      entry *
        (1 +
          TRAILING_ACTIVATION)
  ) {
    position.trailing_active =
      true;
  }

  if (
    position.trailing_active &&
    current <=
      safeNumber(
        position.peak_price_usd,
        current
      ) *
        (1 -
          TRAILING_STOP)
  ) {
    return "TRAILING_STOP";
  }

  const shortTerm =
    safeNumber(
      candidate.change_5m
    );

  const hourly =
    safeNumber(
      candidate.change_1h
    );

  if (
    pnlRatio > 0 &&
    shortTerm <=
      -(
        1 -
        1 /
          SHORT_TERM_SELL_RATIO
      )
  ) {
    position.reversal_confirmations =
      safeNumber(
        position.reversal_confirmations
      ) + 1;
  } else if (
    pnlRatio > 0 &&
    hourly <=
      -(
        1 -
        1 /
          HOURLY_SELL_RATIO
      )
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
    pnlRatio > 0 &&
    position.reversal_confirmations >=
      REVERSAL_CONFIRMATIONS_REQUIRED
  ) {
    return "REVERSAL";
  }

  if (
    pnlRatio >= 0.025
  ) {
    return "PROFIT_TARGET";
  }

  if (
    pnlRatio >= 0.01 &&
    hourly <= -0.10
  ) {
    return "PROFIT_REVERSAL";
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
    String(value || "").trim();

  if (!input) {
    throw new Error(
      "EMPTY_BASE58_VALUE"
    );
  }

  const digits =
    new Uint8Array(
      input.length
    );

  let digitLength = 1;

  for (
    const char of input
  ) {
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
      i < digitLength;
      i++
    ) {
      const value =
        digits[i] * 58 +
        carry;

      digits[i] =
        value & 0xff;

      carry =
        value >> 8;
    }

    while (
      carry > 0
    ) {
      digits[digitLength++] =
        carry & 0xff;

      carry >>= 8;
    }
  }

  let leadingZeros = 0;

  while (
    leadingZeros <
      input.length &&
    input[leadingZeros] ===
      "1"
  ) {
    leadingZeros++;
  }

  const result =
    new Uint8Array(
      leadingZeros +
        digitLength
    );

  for (
    let i = 0;
    i < digitLength;
    i++
  ) {
    result[
      result.length -
        1 -
        i
    ] = digits[i];
  }

  return result;
}

function base58Encode(bytes) {
  if (!bytes?.length) {
    return "";
  }

  const digits =
    new Uint8Array(
      bytes.length * 2
    );

  let digitLength = 1;

  for (
    const byte of bytes
  ) {
    let carry = byte;

    for (
      let i = 0;
      i < digitLength;
      i++
    ) {
      const value =
        digits[i] * 256 +
        carry;

      digits[i] =
        value % 58;

      carry =
        Math.floor(
          value / 58
        );
    }

    while (
      carry > 0
    ) {
      digits[digitLength++] =
        carry % 58;

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
      digitLength - 1;
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

  for (
    let i = 0;
    i < bytes.length;
    i += 0x8000
  ) {
    binary +=
      String.fromCharCode(
        ...bytes.subarray(
          i,
          Math.min(
            i + 0x8000,
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
WALLET
============================================================ */

function requireLiveConfig(env) {
  if (!TRANSACTION_EXECUTION) {
    throw new Error(
      "LIVE_TRANSACTION_EXECUTION_DISABLED"
    );
  }

  if (!env.SOLANA_RPC_URL) {
    throw new Error(
      "MISSING_SOLANA_RPC_URL"
    );
  }

  if (!env.WALLET_PRIVATE_KEY) {
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

  let bytes;

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
      !Array.isArray(parsed) ||
      parsed.length !== 64
    ) {
      throw new Error(
        "WALLET_JSON_MUST_HAVE_64_BYTES"
      );
    }

    const normalized =
      parsed.map(Number);

    if (
      normalized.some(
        value =>
          !Number.isInteger(
            value
          ) ||
          value < 0 ||
          value > 255
      )
    ) {
      throw new Error(
        "WALLET_JSON_CONTAINS_INVALID_BYTE"
      );
    }

    bytes =
      new Uint8Array(
        normalized
      );
  } else if (
    /^[0-9a-fA-F]+$/.test(
      raw
    ) &&
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

  if (bytes.length !== 64) {
    throw new Error(
      `WALLET_SECRET_MUST_BE_64_BYTES_GOT_${bytes.length}`
    );
  }

  return bytes;
}

/* ============================================================
SOLANA TRANSACTION SIGNING
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
      index >=
      bytes.length
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

  const signatureHeader =
    readCompactU16(
      transaction,
      0
    );

  if (
    signatureHeader.value !==
    1
  ) {
    throw new Error(
      `EXPECTED_ONE_REQUIRED_SIGNER_GOT_${signatureHeader.value}`
    );
  }

  const signaturesStart =
    signatureHeader.nextOffset;

  const messageStart =
    signaturesStart + 64;

  if (
    messageStart >=
    transaction.length
  ) {
    throw new Error(
      "SOLANA_MESSAGE_OFFSET_OUT_OF_RANGE"
    );
  }

  const message =
    transaction.slice(
      messageStart
    );

  const versioned =
    (message[0] & 0x80) !==
    0;

  if (
    versioned &&
    (message[0] & 0x7f) !== 0
  ) {
    throw new Error(
      "UNSUPPORTED_SOLANA_TRANSACTION_VERSION"
    );
  }

  const headerOffset =
    versioned ? 1 : 0;

  const accountCountOffset =
    versioned ? 4 : 3;

  if (
    message[
      headerOffset
    ] !== 1
  ) {
    throw new Error(
      "EXPECTED_ONE_MESSAGE_SIGNER"
    );
  }

  const accountCount =
    readCompactU16(
      message,
      accountCountOffset
    );

  if (
    accountCount.value < 1
  ) {
    throw new Error(
      "NO_SOLANA_ACCOUNT_KEYS"
    );
  }

  const accountStart =
    accountCount.nextOffset;

  if (
    accountStart +
      accountCount.value * 32 >
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
    base58Encode(feePayer) !==
    base58Encode(walletPublicKey)
  ) {
    throw new Error(
      "TRANSACTION_FEE_PAYER_DOES_NOT_MATCH_CONFIGURED_WALLET"
    );
  }

  const seed =
    walletSecret.slice(
      0,
      32
    );

  const pkcs8Prefix =
    new Uint8Array([
      0x30, 0x2e,
      0x02, 0x01, 0x00,
      0x30, 0x05,
      0x06, 0x03,
      0x2b, 0x65, 0x70,
      0x04, 0x22,
      0x04, 0x20
    ]);

  const pkcs8 =
    new Uint8Array(
      pkcs8Prefix.length +
        seed.length
    );

  pkcs8.set(
    pkcs8Prefix
  );

  pkcs8.set(
    seed,
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
      transaction
    );

  signed.set(
    signature,
    signaturesStart
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
      `SOLANA_RPC_${method}:${JSON.stringify(
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
    secret.slice(32, 64)
  );
}

/* ============================================================
SOL PRICE
============================================================ */

async function getSolUsdPrice() {
  const response =
    await fetchJsonSafe(
      `${JUPITER_PRICE_API}?ids=${SOL_MINT}`
    );

  if (!response.ok) {
    throw new Error(
      "SOL_PRICE_LOOKUP_FAILED"
    );
  }

  const price =
    extractJupiterPrice(
      response.data,
      SOL_MINT
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
JUPITER
============================================================ */

function jupiterHeaders(
  env,
  json = false
) {
  const headers = {
    accept:
      "application/json"
  };

  if (json) {
    headers[
      "content-type"
    ] =
      "application/json";
  }

  if (env.JUPITER_API_KEY) {
    headers[
      "x-api-key"
    ] =
      env.JUPITER_API_KEY;
  }

  return headers;
}

async function jupiterQuote(
  env,
  inputMint,
  outputMint,
  amount
) {
  const url =
    new URL(
      JUPITER_QUOTE_API
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

  const quote =
    await fetchJson(
      url.toString(),
      {
        headers:
          jupiterHeaders(
            env
          )
      }
    );

  if (
    !quote?.outAmount
  ) {
    throw new Error(
      "JUPITER_QUOTE_MISSING_OUT_AMOUNT"
    );
  }

  return quote;
}

async function jupiterSwapTransaction(
  env,
  quoteResponse,
  userPublicKey
) {
  const response =
    await fetch(
      JUPITER_SWAP_API,
      {
        method: "POST",
        headers:
          jupiterHeaders(
            env,
            true
          ),
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
    } catch {}

    throw new Error(
      `JUPITER_SWAP_HTTP_${response.status}` +
        (
          body
            ? `:${body.slice(
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

async function broadcastAndConfirm(
  env,
  serializedTransaction
) {
  const walletSecret =
    parseWalletSecret(env);

  const signed =
    await signSolanaTransaction(
      serializedTransaction,
      walletSecret
    );

  logEvent(
    "TRANSACTION_SIGNED"
  );

  const signature =
    await solanaRpc(
      env,
      "sendTransaction",
      [
        signed,
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

  if (!signature) {
    throw new Error(
      "SOLANA_RPC_DID_NOT_RETURN_SIGNATURE"
    );
  }

  logEvent(
    "TRANSACTION_BROADCAST",
    { signature }
  );

  for (
    let poll = 1;
    poll <=
    MAX_CONFIRMATION_POLLS;
    poll++
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

    const status =
      result?.value?.[0] ||
      null;

    logEvent(
      "TRANSACTION_STATUS",
      {
        signature,
        poll,
        confirmation_status:
          status?.confirmationStatus ||
          null,
        has_error:
          !!status?.err
      }
    );

    if (status?.err) {
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

    if (
      poll <
      MAX_CONFIRMATION_POLLS
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            CONFIRMATION_POLL_INTERVAL_MS
          )
      );
    }
  }

  throw new Error(
    `LIVE_TRANSACTION_CONFIRMATION_TIMEOUT:${signature}`
  );
}

async function executeLiveSwap(
  env,
  inputMint,
  outputMint,
  amount,
  walletPublicKey
) {
  requireLiveConfig(env);

  if (
    !amount ||
    String(amount) === "0"
  ) {
    throw new Error(
      "INVALID_LIVE_SWAP_AMOUNT"
    );
  }

  const quote =
    await jupiterQuote(
      env,
      inputMint,
      outputMint,
      amount
    );

  const swap =
    await jupiterSwapTransaction(
      env,
      quote,
      walletPublicKey
    );

  const confirmation =
    await broadcastAndConfirm(
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
  candidate
) {
  requireLiveConfig(env);

  const reasons =
    evaluateCandidate(
      portfolio,
      candidate
    );

  if (reasons.length) {
    throw new Error(
      `LIVE_BUY_CANDIDATE_REJECTED:${reasons.join(
        ","
      )}`
    );
  }

  const amountUsd =
    MAX_LIVE_TRADE_USD;

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

  if (
    portfolio.cash_usd -
      amountUsd <
    MIN_CASH_RESERVE_USD
  ) {
    throw new Error(
      "MINIMUM_CASH_RESERVE_REQUIRED"
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
      MIN_SOL_RESERVE *
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
      SOL_MINT,
      candidate.mint,
      lamports,
      walletPublicKey
    );

  const quantityRaw =
    String(
      result.quote.outAmount
    );

  const price =
    safeNumber(
      candidate.price_usd
    );

  if (price <= 0) {
    throw new Error(
      "INVALID_CANDIDATE_PRICE"
    );
  }

  const quantity =
    amountUsd / price;

  portfolio.cash_usd =
    clamp(
      portfolio.cash_usd -
        amountUsd,
      0,
      MAX_LIVE_BANKROLL_USD
    );

  portfolio.positions.push({
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

    quantity_raw:
      quantityRaw,

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
      null,

    transaction_signature:
      result.signature,

    input_lamports:
      lamports
  });

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
        price,
      quantity,
      quantity_raw:
        quantityRaw,
      transaction_signature:
        result.signature,
      score:
        candidate.score
    }
  );

  portfolio.runtime.last_trade_signature =
    result.signature;

  portfolio.runtime.last_trade_type =
    "BUY";

  setCooldown(
    portfolio,
    candidate.mint
  );

  logEvent(
    "LIVE_BUY_CONFIRMED",
    {
      mint:
        candidate.mint,
      signature:
        result.signature,
      amount_usd:
        amountUsd
    }
  );

  return true;
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

  const accounts =
    await solanaRpc(
      env,
      "getTokenAccountsByOwner",
      [
        walletPublicKey,
        {
          mint:
            candidate.mint
        },
        {
          encoding:
            "jsonParsed",
          commitment:
            "confirmed"
        }
      ]
    );

  let onChainRaw = 0n;

  for (
    const account of
    accounts?.value || []
  ) {
    const amount =
      account?.account
        ?.data
        ?.parsed
        ?.info
        ?.tokenAmount
        ?.amount;

    if (
      amount !== undefined
    ) {
      onChainRaw +=
        BigInt(
          String(amount)
        );
    }
  }

  if (
    onChainRaw <= 0n
  ) {
    throw new Error(
      "LIVE_TOKEN_BALANCE_NOT_FOUND"
    );
  }

  let requestedRaw;

  try {
    requestedRaw =
      BigInt(quantityRaw);
  } catch {
    throw new Error(
      "INVALID_STORED_TOKEN_AMOUNT"
    );
  }

  const sellRaw =
    requestedRaw <=
    onChainRaw
      ? requestedRaw
      : onChainRaw;

  if (
    sellRaw <= 0n
  ) {
    throw new Error(
      "LIVE_SELL_AMOUNT_TOO_SMALL"
    );
  }

  const result =
    await executeLiveSwap(
      env,
      candidate.mint,
      SOL_MINT,
      sellRaw.toString(),
      walletPublicKey
    );

  const solOutLamports =
    safeNumber(
      result.quote.outAmount
    );

  if (
    solOutLamports <= 0
  ) {
    throw new Error(
      "LIVE_SELL_RETURNED_ZERO_SOL"
    );
  }

  const solPrice =
    await getSolUsdPrice();

  const proceeds =
    (
      solOutLamports /
      1_000_000_000
    ) *
    solPrice;

  const soldFraction =
    requestedRaw > 0n
      ? Number(sellRaw) /
        Number(requestedRaw)
      : 1;

  const adjustedCost =
    safeNumber(
      position.cost_usd
    ) *
    clamp(
      soldFraction,
      0,
      1
    );

  const pnl =
    proceeds -
    adjustedCost;

  portfolio.cash_usd =
    clamp(
      portfolio.cash_usd +
        proceeds,
      0,
      MAX_LIVE_BANKROLL_USD
    );

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
      sold_raw_amount:
        sellRaw.toString(),
      transaction_signature:
        result.signature,
      reason
    }
  );

  portfolio.runtime.last_trade_signature =
    result.signature;

  portfolio.runtime.last_trade_type =
    "SELL";

  setCooldown(
    portfolio,
    position.mint
  );

  logEvent(
    "LIVE_SELL_CONFIRMED",
    {
      mint:
        position.mint,
      signature:
        result.signature,
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

  return true;
}

/* ============================================================
JUPITER-ONLY POSITION / MEMORY REFRESH
============================================================ */

async function buildBackoffCandidates(
  env,
  portfolio
) {
  const heldMints =
    portfolio.positions.map(
      position =>
        position.mint
    );

  const memoryMints =
    Object.keys(
      portfolio.market_memory ||
        {}
    );

  const targets =
    unique([
      ...heldMints,
      ...memoryMints
    ]).slice(
      0,
      MAX_JUPITER_PRICE_CHECKS
    );

  if (!targets.length) {
    return {
      candidates: [],
      jupiter: {
        requested: 0,
        returned_count: 0
      }
    };
  }

  const jupiter =
    await getJupiterPrices(
      targets
    );

  const candidates = [];

  for (
    const mint of targets
  ) {
    const price =
      safeNumber(
        jupiter.prices[mint]
      );

    if (price <= 0) {
      continue;
    }

    const position =
      portfolio.positions.find(
        item =>
          item.mint === mint
      );

    const memory =
      portfolio.market_memory?.[
        mint
      ];

    const observations =
      Array.isArray(
        memory?.observations
      )
        ? memory.observations
        : [];

    const last =
      observations[
        observations.length - 1
      ] || null;

    const candidate = {
      mint,

      symbol:
        position?.symbol ||
        memory?.symbol ||
        null,

      name:
        position?.name ||
        memory?.name ||
        null,

      source:
        "JUPITER_POSITION_REFRESH",

      price_usd:
        price,

      liquidity_usd:
        safeNumber(
          last?.liquidity_usd
        ),

      liquidity_data_available:
        false,

      volume_24h_usd:
        safeNumber(
          last?.volume_24h_usd
        ),

      volume_24h_data_available:
        false,

      volume_1h_usd:
        safeNumber(
          last?.volume_1h_usd
        ),

      volume_1h_data_available:
        false,

      change_5m:
        safeNumber(
          last?.change_5m
        ),

      change_1h:
        safeNumber(
          last?.change_1h
        ),

      change_6h:
        safeNumber(
          last?.change_6h
        ),

      change_24h:
        safeNumber(
          last?.change_24h
        ),

      pair_created_at:
        null,

      age_days:
        null,

      quote_symbol:
        "USD",

      jupiter_price_usd:
        price,

      price_mismatch_ratio:
        null,

      price_source:
        "JUPITER"
    };

    Object.assign(
      candidate,
      scoreCandidate(
        portfolio,
        candidate
      )
    );

    candidate.filter_reasons =
      evaluateCandidate(
        portfolio,
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
    candidates,
    jupiter:
      jupiter.diagnostics
  };
}

/* ============================================================
SCAN
============================================================ */

async function runScan(
  env,
  existingPortfolio = null
) {
  const started =
    Date.now();

  const portfolio =
    existingPortfolio ||
    await loadPortfolio(env);

  clearExpiredDexBackoff(
    portfolio
  );

  /*
  ============================================================
  GLOBAL DEX BACKOFF PATH
  ============================================================

  If DexScreener is cooling down, do NOT call:
  - token profiles
  - latest boosts
  - top boosts
  - search
  - hydration

  Instead, use Jupiter to refresh known positions and
  market-memory tokens.

  This prevents every one-minute cron invocation from
  repeating the same DexScreener 429/1015 cycle.
  */
  if (
    dexGlobalBackoffActive(
      portfolio
    )
  ) {
    const remaining =
      dexGlobalBackoffRemainingSeconds(
        portfolio
      );

    const fallback =
      await buildBackoffCandidates(
        env,
        portfolio
      );

    const diagnostics = {
      duration_ms:
        Date.now() -
        started,

      dexscreener_backoff_active:
        true,

      dexscreener_backoff_remaining_seconds:
        remaining,

      dexscreener_discovery_requests:
        0,

      dexscreener_search_requests:
        0,

      dexscreener_hydration_requests:
        0,

      dexscreener_requests:
        0,

      dexscreener_rate_limited:
        0,

      dexscreener_search_rate_limited:
        0,

      dexscreener_global_backoff:
        true,

      dexscreener_skip_reason:
        "GLOBAL_DEX_BACKOFF_ACTIVE",

      candidate_count:
        fallback.candidates.length,

      eligible_candidate_count:
        getEligibleCandidates(
          portfolio,
          fallback.candidates
        ).length,

      jupiter_prices_requested:
        fallback.jupiter?.requested ||
        0,

      jupiter_prices:
        fallback.jupiter?.returned_count ||
        0,

      estimated_external_requests:
        fallback.jupiter
          ? 1
          : 0,

      configured_request_budget:
        MAX_EXTERNAL_REQUEST_BUDGET,

      target_cloudflare_free_limit:
        50,

      rate_limited:
        true,

      rate_limit_reason:
        "DEXSCREENER_GLOBAL_BACKOFF_ACTIVE",

      endpoint_diagnostics: {
        dexscreener_discovery: [
          {
            skipped:
              true,
            skip_reason:
              "GLOBAL_DEX_BACKOFF_ACTIVE",
            backoff_remaining_seconds:
              remaining
          }
        ],

        dexscreener_search: [
          {
            skipped:
              true,
            skip_reason:
              "GLOBAL_DEX_BACKOFF_ACTIVE",
            backoff_remaining_seconds:
              remaining
          }
        ],

        dexscreener_hydration: [
          {
            skipped:
              true,
            skip_reason:
              "GLOBAL_DEX_BACKOFF_ACTIVE",
            backoff_remaining_seconds:
              remaining
          }
        ],

        jupiter_prices:
          fallback.jupiter
      }
    };

    logEvent(
      "SCAN_DEX_BACKOFF",
      {
        remaining_seconds:
          remaining,

        jupiter_candidates:
          fallback.candidates.length
      }
    );

    return {
      candidates:
        fallback.candidates,

      diagnostics,

      portfolio
    };
  }

  /*
  ============================================================
  NORMAL DEX SCAN
  ============================================================
  */

  const discovery =
    await getDexDiscovery(
      portfolio
    );

  /*
  If discovery hit a 429, getDexDiscovery has already
  activated the global cooldown. Do NOT call search.
  */
  const dex =
    dexGlobalBackoffActive(
      portfolio
    )
      ? {
          pairMap:
            new Map(),
          diagnostics: [
            {
              skipped:
                true,
              skip_reason:
                "GLOBAL_DEX_BACKOFF_ACTIVE_AFTER_DISCOVERY"
            }
          ],
          requestCount: 0,
          rateLimitedCount: 0,
          skipped: true
        }
      : await getDexSearch(
          portfolio
        );

  /*
  If search hit a 429, getDexSearch has activated the global
  cooldown. Do NOT call hydration.
  */
  const discoveredMints =
    unique(
      discovery.discoveries.map(
        item =>
          item.mint
      )
    );

  const candidateMintSet =
    unique([
      ...dex.pairMap.keys(),
      ...discoveredMints
    ]);

  const hydrationTargets =
    candidateMintSet
      .filter(
        mint =>
          !dex.pairMap.has(mint)
      )
      .slice(
        0,
        MAX_DEX_HYDRATIONS
      );

  const hydrationSeed =
    new Map();

  for (
    const mint of
    hydrationTargets
  ) {
    hydrationSeed.set(
      mint,
      true
    );
  }

  const hydration =
    !dexGlobalBackoffActive(
      portfolio
    ) && hydrationSeed.size
      ? await hydrateDexTokens(
          hydrationSeed,
          portfolio
        )
      : {
          pairMap:
            new Map(),
          diagnostics:
            dexGlobalBackoffActive(
              portfolio
            )
              ? [
                  {
                    skipped:
                      true,
                    skip_reason:
                      "GLOBAL_DEX_BACKOFF_ACTIVE_BEFORE_HYDRATION",
                    backoff_remaining_seconds:
                      dexGlobalBackoffRemainingSeconds(
                        portfolio
                      )
                  }
                ]
              : [],
          requestCount: 0,
          rateLimitedCount: 0,
          skipped:
            dexGlobalBackoffActive(
              portfolio
            )
        };

  /*
  Search data wins for a mint when available.
  Hydration supplies discovery-only mints.
  */
  for (
    const [
      mint,
      pair
    ] of hydration.pairMap
  ) {
    if (
      !dex.pairMap.has(mint)
    ) {
      dex.pairMap.set(
        mint,
        pair
      );
    }
  }

  const mints =
    [...dex.pairMap.keys()]
      .slice(
        0,
        MAX_CANDIDATES
      );

  /*
  If a rate limit occurred and no usable DEX pairs remain,
  use Jupiter-only refresh.
  */
  if (
    mints.length === 0 &&
    (
      discovery.rateLimitedCount > 0 ||
      dex.rateLimitedCount > 0 ||
      hydration.rateLimitedCount > 0 ||
      dexGlobalBackoffActive(
        portfolio
      )
    )
  ) {
    const fallback =
      await buildBackoffCandidates(
        env,
        portfolio
      );

    const totalDexRequests =
      discovery.requestCount +
      dex.requestCount +
      hydration.requestCount;

    const totalDexRateLimits =
      discovery.rateLimitedCount +
      dex.rateLimitedCount +
      hydration.rateLimitedCount;

    const diagnostics = {
      duration_ms:
        Date.now() -
        started,

      dexscreener_backoff_active:
        dexGlobalBackoffActive(
          portfolio
        ),

      dexscreener_backoff_remaining_seconds:
        dexGlobalBackoffRemainingSeconds(
          portfolio
        ),

      dexscreener_discovery_requests:
        discovery.requestCount,

      dexscreener_search_requests:
        dex.requestCount,

      dexscreener_hydration_requests:
        hydration.requestCount,

      dexscreener_requests:
        totalDexRequests,

      dexscreener_rate_limited:
        totalDexRateLimits,

      dexscreener_search_rate_limited:
        dex.rateLimitedCount,

      dexscreener_global_backoff:
        dexGlobalBackoffActive(
          portfolio
        ),

      candidate_count:
        fallback.candidates.length,

      eligible_candidate_count:
        getEligibleCandidates(
          portfolio,
          fallback.candidates
        ).length,

      jupiter_prices_requested:
        fallback.jupiter?.requested ||
        0,

      jupiter_prices:
        fallback.jupiter?.returned_count ||
        0,

      estimated_external_requests:
        totalDexRequests +
        (
          fallback.jupiter
            ? 1
            : 0
        ),

      configured_request_budget:
        MAX_EXTERNAL_REQUEST_BUDGET,

      target_cloudflare_free_limit:
        50,

      rate_limited:
        totalDexRateLimits > 0 ||
        dexGlobalBackoffActive(
          portfolio
        ),

      rate_limit_reason:
        totalDexRateLimits > 0
          ? "DEXSCREENER_RATE_LIMITED"
          : dexGlobalBackoffActive(
              portfolio
            )
            ? "DEXSCREENER_GLOBAL_BACKOFF_ACTIVE"
            : null,

      endpoint_diagnostics: {
        dexscreener_discovery:
          discovery.diagnostics,

        dexscreener_search:
          dex.diagnostics,

        dexscreener_hydration:
          hydration.diagnostics,

        jupiter_prices:
          fallback.jupiter
      }
    };

    return {
      candidates:
        fallback.candidates,

      diagnostics,

      portfolio
    };
  }

  /*
  If DexScreener happened to hit a 429 but some pairs were
  already collected, continue with those already-received
  pairs. No additional Dex requests will occur.
  */
  const jupiter =
    await getJupiterPrices(
      mints
    );

  const candidates = [];

  for (
    const mint of mints
  ) {
    const pair =
      dex.pairMap.get(
        mint
      );

    const source =
      discoveredMints.includes(mint) &&
      !dex.diagnostics.some(
        diagnostic =>
          diagnostic.solana_pair_count >
          0
      )
        ? "DEXSCREENER_DISCOVERY"
        : dex.pairMap.has(mint)
          ? "DEXSCREENER"
          : "DEXSCREENER_SEARCH";

    const candidate =
      normalizeCandidate(
        mint,
        pair,
        jupiter.prices[mint],
        source
      );

    Object.assign(
      candidate,
      scoreCandidate(
        portfolio,
        candidate
      )
    );

    candidate.filter_reasons =
      evaluateCandidate(
        portfolio,
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

  const finalCandidates =
    candidates.slice(
      0,
      MAX_CANDIDATES
    );

  const eligible =
    getEligibleCandidates(
      portfolio,
      finalCandidates
    );

  const top =
    finalCandidates[0] ||
    null;

  const totalDexRequests =
    discovery.requestCount +
    dex.requestCount +
    hydration.requestCount;

  const totalDexRateLimits =
    discovery.rateLimitedCount +
    dex.rateLimitedCount +
    hydration.rateLimitedCount;

  const diagnostics = {
    duration_ms:
      Date.now() -
      started,

    dexscreener_backoff_active:
      dexGlobalBackoffActive(
        portfolio
      ),

    dexscreener_backoff_remaining_seconds:
      dexGlobalBackoffRemainingSeconds(
        portfolio
      ),

    dexscreener_discovery_requests:
      discovery.requestCount,

    dexscreener_search_requests:
      dex.requestCount,

    dexscreener_hydration_requests:
      hydration.requestCount,

    dexscreener_requests:
      totalDexRequests,

    dexscreener_rate_limited:
      totalDexRateLimits,

    dexscreener_search_rate_limited:
      dex.rateLimitedCount,

    dexscreener_global_backoff:
      dexGlobalBackoffActive(
        portfolio
      ),

    candidate_count:
      finalCandidates.length,

    eligible_candidate_count:
      eligible.length,

    jupiter_prices_requested:
      mints.length,

    jupiter_prices:
      Object.keys(
        jupiter.prices
      ).length,

    top_candidate:
      top
        ? {
            mint:
              top.mint,
            symbol:
              top.symbol,
            name:
              top.name,
            score:
              top.score,
            momentum_score:
              top.momentum_score,
            setup_score:
              top.setup_score,
            filter_reasons:
              top.filter_reasons
          }
        : null,

    estimated_external_requests:
      totalDexRequests +
      1,

    configured_request_budget:
      MAX_EXTERNAL_REQUEST_BUDGET,

    target_cloudflare_free_limit:
      50,

    rate_limited:
      totalDexRateLimits > 0,

    rate_limit_reason:
      totalDexRateLimits > 0
        ? "DEXSCREENER_HTTP_429_OR_1015"
        : null,

    endpoint_diagnostics: {
      dexscreener_discovery:
        discovery.diagnostics,

      dexscreener_search:
        dex.diagnostics,

      dexscreener_hydration:
        hydration.diagnostics,

      jupiter_prices:
        jupiter.diagnostics
    }
  };

  logEvent(
    "SCAN_COMPLETE",
    {
      duration_ms:
        diagnostics.duration_ms,

      candidates:
        diagnostics.candidate_count,

      eligible:
        diagnostics.eligible_candidate_count,

      top:
        diagnostics.top_candidate,

      dex_requests:
        diagnostics.dexscreener_requests,

      requests:
        diagnostics.estimated_external_requests,

      rate_limited:
        diagnostics.rate_limited,

      global_dex_backoff:
        diagnostics.dexscreener_backoff_active
    }
  );

  return {
    candidates:
      finalCandidates,

    diagnostics,

    portfolio
  };
}

/* ============================================================
LIVE ENGINE
============================================================ */

async function runLiveEngine(
  env,
  portfolio,
  scan
) {
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

  const eligible =
    getEligibleCandidates(
      portfolio,
      scan.candidates
    );

  let sells = 0;

  for (
    const position of [
      ...portfolio.positions
    ]
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

    await liveSell(
      env,
      portfolio,
      position,
      candidate,
      reason
    );

    sells++;
  }

  let buys = 0;

  /*
  Jupiter-only refreshes never create a new buy.
  */
  const canBuy =
    !(
      scan.candidates.length > 0 &&
      scan.candidates.every(
        candidate =>
          candidate.source ===
          "JUPITER_POSITION_REFRESH"
      )
    ) &&
    !(
      scan.diagnostics
        ?.dexscreener_global_backoff
    );

  if (
    canBuy &&
    portfolio.positions.length <
      MAX_POSITIONS
  ) {
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
        safeNumber(
          candidate.score
        ) <
        MIN_ENTRY_SCORE
      ) {
        continue;
      }

      if (
        safeNumber(
          candidate.momentum_score
        ) <
        MIN_MOMENTUM_SCORE
      ) {
        continue;
      }

      if (
        safeNumber(
          candidate.setup_score
        ) <
        MIN_SETUP_SCORE
      ) {
        continue;
      }

      if (
        evaluateCandidate(
          portfolio,
          candidate
        ).length
      ) {
        continue;
      }

      if (
        portfolio.cash_usd -
          MAX_LIVE_TRADE_USD <
        MIN_CASH_RESERVE_USD
      ) {
        continue;
      }

      await liveBuy(
        env,
        portfolio,
        candidate
      );

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
      portfolio.positions.length,
    eligible_candidates:
      eligible.length,

    top_candidate:
      scan.candidates[0]
        ? {
            mint:
              scan.candidates[0]
                .mint,
            symbol:
              scan.candidates[0]
                .symbol,
            name:
              scan.candidates[0]
                .name,
            score:
              scan.candidates[0]
                .score,
            filter_reasons:
              scan.candidates[0]
                .filter_reasons
          }
        : null
  };
}

/* ============================================================
RESPONSES
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
EXECUTION STATUS
============================================================ */

function executionStatus(env) {
  return {
    paper_mode:
      false,

    live_beta_mode:
      LIVE_BETA_MODE,

    transaction_execution:
      TRANSACTION_EXECUTION,

    live_trading_enabled:
      TRANSACTION_EXECUTION,

    automatic_signing:
      TRANSACTION_EXECUTION &&
      !!env.WALLET_PRIVATE_KEY,

    automatic_broadcast:
      TRANSACTION_EXECUTION &&
      !!env.SOLANA_RPC_URL &&
      !!env.WALLET_PRIVATE_KEY,

    scheduled_execution:
      true,

    kv_binding:
      env.BOT_KV
        ? "BOT_KV"
        : null,

    max_live_trade_usd:
      MAX_LIVE_TRADE_USD,

    max_live_bankroll_usd:
      MAX_LIVE_BANKROLL_USD,

    min_sol_reserve:
      MIN_SOL_RESERVE,

    max_confirmation_polls:
      MAX_CONFIRMATION_POLLS,

    configured_request_budget:
      MAX_EXTERNAL_REQUEST_BUDGET,

    required_secrets: {
      SOLANA_RPC_URL:
        !!env.SOLANA_RPC_URL,

      WALLET_PRIVATE_KEY:
        !!env.WALLET_PRIVATE_KEY,

      JUPITER_API_KEY:
        !!env.JUPITER_API_KEY
    }
  };
}

/* ============================================================
HEALTH
============================================================ */

async function health(env) {
  return {
    ok: true,

    bot:
      BOT_NAME,

    schema_version:
      SCHEMA_VERSION,

    mode: {
      type:
        "LIVE",

      live_beta:
        LIVE_BETA_MODE,

      transaction_execution:
        TRANSACTION_EXECUTION
    },

    execution:
      executionStatus(env),

    scanner_status:
      "OK",

    scanner_subrequest_protection: {
      enabled:
        true,

      discovery_endpoints:
        DEX_DISCOVERY_ENDPOINTS.map(
          endpoint =>
            endpoint.path
        ),

      search_queries:
        DEX_SEARCH_QUERIES,

      max_candidates:
        MAX_CANDIDATES,

      max_dex_hydrations:
        MAX_DEX_HYDRATIONS,

      max_jupiter_prices:
        MAX_JUPITER_PRICE_CHECKS,

      token_profiles:
        true,

      token_boosts:
        true,

      token_hydration:
        true,

      gecko_terminal:
        false
    },

    live_limits: {
      max_bankroll_usd:
        MAX_LIVE_BANKROLL_USD,

      max_trade_usd:
        MAX_LIVE_TRADE_USD,

      min_sol_reserve:
        MIN_SOL_RESERVE,

      min_cash_reserve_usd:
        MIN_CASH_RESERVE_USD,

      max_positions:
        MAX_POSITIONS,

      max_new_buys_per_run:
        MAX_NEW_BUYS_PER_RUN
    },

    filters: {
      min_entry_score:
        MIN_ENTRY_SCORE,

      min_momentum_score:
        MIN_MOMENTUM_SCORE,

      min_setup_score:
        MIN_SETUP_SCORE,

      min_liquidity_usd:
        MIN_LIQUIDITY_USD,

      min_volume_24h_usd:
        MIN_VOLUME_24H_USD,

      min_volume_1h_usd:
        MIN_VOLUME_1H_USD,

      new_token_min_liquidity_usd:
        NEW_TOKEN_MIN_LIQUIDITY_USD,

      max_price_mismatch_ratio:
        MAX_PRICE_MISMATCH_RATIO
    },

    dex_rate_limit_protection: {
      enabled:
        true,

      scope:
        "GLOBAL",

      discovery_protected:
        true,

      search_protected:
        true,

      hydration_protected:
        true,

      persisted_in_kv:
        true,

      base_backoff_seconds:
        DEX_BACKOFF_BASE_SECONDS,

      maximum_backoff_seconds:
        DEX_BACKOFF_MAX_SECONDS
    },

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

  clearExpiredDexBackoff(
    portfolio
  );

  return {
    ok: true,

    bot:
      BOT_NAME,

    schema_version:
      SCHEMA_VERSION,

    mode: {
      type:
        "LIVE",

      live_beta:
        LIVE_BETA_MODE,

      transaction_execution:
        TRANSACTION_EXECUTION
    },

    execution:
      executionStatus(env),

    portfolio: {
      schema_version:
        portfolio.schema_version,

      mode:
        portfolio.mode,

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

    runtime:
      {
        ...portfolio.runtime,

        dex_backoff_active:
          dexGlobalBackoffActive(
            portfolio
          ),

        dex_backoff_remaining_seconds:
          dexGlobalBackoffRemainingSeconds(
            portfolio
          )
      },

    time:
      nowIso()
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
    request.method === "GET" &&
    pathname === "/health"
  ) {
    return jsonResponse(
      await health(env)
    );
  }

  if (
    request.method === "GET" &&
    pathname === "/status"
  ) {
    return jsonResponse(
      await status(env)
    );
  }

  if (
    request.method === "GET" &&
    pathname === "/scan"
  ) {
    try {
      const portfolio =
        await loadPortfolio(
          env
        );

      const scan =
        await runScan(
          env,
          portfolio
        );

      await savePortfolio(
        env,
        portfolio,
        "HTTP_SCAN_STATE",
        true
      );

      return jsonResponse({
        ok: true,
        bot:
          BOT_NAME,
        scanner_status:
          "OK",
        mode:
          "LIVE",
        scan
      });
    } catch (error) {
      logError(
        "HTTP_SCAN_FAILED",
        error
      );

      return jsonResponse(
        {
          ok: false,
          bot:
            BOT_NAME,
          mode:
            "LIVE",
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
SCHEDULED LIVE RUN
============================================================ */

async function scheduledRun(env) {
  const started =
    Date.now();

  let portfolio =
    null;

  let currentStage =
    "INITIALIZING";

  try {
    logEvent(
      "SCHEDULED_RUN_START"
    );

    requireLiveConfig(
      env
    );

    portfolio =
      await loadPortfolio(
        env
      );

    portfolio.runtime.total_scheduled_runs++;

    portfolio.runtime.last_scheduled_run_at =
      nowIso();

    portfolio.runtime.last_scheduled_run_ok =
      null;

    portfolio.runtime.last_scheduled_error =
      null;

    portfolio.runtime.last_run_outcome =
      null;

    portfolio.runtime.last_run_rate_limited =
      false;

    setStage(
      portfolio,
      "SCAN"
    );

    currentStage =
      "SCAN";

    const scan =
      await runScan(
        env,
        portfolio
      );

    completeStage(
      portfolio,
      "SCAN"
    );

    const eligible =
      getEligibleCandidates(
        portfolio,
        scan.candidates
      );

    portfolio.runtime.last_scan_candidate_count =
      scan.candidates.length;

    portfolio.runtime.last_eligible_candidate_count =
      eligible.length;

    portfolio.runtime.last_top_candidate =
      scan.candidates[0]
        ? {
            mint:
              scan.candidates[0]
                .mint,
            symbol:
              scan.candidates[0]
                .symbol,
            name:
              scan.candidates[0]
                .name,
            score:
              scan.candidates[0]
                .score,
            momentum_score:
              scan.candidates[0]
                .momentum_score,
            setup_score:
              scan.candidates[0]
                .setup_score,
            filter_reasons:
              scan.candidates[0]
                .filter_reasons
          }
        : null;

    portfolio.runtime.last_scan_diagnostics =
      scan.diagnostics;

    /*
    A global DexScreener cooldown is NOT treated as a worker
    failure. Jupiter-only refreshes may still provide data for
    existing positions.
    */
    if (
      scan.diagnostics
        ?.rate_limited &&
      scan.diagnostics
        ?.dexscreener_global_backoff &&
      scan.candidates.length === 0
    ) {
      portfolio.runtime.last_scheduled_run_ok =
        true;

      portfolio.runtime.last_scheduled_error =
        null;

      portfolio.runtime.last_run_rate_limited =
        true;

      portfolio.runtime.last_run_outcome =
        "RATE_LIMITED";

      portfolio.runtime.total_rate_limited_runs++;

      portfolio.runtime.last_run_duration_ms =
        Date.now() -
        started;

      portfolio.runtime.last_buy_count =
        0;

      portfolio.runtime.last_sell_count =
        0;

      portfolio.runtime.last_positions_count =
        portfolio.positions.length;

      portfolio.runtime.current_stage =
        null;

      portfolio.runtime.last_completed_stage =
        "SCAN";

      portfolio.runtime.last_completed_stage_at =
        nowIso();

      await savePortfolio(
        env,
        portfolio,
        "SCHEDULED_RATE_LIMITED",
        true
      );

      return {
        ok: true,
        rate_limited:
          true
      };
    }

    setStage(
      portfolio,
      "LIVE_ENGINE"
    );

    currentStage =
      "LIVE_ENGINE";

    const engine =
      await runLiveEngine(
        env,
        portfolio,
        scan
      );

    completeStage(
      portfolio,
      "LIVE_ENGINE"
    );

    portfolio.runtime.last_scheduled_run_ok =
      true;

    portfolio.runtime.last_scheduled_error =
      null;

    portfolio.runtime.last_run_rate_limited =
      !!scan.diagnostics
        ?.rate_limited;

    portfolio.runtime.last_run_outcome =
      engine.buys > 0 ||
      engine.sells > 0
        ? "TRADE_EXECUTED"
        : scan.diagnostics
            ?.rate_limited
          ? "RATE_LIMITED"
          : "NO_TRADE";

    portfolio.runtime.last_error_stage =
      null;

    portfolio.runtime.last_error_time =
      null;

    portfolio.runtime.last_run_duration_ms =
      Date.now() -
      started;

    portfolio.runtime.last_buy_count =
      engine.buys;

    portfolio.runtime.last_sell_count =
      engine.sells;

    portfolio.runtime.last_positions_count =
      engine.positions;

    portfolio.runtime.last_eligible_candidate_count =
      engine.eligible_candidates;

    portfolio.runtime.total_successful_scheduled_runs++;

    setStage(
      portfolio,
      "PERSIST"
    );

    currentStage =
      "PERSIST";

    completeStage(
      portfolio,
      "PERSIST"
    );

    portfolio.runtime.current_stage =
      null;

    await savePortfolio(
      env,
      portfolio,
      engine.buys > 0 ||
      engine.sells > 0
        ? "SCHEDULED_TRADE_COMPLETE"
        : scan.diagnostics
            ?.rate_limited
          ? "SCHEDULED_DEX_RATE_LIMITED"
          : "SCHEDULED_SUCCESS",
      true
    );

    logEvent(
      "SCHEDULED_RUN_SUCCESS",
      {
        duration_ms:
          Date.now() -
          started,

        buys:
          engine.buys,

        sells:
          engine.sells,

        positions:
          engine.positions,

        eligible:
          engine.eligible_candidates,

        outcome:
          portfolio.runtime
            .last_run_outcome,

        dex_backoff_active:
          dexGlobalBackoffActive(
            portfolio
          )
      }
    );

    return {
      ok: true,
      engine
    };
  } catch (error) {
    const message =
      errorText(error);

    if (!portfolio) {
      try {
        portfolio =
          await loadPortfolio(
            env
          );
      } catch (loadError) {
        logError(
          "ERROR_RECOVERY_PORTFOLIO_LOAD_FAILED",
          loadError
        );
      }
    }

    if (portfolio) {
      failStage(
        portfolio,
        currentStage,
        error
      );

      portfolio.runtime.last_scheduled_run_ok =
        false;

      portfolio.runtime.last_scheduled_error =
        message;

      portfolio.runtime.last_run_outcome =
        "FAILED";

      portfolio.runtime.last_run_rate_limited =
        false;

      portfolio.runtime.last_run_duration_ms =
        Date.now() -
        started;

      portfolio.runtime.total_failed_scheduled_runs++;

      try {
        await savePortfolio(
          env,
          portfolio,
          "SCHEDULED_ERROR",
          true
        );
      } catch (persistError) {
        logError(
          "SCHEDULED_ERROR_PERSIST_FAILED",
          persistError
        );
      }
    }

    logError(
      "SCHEDULED_RUN_FAILED",
      error,
      {
        stage:
          currentStage,

        duration_ms:
          Date.now() -
          started
      }
    );

    throw error;
  }
}

/* ============================================================
WORKER
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
      logError(
        "HTTP_HANDLER_FAILED",
        error
      );

      return jsonResponse(
        {
          ok: false,
          bot:
            BOT_NAME,
          mode:
            "LIVE",
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
    await scheduledRun(
      env
    );
  }
};
