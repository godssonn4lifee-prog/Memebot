const BOT_NAME = "memebott";

/*

MEMEBOTT — SOLANA PAPER TRADING BOT

PAPER MODE ONLY.

No private key.
No wallet signing.
No live transactions.

Discovery:

- DexScreener
- GeckoTerminal
- Jupiter price cross-check

IMPORTANT:
This version is designed for PAPER testing only.

Main fixes:

- Clean paper-account validation
- Automatic repair of invalid legacy portfolio state
- Open positions are monitored independently of top-score ranking
- Safer late-pump entry filters
- Better reversal confirmation
- Better trailing-profit behavior
- Jupiter remains supplemental only
- No live transaction execution
  ============================================================
  */

const PAPER_MODE = true;

/*

PAPER ACCOUNT

*/

const PAPER_STARTING_CASH_USD = 100;
const PAPER_MIN_CASH_RESERVE_USD = 10;

const SMALL_TRADE_CAP_USD = 2;
const LARGE_TRADE_CAP_USD = 5;
const BALANCE_THRESHOLD_USD = 20;

/*

POSITION LIMITS

*/

const MAX_POSITIONS = 10;
const MAX_NEW_BUYS_PER_RUN = 1;

/*

EXIT SETTINGS

*/

const STOP_LOSS = -0.01;

/*
Trailing activates after +1%.
*/
const TRAILING_ACTIVATION = 0.01;

/*
Once trailing is active, normal trailing distance is 3%.
*/
const TRAILING_STOP = 0.03;

/*
If a position is profitable and short-term
selling pressure appears, require two observations.
*/
const REVERSAL_CONFIRMATIONS_REQUIRED = 2;

/*
Additional protection for profitable positions.
*/
const PROFIT_REVERSAL_SELL_RATIO = 1.20;

/*

SCANNER LIMITS

*/

const MAX_CANDIDATES = 30;
const MAX_DEX_TOKENS_TO_ANALYZE = 40;
const MAX_GECKO_POOLS_TO_ANALYZE = 20;
const MAX_JUPITER_PRICE_CHECKS = 20;

/*

BASIC MARKET FILTERS

*/

const MIN_TOKEN_PRICE_USD = 0.00000001;

const MIN_LIQUIDITY_USD = 15000;

const MIN_VOLUME_24H_USD = 10000;

const MIN_VOLUME_1H_USD = 1000;

/*

ENTRY PROTECTION

These prevent the bot from chasing extremely extended
moves such as:

+30% in 5 minutes
+30% in 1 hour
+1000% in a few hours

Those can still be displayed by the scanner, but they
will not automatically qualify for a new paper entry.

*/

const MAX_ENTRY_5M_PERCENT = 15;
const MAX_ENTRY_1H_PERCENT = 30;
const MAX_ENTRY_6H_PERCENT = 100;

const MAX_ENTRY_24H_PERCENT = 500;

/*
Very new tokens need stronger liquidity.
*/
const NEW_TOKEN_DAYS = 1;

const NEW_TOKEN_MIN_LIQUIDITY_USD = 25000;

/*

MARKET SHAPE

*/

const EXTREME_1H_MOVE_PERCENT = 50;

const STRONG_NEGATIVE_6H_PERCENT = -15;

const STRONG_NEGATIVE_5M_PERCENT = -3;

const BOUNCE_5M_PERCENT = 7;

const SHORT_TERM_SELL_RATIO = 1.50;

const HOURLY_SELL_RATIO = 1.43;

/*

ENTRY SCORE

*/

const MIN_ENTRY_SCORE = 50;

const MIN_MOMENTUM_SCORE = 5;

/*

COOLDOWN

*/

const COOLDOWN_SECONDS = 60;

/*

STORAGE

*/

const PORTFOLIO_KEY = "PAPER_PORTFOLIO";
const HISTORY_KEY = "PAPER_TRADE_HISTORY";
const COOLDOWN_KEY = "PAPER_TRADE_COOLDOWN";
const SCAN_KEY = "LAST_SCAN";

/*

APIS

*/

const DEXSCREENER_API =
"https://api.dexscreener.com";

const GECKO_API =
"https://api.geckoterminal.com/api/v2";

const JUPITER_PRICE_API =
"https://api.jup.ag/price/v3";

/*

HELPERS

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

function ageDays(timestamp) {
if (!timestamp) {
return 9999;
}

const age =
Date.now() -
Number(timestamp);

if (
!Number.isFinite(age) ||
age < 0
) {
return 0;
}

return age / 86400000;
}

function normalizeAddress(value) {
return String(
value || ""
).trim();
}

function isValidMint(mint) {
return (
typeof mint === "string" &&
mint.length >= 32 &&
mint.length <= 50
);
}

function isBlockedSymbol(symbol) {
return new Set([
"USDC",
"USDT",
"USD1",
"USDS",
"DAI",
"SOL",
"WSOL"
]).has(
String(symbol || "")
.toUpperCase()
);
}

async function getJson(
url,
headers = {}
) {
const response =
await fetch(
url,
{
method: "GET",

    headers: {
      accept:
        "application/json",

      ...headers
    }
  }
);

if (!response.ok) {
throw new Error(
"HTTP ${response.status} from ${url}"
);
}

return await response.json();
}

/*

PORTFOLIO

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

function portfolioLooksValid(
portfolio
) {
if (
!portfolio ||
typeof portfolio !== "object"
) {
return false;
}

if (
!Array.isArray(
portfolio.open_positions
)
) {
return false;
}

if (
!Number.isFinite(
Number(
portfolio.starting_cash_usd
)
)
) {
return false;
}

if (
!Number.isFinite(
Number(
portfolio.cash_usd
)
)
) {
return false;
}

return true;
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
const parsed =
JSON.parse(raw);

if (
  !portfolioLooksValid(
    parsed
  )
) {
  const fresh =
    createFreshPortfolio();

  await savePortfolio(
    env,
    fresh
  );

  return fresh;
}

/*
Normalize numeric fields.
*/

parsed.starting_cash_usd =
  safeNumber(
    parsed.starting_cash_usd,
    PAPER_STARTING_CASH_USD
  );

parsed.cash_usd =
  safeNumber(
    parsed.cash_usd,
    parsed.starting_cash_usd
  );

parsed.realized_pnl_usd =
  safeNumber(
    parsed.realized_pnl_usd
  );

parsed.unrealized_pnl_usd =
  safeNumber(
    parsed.unrealized_pnl_usd
  );

parsed.total_pnl_usd =
  safeNumber(
    parsed.total_pnl_usd
  );

parsed.return_percent =
  safeNumber(
    parsed.return_percent
  );

/*
Clean malformed positions.
*/

parsed.open_positions =
  parsed.open_positions.filter(
    position =>
      position &&
      isValidMint(
        position.mint
      ) &&
      safeNumber(
        position.entry_price
      ) > 0 &&
      safeNumber(
        position.current_price
      ) > 0 &&
      safeNumber(
        position.highest_price
      ) > 0 &&
      safeNumber(
        position.quantity
      ) > 0 &&
      safeNumber(
        position.invested_usd
      ) > 0
  );

return parsed;

} catch {
const fresh =
createFreshPortfolio();

await savePortfolio(
  env,
  fresh
);

return fresh;

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
JSON.stringify(
portfolio
)
);
}

/*

TRADE HISTORY

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

return Array.isArray(
  history
)
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
await env.BOT_KV.put(
HISTORY_KEY,
JSON.stringify(
history.slice(-500)
)
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

COOLDOWN

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
const parsed =
JSON.parse(raw);

if (
  typeof parsed !==
    "object" ||
  parsed === null ||
  Array.isArray(parsed)
) {
  return {};
}

return parsed;

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
JSON.stringify(
cooldowns
)
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

const now =
Date.now();

for (
const key of
Object.keys(
cooldowns
)
) {
if (
now -
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

DEXSCREENER DISCOVERY

*/

async function getDexScreenerDiscovery() {
const results = [];

const urls = [
"${DEXSCREENER_API}/token-profiles/latest/v1",
"${DEXSCREENER_API}/token-boosts/latest/v1",
"${DEXSCREENER_API}/token-boosts/top/v1"
];

for (
const url of
urls
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

} catch {}

}

const unique =
new Map();

for (
const item of
results
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

DEXSCREENER SEARCH

*/

async function getDexSearchCandidates() {
const searches = [
"SOL",
"USDC",
"USDT"
];

const candidates = [];

for (
const query of
searches
) {
try {
const url =
"${DEXSCREENER_API}" +
"/latest/dex/search?q=" +
encodeURIComponent(
query
);

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

    const mint =
      normalizeAddress(
        pair.baseToken?.address
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

} catch {}

}

return candidates;
}

/*

DEX HYDRATION

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

try {
const url =
"${DEXSCREENER_API}" +
"/tokens/v1/solana/" +
uniqueMints.join(",");

const pairs =
  await getJson(url);

if (
  !Array.isArray(
    pairs
  )
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

/*

GECKOTERMINAL

*/

async function getGeckoTrendingPools() {
try {
const url =
"${GECKO_API}" +
"/networks/solana/trending_pools";

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
  .map(
    pool => {
      const attrs =
        pool.attributes ||
        {};

      const relationships =
        pool.relationships ||
        {};

      return {
        source:
          "GECKOTERMINAL",

        pool_address:
          String(
            pool.id || ""
          ),

        name:
          attrs.name ||
          null,

        address:
          relationships
            ?.base_token
            ?.data
            ?.id ||
          null,

        attributes:
          attrs
      };
    }
  );

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

if (
!textValue
) {
return "";
}

if (
textValue.includes("")
) {
return textValue
.split("")
.slice(1)
.join("_");
}

return textValue;
}

/*

JUPITER PRICE CHECK

*/

async function getJupiterCrossCheck(
env,
mints
) {
const unique = [
...new Set(
mints.filter(
isValidMint
)
)
].slice(
0,
MAX_JUPITER_PRICE_CHECKS
);

if (
!unique.length
) {
return {
checked: 0,
confirmed: 0,
prices: {}
};
}

const prices = {};

let checked = 0;
let confirmed = 0;

try {
const url =
"${JUPITER_PRICE_API}?ids=" +
encodeURIComponent(
unique.join(",")
);

const headers = {};

if (
  env.JUPITER_API_KEY
) {
  headers[
    "x-api-key"
  ] =
    env.JUPITER_API_KEY;
}

const data =
  await getJson(
    url,
    headers
  );

for (
  const mint of
  unique
) {
  checked++;

  const record =
    data?.[mint];

  if (
    record?.usdPrice
  ) {
    const price =
      safeNumber(
        record.usdPrice
      );

    if (
      price > 0
    ) {
      prices[mint] =
        price;

      confirmed++;
    }
  }
}

} catch {
/*
Supplemental only.
*/
}

return {
checked,
confirmed,
prices
};
}

/*

NORMALIZE DEX DATA

*/

function normalizeDexPair(
pair
) {
const txns =
pair.txns || {};

const volume =
pair.volume || {};

const change =
pair.priceChange || {};

const h24 =
txns.h24 || {};

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

BUY PRESSURE

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
return 0.5;
}

return buys / total;
}

function calculateBuyPressure5m(
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

return buys / total;
}

function calculateBuyPressureScore(
data
) {
const pressure =
calculateBuyPressure(
data
);

if (
pressure >= 0.70
) return 15;

if (
pressure >= 0.62
) return 12;

if (
pressure >= 0.56
) return 9;

if (
pressure >= 0.52
) return 6;

if (
pressure >= 0.50
) return 3;

return 0;
}

/*

MOMENTUM

*/

function calculateMomentumScore(
data
) {
const five =
safeNumber(
data.price_change_5m
);

const one =
safeNumber(
data.price_change_1h
);

const six =
safeNumber(
data.price_change_6h
);

let score = 0;

if (
five > 0
) score += 5;

if (
five >= 1
) score += 3;

if (
five >= 3
) score += 3;

if (
one > 0
) score += 5;

if (
one >= 5
) score += 3;

if (
one >= 15
) score += 3;

if (
six > 0
) score += 2;

return clamp(
score,
0,
20
);
}

/*

VOLUME

*/

function calculateVolumeScore(
data
) {
const v24 =
safeNumber(
data.volume_24h_usd
);

const v1 =
safeNumber(
data.volume_1h_usd
);

let score = 0;

if (
v24 >= 25000
) score += 5;

if (
v24 >= 100000
) score += 3;

if (
v24 >= 1000000
) score += 3;

if (
v1 >= 2500
) score += 3;

if (
v1 >= 10000
) score += 3;

if (
v1 >= 50000
) score += 3;

return clamp(
score,
0,
17
);
}

/*

LIQUIDITY

*/

function calculateLiquidityScore(
data
) {
const liquidity =
safeNumber(
data.liquidity_usd
);

if (
liquidity >= 250000
) return 15;

if (
liquidity >= 100000
) return 13;

if (
liquidity >= 50000
) return 10;

if (
liquidity >= 25000
) return 7;

if (
liquidity >= 15000
) return 4;

return 0;
}

/*

ACCELERATION

*/

function calculateAccelerationScore(
data
) {
const five =
safeNumber(
data.price_change_5m
);

const one =
safeNumber(
data.price_change_1h
);

let score = 0;

if (
five > 0 &&
one > 0
) {
score += 5;
}

if (
five >= 1
) {
score += 2;
}

if (
five >= 2 &&
one >= 5
) {
score += 2;
}

return clamp(
score,
0,
9
);
}

/*

MARKET SHAPE

*/

function analyzeMarketShape(
data
) {
let penalty = 0;

const reasons = [];

const five =
safeNumber(
data.price_change_5m
);

const one =
safeNumber(
data.price_change_1h
);

const six =
safeNumber(
data.price_change_6h
);

const buy5 =
safeNumber(
data.buys_5m
);

const sell5 =
safeNumber(
data.sells_5m
);

const buy1 =
safeNumber(
data.buys_1h
);

const sell1 =
safeNumber(
data.sells_1h
);

if (
one >=
EXTREME_1H_MOVE_PERCENT
) {
penalty += 10;

reasons.push(
  "EXTREME_1H_MOVE"
);

}

if (
five < 0 &&
sell5 >
buy5 *
SHORT_TERM_SELL_RATIO
) {
penalty += 6;

reasons.push(
  "SHORT_TERM_SELL_PRESSURE"
);

}

if (
one < 0 &&
sell1 >
buy1 *
HOURLY_SELL_RATIO
) {
penalty += 7;

reasons.push(
  "HOURLY_SELL_PRESSURE"
);

}

if (
six > 10 &&
five < 0
) {
penalty += 8;

reasons.push(
  "SHORT_TERM_REVERSAL"
);

}

if (
five >=
BOUNCE_5M_PERCENT &&
one < 0
) {
penalty += 5;

reasons.push(
  "BOUNCE_AGAINST_TREND"
);

}

/*
Additional penalty for extreme acceleration.
*/

if (
five >=
MAX_ENTRY_5M_PERCENT
) {
penalty += 8;

reasons.push(
  "EXTREME_5M_ACCELERATION"
);

}

if (
one >=
MAX_ENTRY_1H_PERCENT
) {
penalty += 8;

reasons.push(
  "EXTREME_1H_ACCELERATION"
);

}

if (
six >=
MAX_ENTRY_6H_PERCENT
) {
penalty += 8;

reasons.push(
  "EXTREME_6H_ACCELERATION"
);

}

return {
penalty,
reasons
};
}

/*

RISK

*/

function assessRisk(
data
) {
const reasons = [];

if (
data.price_usd <
MIN_TOKEN_PRICE_USD
) {
reasons.push(
"INVALID_PRICE"
);
}

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
data.price_change_5m <=
STRONG_NEGATIVE_5M_PERCENT
) {
reasons.push(
"SEVERE_5M_DECLINE"
);
}

if (
data.price_change_6h <=
STRONG_NEGATIVE_6H_PERCENT
) {
reasons.push(
"NEGATIVE_6H_MOMENTUM"
);
}

/*
Very new tokens need deeper liquidity.
*/

if (
data.pair_age_days <=
NEW_TOKEN_DAYS &&
data.liquidity_usd <
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

/*

ENTRY QUALITY

*/

function evaluateEntryQuality(
data,
score,
momentumScore
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
data.volume_1h_usd <
MIN_VOLUME_1H_USD
) {
reasons.push(
"LOW_1H_VOLUME"
);
}

if (
momentumScore <
MIN_MOMENTUM_SCORE
) {
reasons.push(
"WEAK_MOMENTUM"
);
}

if (
data.price_change_5m <=
STRONG_NEGATIVE_5M_PERCENT
) {
reasons.push(
"SEVERE_5M_DECLINE"
);
}

/*
Do not chase a sharp move.
*/

if (
data.price_change_5m >=
MAX_ENTRY_5M_PERCENT
) {
reasons.push(
"CHASE_PROTECTION_5M"
);
}

if (
data.price_change_1h >=
MAX_ENTRY_1H_PERCENT
) {
reasons.push(
"CHASE_PROTECTION_1H"
);
}

if (
data.price_change_6h >=
MAX_ENTRY_6H_PERCENT
) {
reasons.push(
"CHASE_PROTECTION_6H"
);
}

if (
data.price_change_24h >=
MAX_ENTRY_24H_PERCENT
) {
reasons.push(
"CHASE_PROTECTION_24H"
);
}

if (
score <
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

/*

SCORING

*/

function scoreCandidate(
data,
sources,
jupiterConfirmed
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

let crossSource = 0;

if (
sources.dexscreener &&
sources.geckoterminal
) {
crossSource = 10;
} else if (
sources.geckoterminal
) {
crossSource = 5;
}

/*
Jupiter confirmation is intentionally
NOT a score boost. It is a sanity check.
*/

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
grossScore -
marketShape.penalty;

const risk =
assessRisk(
data
);

const entry =
evaluateEntryQuality(
data,
total,
momentum
);

return {
total,

gross_score:
  grossScore,

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
  jupiterConfirmed,

risk,

entry

};
}

/*

BUILD CANDIDATES

*/

async function buildCandidates(
env
) {
const dexDiscovery =
await getDexScreenerDiscovery();

const dexSearch =
await getDexSearchCandidates();

const gecko =
await getGeckoTrendingPools();

const allMints =
new Set();

for (
const item of
dexDiscovery
) {
allMints.add(
item.mint
);
}

for (
const item of
dexSearch
) {
allMints.add(
item.mint
);
}

for (
const item of
gecko
) {
const mint =
extractGeckoMint(
item.address
);

if (
  isValidMint(mint)
) {
  allMints.add(
    mint
  );
}

}

const dexCandidates = [
...dexDiscovery,
...dexSearch
];

const hydratedPairs =
await hydrateDexCandidates(
dexCandidates
);

const geckoMints =
new Set();

for (
const item of
gecko
) {
const mint =
extractGeckoMint(
item.address
);

if (
  isValidMint(mint)
) {
  geckoMints.add(
    mint
  );
}

}

const jupiter =
await getJupiterCrossCheck(
env,
[...allMints]
);

const candidates =
new Map();

/*
Use the strongest available pair
for each token rather than allowing
duplicate pairs to overwrite each other.
*/

const pairsByMint =
new Map();

for (
const pair of
hydratedPairs
) {
const mint =
normalizeAddress(
pair.baseToken?.address
);

if (
  !isValidMint(mint)
) {
  continue;
}

if (
  isBlockedSymbol(
    pair.baseToken?.symbol
  )
) {
  continue;
}

if (
  !pairsByMint.has(mint)
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

for (
const [
mint,
pairs
] of
pairsByMint
) {
const bestPair =
getBestDexPair(
pairs,
mint
);

if (!bestPair) {
  continue;
}

const data =
  normalizeDexPair(
    bestPair
  );

const sourceInfo = {
  dexscreener:
    true,

  geckoterminal:
    geckoMints.has(
      mint
    ),

  jupiter_price:
    false
};

if (
  jupiter.prices[mint]
) {
  const jp =
    safeNumber(
      jupiter.prices[mint]
    );

  if (
    jp > 0 &&
    data.price_usd > 0
  ) {
    const difference =
      Math.abs(
        jp -
          data.price_usd
      ) /
      data.price_usd;

    if (
      difference <= 0.15
    ) {
      sourceInfo.jupiter_price =
        true;
    }
  }
}

const scoring =
  scoreCandidate(
    data,
    sourceInfo,
    sourceInfo.jupiter_price
  );

candidates.set(
  mint,
  {
    ...data,

    score:
      scoring.total,

    score_breakdown: {
      total:
        scoring.total,

      gross_score:
        scoring.gross_score,

      momentum:
        scoring.momentum,

      volume:
        scoring.volume,

      liquidity:
        scoring.liquidity,

      buy_pressure:
        scoring.buy_pressure,

      acceleration:
        scoring.acceleration,

      cross_source:
        scoring.cross_source,

      penalties:
        scoring.penalties,

      penalty_reasons:
        scoring.penalty_reasons,

      jupiter_price_check:
        scoring.jupiter_price_check
    },

    entry_quality:
      scoring.entry.eligible,

    entry_reasons:
      scoring.entry.reasons,

    sources:
      sourceInfo,

    market_shape: {
      penalty:
        scoring.penalties,

      reasons:
        scoring.penalty_reasons
    },

    risk:
      scoring.risk,

    decision:
      scoring.entry.eligible &&
      scoring.risk.pass
        ? "PAPER_ELIGIBLE"
        : "REJECTED"
  }
);

}

const sorted =
[
...candidates.values()
]
.sort(
(a, b) =>
b.score -
a.score
)
.slice(
0,
MAX_CANDIDATES
);

return {
candidates:
sorted,

counts: {
  dexscreener_discovery:
    dexDiscovery.length,

  dexscreener_search:
    dexSearch.length,

  gecko_trending:
    gecko.length,

  gecko_confirmed_tokens:
    geckoMints.size,

  jupiter_price_checked:
    jupiter.checked,

  jupiter_price_confirmed:
    jupiter.confirmed,

  hydrated_pairs:
    hydratedPairs.length
}

};
}

/*

PAPER TRADE SIZE

*/

function calculateTradeSize(
cash
) {
const available =
Math.max(
0,
cash -
PAPER_MIN_CASH_RESERVE_USD
);

if (
cash >=
BALANCE_THRESHOLD_USD
) {
return Math.min(
LARGE_TRADE_CAP_USD,
available
);
}

return Math.min(
SMALL_TRADE_CAP_USD,
available
);
}

/*

PAPER BUY

*/

async function openPaperPosition(
env,
portfolio,
candidate
) {
if (
portfolio.open_positions
.length >=
MAX_POSITIONS
) {
return {
opened: false,

  reason:
    "MAX_POSITIONS"
};

}

if (
await isCoolingDown(
env,
candidate.mint
)
) {
return {
opened: false,

  reason:
    "COOLDOWN"
};

}

const tradeUsd =
calculateTradeSize(
portfolio.cash_usd
);

if (
tradeUsd <= 0
) {
return {
opened: false,

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
opened: false,

  reason:
    "INVALID_PRICE"
};

}

const quantity =
tradeUsd /
price;

const position = {
mint:
candidate.mint,

symbol:
  candidate.symbol,

name:
  candidate.name,

entry_price:
  price,

current_price:
  price,

highest_price:
  price,

quantity,

invested_usd:
  tradeUsd,

entry_time:
  nowIso(),

score:
  candidate.score,

trailing_active:
  false,

reversal_confirmations:
  0,

source_snapshot:
  candidate.sources,

last_seen_at:
  nowIso()

};

portfolio.cash_usd -=
tradeUsd;

/*
Avoid floating-point noise.
*/

portfolio.cash_usd =
Math.max(
0,
portfolio.cash_usd
);

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
action:
"PAPER_BUY",

  mint:
    candidate.mint,

  symbol:
    candidate.symbol,

  price,

  quantity,

  amount_usd:
    tradeUsd,

  score:
    candidate.score
}

);

return {
opened: true,

position

};
}

/*

POSITION EXIT LOGIC

*/

function updatePosition(
position,
candidate
) {
const price =
safeNumber(
candidate.price_usd
);

if (
price <= 0
) {
return {
action:
"HOLD",

  reason:
    "INVALID_PRICE"
};

}

position.current_price =
price;

position.last_seen_at =
nowIso();

if (
price >
position.highest_price
) {
position.highest_price =
price;
}

const entry =
safeNumber(
position.entry_price
);

const pnl =
entry > 0
? (
price -
entry
) /
entry
: 0;

const high =
safeNumber(
position.highest_price
);

const drawdown =
high > 0
? (
price -
high
) /
high
: 0;

/*
HARD STOP
*/

if (
pnl <=
STOP_LOSS
) {
return {
action:
"SELL",

  reason:
    "HARD_STOP",

  pnl,

  drawdown
};

}

/*
Activate trailing protection
after the position reaches profit.
*/

if (
pnl >=
TRAILING_ACTIVATION
) {
position.trailing_active =
true;
}

/*
TRAILING STOP
*/

if (
position.trailing_active &&
drawdown <=
-TRAILING_STOP
) {
return {
action:
"SELL",

  reason:
    "TRAILING_STOP",

  pnl,

  drawdown
};

}

/*
REVERSAL CONFIRMATION
*/

const buyPressure5 =
calculateBuyPressure5m(
candidate
);

const sellPressure =
buyPressure5 <
0.50;

/*
Only count reversal observations
while the position is profitable.
*/

if (
position.trailing_active &&
pnl > 0 &&
sellPressure
) {
position.reversal_confirmations++;

if (
  position.reversal_confirmations >=
  REVERSAL_CONFIRMATIONS_REQUIRED
) {
  return {
    action:
      "SELL",

    reason:
      "REVERSAL_CONFIRMATION",

    pnl,

    drawdown
  };
}

} else if (
buyPressure5 >=
0.50
) {
position.reversal_confirmations =
0;
}

/*
Stronger reversal protection for a
profitable position.

This does NOT instantly sell.
It only contributes to confirmation.
*/

const hourlyPressure =
calculateBuyPressure(
candidate
);

if (
position.trailing_active &&
pnl > 0 &&
hourlyPressure <
1 /
(1 +
PROFIT_REVERSAL_SELL_RATIO)
) {
position.reversal_confirmations++;

if (
  position.reversal_confirmations >=
  REVERSAL_CONFIRMATIONS_REQUIRED
) {
  return {
    action:
      "SELL",

    reason:
      "PROFIT_REVERSAL_CONFIRMATION",

    pnl,

    drawdown
  };
}

}

return {
action:
"HOLD",

pnl,

drawdown

};
}

/*

PAPER SELL

*/

async function closePaperPosition(
env,
portfolio,
index,
candidate,
reason
) {
const position =
portfolio.open_positions[
index
];

if (!position) {
return null;
}

const exitPrice =
safeNumber(
candidate.price_usd,
position.current_price
);

if (
exitPrice <= 0
) {
return null;
}

const proceeds =
position.quantity *
exitPrice;

const pnl =
proceeds -
position.invested_usd;

portfolio.cash_usd +=
proceeds;

portfolio.realized_pnl_usd +=
pnl;

portfolio.open_positions
.splice(
index,
1
);

await addHistory(
env,
{
action:
"PAPER_SELL",

  reason,

  mint:
    position.mint,

  symbol:
    position.symbol,

  entry_price:
    position.entry_price,

  exit_price:
    exitPrice,

  quantity:
    position.quantity,

  invested_usd:
    position.invested_usd,

  proceeds_usd:
    proceeds,

  pnl_usd:
    pnl,

  pnl_percent:
    position.entry_price > 0
      ? (
          (
            exitPrice -
            position.entry_price
          ) /
          position.entry_price
        ) *
        100
      : 0
}

);

return {
sold: true,

symbol:
  position.symbol,

mint:
  position.mint,

exit_price:
  exitPrice,

proceeds_usd:
  proceeds,

pnl_usd:
  pnl,

reason

};
}

/*

POSITION MONITORING

Important fix:

Open positions are monitored using fresh DexScreener
data even if they are no longer among the top-ranked
scanner candidates.

This prevents a position from becoming invisible
simply because its score falls.

*/

async function getFreshPairForMint(
mint
) {
if (
!isValidMint(mint)
) {
return null;
}

try {
const url =
"${DEXSCREENER_API}" +
"/tokens/v1/solana/" +
mint;

const pairs =
  await getJson(url);

if (
  !Array.isArray(
    pairs
  )
) {
  return null;
}

const solanaPairs =
  pairs.filter(
    pair =>
      String(
        pair.chainId || ""
      ).toLowerCase() ===
      "solana" &&
      normalizeAddress(
        pair.baseToken?.address
      ) === mint
  );

if (
  !solanaPairs.length
) {
  return null;
}

return getBestDexPair(
  solanaPairs,
  mint
);

} catch {
return null;
}
}

async function monitorOpenPositions(
env,
portfolio
) {
const sells = [];

for (
let i =
portfolio.open_positions
.length -
1;
i >= 0;
i--
) {
const position =
portfolio.open_positions[
i
];

const pair =
  await getFreshPairForMint(
    position.mint
  );

if (!pair) {
  continue;
}

const candidate =
  normalizeDexPair(
    pair
  );

/*
Preserve the position's
existing state while updating
current market information.
*/

candidate.mint =
  position.mint;

const decision =
  updatePosition(
    position,
    candidate
  );

if (
  decision.action ===
  "SELL"
) {
  const result =
    await closePaperPosition(
      env,
      portfolio,
      i,
      candidate,
      decision.reason
    );

  if (result) {
    sells.push(
      result
    );
  }
}

}

return sells;
}

/*

PORTFOLIO MARKING

*/

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

let unrealized = 0;

let positionValue = 0;

for (
const position of
portfolio.open_positions
) {
const candidate =
byMint.get(
position.mint
);

if (
  candidate &&
  safeNumber(
    candidate.price_usd
  ) > 0
) {
  position.current_price =
    candidate.price_usd;

  if (
    candidate.price_usd >
    position.highest_price
  ) {
    position.highest_price =
      candidate.price_usd;
  }
}

const currentValue =
  position.quantity *
  position.current_price;

positionValue +=
  currentValue;

unrealized +=
  currentValue -
  position.invested_usd;

}

portfolio.unrealized_pnl_usd =
unrealized;

portfolio.total_pnl_usd =
portfolio.realized_pnl_usd +
portfolio.unrealized_pnl_usd;

const equity =
portfolio.cash_usd +
positionValue;

portfolio.return_percent =
portfolio.starting_cash_usd > 0
? (
(
equity -
portfolio.starting_cash_usd
) /
portfolio.starting_cash_usd
) *
100
: 0;

return {
equity,

position_value:
  positionValue

};
}

/*

RUN PAPER ENGINE

*/

async function runPaperEngine(
env
) {
const portfolio =
await getPortfolio(
env
);

/*
FIRST:
Monitor existing positions with
dedicated fresh price lookups.
*/

const sells =
await monitorOpenPositions(
env,
portfolio
);

/*
SECOND:
Run the general market scanner.
*/

const scan =
await buildCandidates(
env
);

const candidates =
scan.candidates;

const buys = [];

/*
Open at most one new position.
*/

if (
buys.length <
MAX_NEW_BUYS_PER_RUN &&
portfolio.open_positions
.length <
MAX_POSITIONS
) {
for (
const candidate of
candidates
) {
if (
buys.length >=
MAX_NEW_BUYS_PER_RUN
) {
break;
}

  if (
    !candidate.entry_quality ||
    !candidate.risk.pass
  ) {
    continue;
  }

  if (
    portfolio.open_positions
      .some(
        p =>
          p.mint ===
          candidate.mint
      )
  ) {
    continue;
  }

  if (
    await isCoolingDown(
      env,
      candidate.mint
    )
  ) {
    continue;
  }

  const result =
    await openPaperPosition(
      env,
      portfolio,
      candidate
    );

  if (
    result.opened
  ) {
    buys.push(
      result.position
    );
  }
}

}

/*
Mark the portfolio.
*/

const marked =
markPortfolio(
portfolio,
candidates
);

portfolio.last_run_at =
nowIso();

await savePortfolio(
env,
portfolio
);

await env.BOT_KV.put(
SCAN_KEY,
JSON.stringify({
timestamp:
nowIso(),

  total_candidates:
    candidates.length,

  candidates,

  source_counts:
    scan.counts
})

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

buys:
  buys.length,

sells:
  sells.length,

buy_details:
  buys,

sell_details:
  sells,

portfolio: {
  cash_usd:
    portfolio.cash_usd,

  position_value_usd:
    marked.position_value,

  equity_usd:
    marked.equity,

  realized_pnl_usd:
    portfolio.realized_pnl_usd,

  unrealized_pnl_usd:
    portfolio.unrealized_pnl_usd,

  total_pnl_usd:
    portfolio.total_pnl_usd,

  return_percent:
    portfolio.return_percent,

  open_positions:
    portfolio.open_positions
      .length
},

scan: {
  total_candidates:
    candidates.length,

  risk_pass_candidates:
    candidates.filter(
      x =>
        x.risk.pass
    ).length,

  eligible_candidates:
    candidates.filter(
      x =>
        x.entry_quality &&
        x.risk.pass
    ).length,

  source_counts:
    scan.counts,

  top_candidates:
    candidates.slice(
      0,
      10
    )
}

};
}

/*

SCAN

*/

async function runScan(
env
) {
const scan =
await buildCandidates(
env
);

await env.BOT_KV.put(
SCAN_KEY,
JSON.stringify({
timestamp:
nowIso(),

  total_candidates:
    scan.candidates.length,

  candidates:
    scan.candidates,

  source_counts:
    scan.counts
})

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
  "Scanner test completed.",

scan: {
  total_candidates:
    scan.candidates.length,

  risk_pass_candidates:
    scan.candidates.filter(
      x =>
        x.risk.pass
    ).length,

  eligible_candidates:
    scan.candidates.filter(
      x =>
        x.entry_quality &&
        x.risk.pass
    ).length,

  source_counts:
    scan.counts,

  top_candidates:
    scan.candidates.slice(
      0,
      10
    )
}

};
}

/*

RESET PAPER ACCOUNT

*/

async function resetPaper(
env
) {
const portfolio =
createFreshPortfolio();

await env.BOT_KV.put(
PORTFOLIO_KEY,
JSON.stringify(
portfolio
)
);

await env.BOT_KV.put(
HISTORY_KEY,
JSON.stringify([])
);

await env.BOT_KV.put(
COOLDOWN_KEY,
JSON.stringify({})
);

await env.BOT_KV.delete(
SCAN_KEY
);

return {
ok: true,

bot:
  BOT_NAME,

message:
  "Paper account reset.",

portfolio

};
}

/*

STATUS

*/

async function getStatus(
env
) {
const portfolio =
await getPortfolio(
env
);

const history =
await getHistory(
env
);

const cooldowns =
await getCooldowns(
env
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

configuration: {
  starting_cash_usd:
    PAPER_STARTING_CASH_USD,

  minimum_cash_reserve_usd:
    PAPER_MIN_CASH_RESERVE_USD,

  small_trade_cap_usd:
    SMALL_TRADE_CAP_USD,

  large_trade_cap_usd:
    LARGE_TRADE_CAP_USD,

  max_positions:
    MAX_POSITIONS,

  max_new_buys_per_run:
    MAX_NEW_BUYS_PER_RUN,

  stop_loss_percent:
    STOP_LOSS * 100,

  trailing_activation_percent:
    TRAILING_ACTIVATION * 100,

  trailing_stop_percent:
    TRAILING_STOP * 100,

  reversal_confirmations_required:
    REVERSAL_CONFIRMATIONS_REQUIRED,

  max_entry_5m_percent:
    MAX_ENTRY_5M_PERCENT,

  max_entry_1h_percent:
    MAX_ENTRY_1H_PERCENT,

  max_entry_6h_percent:
    MAX_ENTRY_6H_PERCENT,

  max_entry_24h_percent:
    MAX_ENTRY_24H_PERCENT,

  paper_mode:
    PAPER_MODE
},

portfolio,

history_count:
  history.length,

active_cooldowns:
  Object.keys(
    cooldowns
  ).length

};
}

/*

TEST

*/

async function testScanner(
env
) {
const scan =
await buildCandidates(
env
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
  "Scanner test completed. No position was opened.",

scan: {
  total_candidates:
    scan.candidates.length,

  risk_pass_candidates:
    scan.candidates.filter(
      x =>
        x.risk.pass
    ).length,

  eligible_candidates:
    scan.candidates.filter(
      x =>
        x.entry_quality &&
        x.risk.pass
    ).length,

  source_counts:
    scan.counts,

  top_candidates:
    scan.candidates.slice(
      0,
      10
    )
}

};
}

/*

HTTP ROUTER

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

if (
path === "/" ||
path === ""
) {
return Response.json({
ok: true,

  bot:
    BOT_NAME,

  mode:
    "PAPER",

  transaction_execution:
    false,

  message:
    "memebott is online."
});

}

if (
path === "/status"
) {
return Response.json(
await getStatus(
env
)
);
}

if (
path === "/scan"
) {
return Response.json(
await runScan(
env
)
);
}

if (
path === "/test"
) {
return Response.json(
await testScanner(
env
)
);
}

if (
path === "/run"
) {
return Response.json(
await runPaperEngine(
env
)
);
}

if (
path === "/trades"
) {
return Response.json({
ok: true,

  bot:
    BOT_NAME,

  mode:
    "PAPER",

  trades:
    await getHistory(
      env
    )
});

}

if (
path === "/reset-paper"
) {
if (
url.searchParams.get(
"confirm"
) !== "RESET"
) {
return Response.json(
{
ok: false,

      error:
        "Use /reset-paper?confirm=RESET to reset the paper account."
    },
    {
      status: 400
    }
  );
}

return Response.json(
  await resetPaper(
    env
  )
);

}

return Response.json(
{
ok: false,

  error:
    "Not found"
},
{
  status: 404
}

);
}

/*

CLOUDFLARE WORKER

*/

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
  return Response.json(
    {
      ok: false,

      bot:
        BOT_NAME,

      error:
        error?.message ||
        String(error),

      mode:
        "PAPER",

      transaction_execution:
        false,

      safety:
        "No live transaction execution is implemented."
    },
    {
      status: 500
    }
  );
}

},

async scheduled(
event,
env,
ctx
) {
ctx.waitUntil(
runPaperEngine(
env
).catch(
async error => {
await addHistory(
env,
{
action:
"ENGINE_ERROR",

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
