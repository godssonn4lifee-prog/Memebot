const BOT_NAME = "memebott";
/*
 ============================================================
 MEMEBOTT — LIVE TRADING LAUNCH
 ============================================================
 Strategy revision:
 - Scanner still runs every minute.
 - KV persistence remains throttled.
 - Compact short-term candidate memory is maintained.
 - Historical observations help identify early momentum.
 - Existing safety filters remain intact.
 - Duplicate extreme 1h penalty removed.
 - Live transaction execution is enabled; automatic scheduled runs may execute real swaps within the configured limits and gates.
 - Discovery diagnostics enabled.
 - DexScreener batch hydration enabled.
 - Jupiter Price API v3 robust response parsing enabled.
 - Jupiter fallback price diagnostics enabled.
 - Liquidity-source diagnostics enabled.
*/
const PAPER_MODE = false;
const LIVE_BETA_MODE = true;
const TRANSACTION_EXECUTION = true;
const PAPER_SCHEMA_VERSION = 5;
/* ============================================================
 BASIC SETTINGS
 ============================================================ */
const STARTING_CASH_USD = 20;
const MIN_CASH_RESERVE_USD = 10;
const MAX_POSITIONS = 7;
const MAX_NEW_BUYS_PER_RUN = 1;
const MAX_PAPER_POSITION_USD = 2;
const MAX_LIVE_TRADE_USD = 2;
const LIVE_SLIPPAGE_BPS = 100;
const LIVE_MIN_SOL_RESERVE = 0.01;
const MAX_LIVE_BANKROLL_USD = 20;
const LIVE_QUOTE_API = "https://quote-api.jup.ag/v6";
const SOL_MINT = "So11111111111111111111111111111111111111112";
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
/* ============================================================ CHASE
PROTECTION
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
const MAX_DEX_TOKENS_ANALYZED = 20;
const MAX_GECKO_POOLS_ANALYZED = 20;
const MAX_JUPITER_PRICE_CHECKS = 20;
/*
 Jupiter fallback is deliberately limited.
 If the batch endpoint returns HTTP 200 but no usable prices,
 we perform a small number of individual requests. This gives
 us a real diagnostic signal without turning every scan into
 a large number of API calls.
*/
const MAX_JUPITER_FALLBACK_CHECKS = 2;
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
}function safeNumber(value, fallback = 0) {
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
 return error instanceof Error ? error.message
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
 }}
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
 mode: "LIVE",
 starting_cash_usd:
 STARTING_CASH_USD,
 cash_usd: STARTING_CASH_USD,
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
 "LIVE_BETA_PORTFOLIO"
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
 || portfolio.mode !== "LIVE"
 ){
 return createEmptyPortfolio(); }
 portfolio.positions ||= [];
 portfolio.history ||= [];
 portfolio.cooldowns ||= {};
 portfolio.market_memory ||= {};
 portfolio.mode = "LIVE";
 portfolio.cash_usd = clamp(
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
){
 const force =
 options.force === true;
 if (
 !force &&
 !canPersistNow(portfolio)
 ){
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
 ).toISOString();payload.last_persist_at =
 persistedAt;
payload.last_persist_reason =
 reason;
await env.BOT_KV.put(
 "LIVE_BETA_PORTFOLIO",
 JSON.stringify(payload)
);
portfolio.updated_at = payload.updated_at;
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
){
 portfolio.history.push({
 time: nowIso(),
 ...event
 });
 if (
 portfolio.history.length >
 500
 ){
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
 ){
 if (
 equity >= tier.equity
 ){
 amount =
 tier.amount;
 }
 }
 return Math.min(
 amount,
 MAX_PAPER_POSITION_USD );
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
}function discoveryItemSample(item) {
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
 name: item?.name ||
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
){
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
){ diagnostic.error =
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
){
 const chainId =
 String(
 item?.chainId ||
 ""
 ).toLowerCase();
 if (
 chainId !==
 "solana"
 ){
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
 ), diagnostics
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
){
 diagnostics.attempted++;
 const queryDiagnostic = {
 attempted: true,
 http_status: null,
 response_shape: null,
 total_pairs: 0,
 solana_pairs: 0,
 extracted_mints: 0, error: null,
 sample: []
 };
 diagnostics.queries[
 query
 ]=
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
 null, base_symbol:
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
){
 if (
 String(
 pair?.chainId ||
 ""
 ).toLowerCase() !==
 "solana"
 ){
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
 source: "DEXSCREENER_SEARCH"
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
 ){
 return String(
 directAddress
 );
 }
 return null;
}
function geckoPoolSample(item) {
 return { id:
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
 ){
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
 result.data?.data )
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
){
 const mint =
 extractGeckoMint(
 item
 );
 if (!mint) { continue;
 }
 diagnostic.tokens_extracted++;
 mints.add(
 mint
 );
 }
 }
 await readGeckoEndpoint(
 "gecko_trending",
 `${GECKO_BASE}/networks/solana/trending_pools?page=1`
 );
 if (
 mints.size === 0
 ){
 await readGeckoEndpoint(
 "gecko_top_pools",
 `${GECKO_BASE}/networks/solana/pools?page=1&include=base_token`
 );
 }
 if (
 mints.size === 0
 ){
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
){
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
const normalizedLiquidity = safeNumber(
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
){
 const pairsByMint =
 new Map();
 const diagnostics = {
 attempted:
 mints.length,
 http_status:
 null,
 response_shape:
 null,
 requested_mints: mints.length,
 returned_pairs:
 0,
 solana_pairs:
 0,
 error:
 null
};
if (!mints.length) {
 return {
 pairsByMint, diagnostics
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
){
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
){
 if (
 String(
 pair?.chainId ||
 ""
 ).toLowerCase() !==
 "solana"
 ){
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
 ){
 pairsByMint.set(
 mint,
 [] );
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
){
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
){
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
 )-
 safeNumber(
 a?.liquidity?.usd, 0
 );
 if (
 liquidityDifference !== 0
 ){
 return liquidityDifference;
 }
 return ( safeNumber(
 b?.volume?.h24,
 0
 )-
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
 )>0
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
){
 liquiditySource =
 "DEXSCREENER_LIQUIDITY_FIELD_MISSING";
} else if (
 selectedLiquidity <= 0
){
 liquiditySource =
 "DEXSCREENER_LIQUIDITY_USD_ZERO";
}
let selectionReason =
 "HIGHEST_LIQUIDITY";
if (
 selectedLiquidity <= 0 &&
 positiveLiquidityCount === 0 &&
 solanaPairs.length > 1
){
 selectionReason =
 "ALL_SOLANA_PAIRS_ZERO_OR_MISSING_LIQUIDITY";
} else if (
 selectedLiquidity <= 0 && positiveLiquidityCount > 0
){
 selectionReason =
 "SELECTED_ZERO_LIQUIDITY_DESPITE_POSITIVE_ALTERNATIVE";
} else if (
 selectedLiquidity > 0 &&
 selectedIndex > 0
){
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
selected_pair_address: selectedPair?.pairAddress ||
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
 null, selected_volume_1h_raw:
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
){
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
 sells5m > 0 ? buys5m / sells5m
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
 )/ 86400000;
}
const priceChange =
 pair.priceChange || {};
let liquiditySource =
 "DEXSCREENER_LIQUIDITY_USD";
if (
 !liquidityFieldPresent
){
 liquiditySource =
 "DEXSCREENER_LIQUIDITY_FIELD_MISSING";
} else if (
 liquidity <= 0
){
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
 volume24h,volume_1h_usd:
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
 JUPITER PRICE VALUE EXTRACTION
 ============================================================ */
/*
 Jupiter Price API responses have changed shape over time.
 Keep parsing intentionally defensive.
 Supported price fields: - usdPrice
 - priceUsd
 - price
 - usd_price
 The value must resolve to a finite positive number.
*/
function extractJupiterPriceValue(
 item
){
 if (
 item === null ||
 item === undefined
 ){
 return {
 price: null, field: null
 };
}
if (
 typeof item === "number"
){
 return Number.isFinite(item) &&
 item > 0
 ?{
 price: item,
 field: "DIRECT_NUMBER"
 }
 :{
 price: null,
 field: "DIRECT_NUMBER"
 };
}
if (
 typeof item === "string"
){
 const parsed =
 Number(item);
 return Number.isFinite(parsed) &&
 parsed > 0
 ?{
 price: parsed,
 field: "DIRECT_STRING"
 }
 :{
 price: null,
 field: "DIRECT_STRING"
 };
}
if (
 typeof item !== "object"
){
 return {
 price: null,
 field: null
 };
}
const fields = [
 "usdPrice",
 "priceUsd",
 "price",
 "usd_price"
];
for (
 const field of
 fields
){
 if ( Object.prototype.hasOwnProperty.call(
 item,
 field
 )
 ){
 const parsed =
 Number(
 item[field]
 );
 if (
 Number.isFinite(
 parsed
 ) &&
 parsed > 0
 ){
 return {
 price: parsed,
 field
 };
 }
 }
}
/*
 Defensive support for an additional nested price object.
*/
if (
 item.price &&
 typeof item.price ===
 "object"
 ){
 const nested =
 extractJupiterPriceValue(
 item.price
 );
 if (
 nested.price !== null
 ){
 return {
 price:
 nested.price,
 field:
 `price.${nested.field}`
 };
 }
 }
 return {
 price: null,
 field: null
 };
}
/* ============================================================
 JUPITER MINT KEY LOOKUP
 ============================================================ */
function findJupiterResponseItem(
 priceData,
 mint
){
 if (
 !priceData ||
 typeof priceData !==
 "object"
 ){
 return {
 item: null,
 matchedKey: null
 };
}
/*
 Exact match first.
*/
if (
 Object.prototype.hasOwnProperty.call(
 priceData,
 mint
 )){
 return {
 item:
 priceData[mint],
 matchedKey:
 mint
 };
}
/*
 Defensive case-insensitive lookup.
 Solana base58 addresses are normally case-sensitive,
 but this diagnostic layer should still tell us if an
 upstream response altered key casing.
*/const lowerMint =
 String(mint)
 .toLowerCase();
for (
 const key of
 Object.keys(priceData)
){
 if (
 String(key)
 .toLowerCase() ===
 lowerMint
 ){
 return {
 item:
 priceData[key],
 matchedKey:
 key
 };
 }
 }
 return {
 item: null,
 matchedKey: null
 };
}
/* ============================================================
 JUPITER RESPONSE MAP EXTRACTION
 ============================================================ */
function extractJupiterPriceMap(
 data
){
 const diagnostics = {
 response_shape:
 responseShape(data),
 selected_shape:
 null,
 root_keys:
 [],
 root_key_count:
 0,
 root_key_sample:
 [],
 candidate_maps:
 []
 };
 if (
 !data ||
 typeof data !== "object" ||
 Array.isArray(data)
 ){
 return {
 priceData: null,
 diagnostics
 };
}
const rootKeys =
 Object.keys(data);
diagnostics.root_keys =
 rootKeys;
diagnostics.root_key_count =
 rootKeys.length;
diagnostics.root_key_sample = rootKeys.slice(0, 10);
/*
 Candidate 1:
 Root-level mint map.
 Example:
 {
 "MintAddress": {
 "usdPrice": "0.123"
 }
 }
*/
const rootRecordKeys =
 rootKeys.filter(
 key => {
 const item =
 data[key];
 return (
 item &&
 typeof item ===
 "object" &&
 !Array.isArray(item)
 );
 }
 );
if (
 rootRecordKeys.length > 0
){
 const rootHasRecognizedPrice =
 rootRecordKeys.some(
 key =>
 extractJupiterPriceValue(
 data[key]
 ).price !== null
 );
 if (
 rootHasRecognizedPrice
 ){
 diagnostics.candidate_maps.push(
 "ROOT_LEVEL_MINT_MAP"
 );
 return {
 priceData:
 data,
 diagnostics: {
 ...diagnostics,
 selected_shape:
 "ROOT_LEVEL_MINT_MAP"
 }
 };
 }
}
/* Candidate 2:
 Nested data map.
*/
if (
 data.data &&
 typeof data.data ===
 "object" &&
 !Array.isArray(
 data.data
 )
){
 const nestedKeys =
 Object.keys(
 data.data
 );
 const nestedHasRecognizedPrice =
 nestedKeys.some(
 key =>
 extractJupiterPriceValue(
 data.data[key]
 ).price !== null
 );
 if (
 nestedHasRecognizedPrice
 ){
 diagnostics.candidate_maps.push(
 "NESTED_DATA_MINT_MAP"
 );
 return {
 priceData:
 data.data,
 diagnostics: {
 ...diagnostics,
 selected_shape:
 "NESTED_DATA_MINT_MAP" }
 };
 }
}
/*
 Candidate 3:
 Some API wrappers return a `prices` object.
*/
if (
 data.prices &&
 typeof data.prices ===
 "object" &&
 !Array.isArray(
 data.prices
 )
){
 const priceKeys =
 Object.keys(
 data.prices
 );
 const hasRecognizedPrice =
 priceKeys.some(
 key =>
 extractJupiterPriceValue(
 data.prices[key]
 ).price !== null
 );
 if (
 hasRecognizedPrice
 ){
 diagnostics.candidate_maps.push(
 "NESTED_PRICES_MINT_MAP"
 );
 return {
 priceData:
 data.prices,
 diagnostics: {
 ...diagnostics,
 selected_shape:
 "NESTED_PRICES_MINT_MAP"
 }
 };
 }
}
/*
 Candidate 4:
 A direct single-token record.
 This is mostly useful for fallback diagnostics.
*/
const directPrice =
 extractJupiterPriceValue(
 data
 );
 if (
 directPrice.price !== null
 ){
 diagnostics.candidate_maps.push(
 "DIRECT_PRICE_RECORD"
 );
 return {
 priceData:
 {
 __DIRECT__:
 data
 },
 diagnostics: { ...diagnostics,
 selected_shape:
 "DIRECT_PRICE_RECORD"
 }
 };
 }
 return {
 priceData: null,
 diagnostics: {
 ...diagnostics,
 selected_shape:
 "NO_RECOGNIZED_PRICE_MAP"
 }
 };
}
/* ============================================================
 JUPITER SINGLE PRICE REQUEST
 ============================================================ */
async function getJupiterSinglePrice(
 mint,
 env
){
 const diagnostics = {
 mint,
 attempted:
 true,
 http_status: null,
 response_shape:
 null,
 response_key_count:
 0,
 response_key_sample:
 [],
 matched_key:
 null,
 selected_shape:
 null,
 price_field:
 null,
 price:
 null,
 error:
 null
 };
 const prices =
 new Map();
 const url =
 `${JUPITER_PRICE_API}?ids=${encodeURIComponent(
 mint
 )}`;
 try {
const headers = {};
if (
 env.JUPITER_API_KEY
){
 headers["x-api-key"] =
 env.JUPITER_API_KEY;
}
const result =
 await fetchJsonDiagnostic(
 url,
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
}diagnostics.response_shape =
 responseShape(
 result.data
 );
if (
 result.data &&
 typeof result.data ===
 "object" &&
 !Array.isArray(
 result.data
 )
){
 const rootKeys =
 Object.keys(
 result.data
 );
 diagnostics.response_key_count =
 rootKeys.length;
 diagnostics.response_key_sample =
 rootKeys.slice(0, 10);
}
const extracted =
 extractJupiterPriceMap(
 result.data
 );
diagnostics.selected_shape =
 extracted.diagnostics
 .selected_shape;
if (
 extracted.priceData
){
 if (
 extracted.diagnostics
 .selected_shape ===
 "DIRECT_PRICE_RECORD"
 ){
 const direct =
 extractJupiterPriceValue(
 result.data
 );
 if (
 direct.price !== null
 ){
 prices.set(
 mint,
 direct.price
 );
 diagnostics.matched_key =
 "__DIRECT__";
 diagnostics.price_field =
 direct.field;
 diagnostics.price =
 direct.price;
 return {
 prices,
 diagnostics
 };
 }
} else {
 const match =
 findJupiterResponseItem(
 extracted.priceData,
 mint
 ); diagnostics.matched_key =
 match.matchedKey;
 if (
 match.item
 ){
 const parsed =
 extractJupiterPriceValue(
 match.item
 );
 if (
 parsed.price !== null
 ){
 prices.set(
 mint,
 parsed.price );
 diagnostics.price_field =
 parsed.field;
 diagnostics.price =
 parsed.price;
 return {
 prices,
 diagnostics
 };
 }
 diagnostics.error =
 "JUPITER_SINGLE_TOKEN_MATCHED_BUT_PRICE_FIELD_INVALID";
 } else {
 diagnostics.error =
 "JUPITER_SINGLE_TOKEN_RESPONSE_MISSING_REQUESTED_MINT";
 }
 }
 }
 if (
 !diagnostics.error
 ){
 diagnostics.error =
 "JUPITER_SINGLE_TOKEN_NO_USABLE_PRICE";
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
 JUPITER SUPPLEMENTAL PRICE CHECK
 ============================================================ */
async function getJupiterPrices(
 mints,
 env
){
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
selected_response_shape:
 null,
response_key_count:
 0,
response_key_sample:
 [],
root_level_response:
 false,
nested_data_response: false,
fallback_attempted:
 false,
fallback_checked:
 0,
fallback_priced:
 0,
fallback_samples:
 [],
 fallback_errors:
 [],
 fallback_misses:
 [],
 price_fields_seen:
 []
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
/*
 Construct the URL explicitly.
 The previous implementation encoded the entire comma-separated
 string before adding it to the URL. URLSearchParams is used here
 so the query is formed consistently.
*/
const query =
 new URLSearchParams();
query.set(
 "ids",
 batch.join(",")
);
diagnostics.request_url =
 `${JUPITER_PRICE_API}?${query.toString()}`;
try {
 const headers = {};
 if (
 env.JUPITER_API_KEY
 ){
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
 diagnostics.http_status = result.status;
 if (!result.ok) {
 diagnostics.error = result.error;
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
 ){
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
const extracted =
 extractJupiterPriceMap(
 data
 );
diagnostics.selected_response_shape =
 extracted.diagnostics
 .selected_shape;
diagnostics.response_shape =
 extracted.diagnostics
 .response_shape;
if (
 extracted.diagnostics
 .selected_shape ===
 "ROOT_LEVEL_MINT_MAP"
){
 diagnostics.root_level_response =
 true;
}
if (
 extracted.diagnostics
 .selected_shape ===
 "NESTED_DATA_MINT_MAP"
){
 diagnostics.nested_data_response =
 true;
}
/*
 Parse the discovered mint map.
*/
if (
 extracted.priceData
){
 for (
 const mint of batch
 ){
 const match =
 findJupiterResponseItem(
 extracted.priceData,
 mint
 );
if (
!match.item
){
diagnostics.missing_prices.push(
mint
);
continue;
}
const parsed =
extractJupiterPriceValue(
match.item );
if (
parsed.price === null
){
diagnostics.invalid_prices.push(
mint
);
continue;
}
prices.set(
mint,
parsed.price
);
diagnostics.returned++;
diagnostics.priced++;
if (
parsed.field &&
!diagnostics.price_fields_seen.includes(
parsed.field
)
){
diagnostics.price_fields_seen.push(
parsed.field
);
}
if (
diagnostics.price_samples.length < 10
){
diagnostics.price_samples.push({
mint,
matched_key:
match.matchedKey,
usd_price:
parsed.price,
 price_field:
 parsed.field
 });
 }
 }
} else {
 /*
 The API returned 200 JSON but we couldn't identify
 any recognized price map.
 */
 diagnostics.error =
 "JUPITER_RETURNED_200_BUT_NO_RECOGNIZED_PRICE_MAP";
diagnostics.missing_prices =
 batch.slice();}
/*
 FALLBACK
 If the batch endpoint returned HTTP 200 but yielded zero
 usable prices, query a small number individually.
 This is intentionally limited. The goal is to establish
 whether the batch response shape is the problem, whether
 particular mints are unsupported, or whether Jupiter is
 returning no prices for the tokens.
*/
if (
 prices.size === 0 &&
 batch.length > 0
){
 diagnostics.fallback_attempted =
 true; const fallbackBatch =
 batch.slice(
 0,
 MAX_JUPITER_FALLBACK_CHECKS
 );
 for (
 const mint of
 fallbackBatch
 ){
 const fallback =
 await getJupiterSinglePrice(
 mint,
 env
 );
 diagnostics.fallback_checked++;
 const fallbackPrice =
 fallback.prices.get(
 mint
 );
if (
 fallbackPrice
){
 prices.set(
 mint,
 fallbackPrice
 );
 diagnostics.fallback_priced++;
 if (
 diagnostics.fallback_samples.length <
 10
 ){
 diagnostics.fallback_samples.push({
 mint,
 price:
 fallbackPrice,
 price_field:
 fallback.diagnostics
 .price_field,
 matched_key:
 fallback.diagnostics
 .matched_key,
 selected_shape:
 fallback.diagnostics
 .selected_shape,
 http_status:
 fallback.diagnostics
 .http_status
 });
 }
 if (
 !diagnostics.price_fields_seen.includes(
 fallback.diagnostics
 .price_field
 )
 ){
 diagnostics.price_fields_seen.push(
 fallback.diagnostics
 .price_field
 );
 }
} else {
 diagnostics.fallback_misses.push(
 {
 mint,
 http_status:
 fallback.diagnostics
 .http_status,
 response_shape:
 fallback.diagnostics
 .response_shape,
 selected_shape:
 fallback.diagnostics
 .selected_shape,
 matched_key:
 fallback.diagnostics
 .matched_key,
 error:
 fallback.diagnostics
 .error
 }
 );
 if (
 fallback.diagnostics.error ){
 diagnostics.fallback_errors.push({
 mint,
 error:
 fallback.diagnostics
 .error
 });
 }
}
 }
 /*
 Recalculate the aggregate counts after fallback.
 */
 diagnostics.returned =
 prices.size;
 diagnostics.priced =
 prices.size;
 /*
 Any fallback-resolved mint is no longer truly missing.
 */
 diagnostics.missing_prices =
 diagnostics.missing_prices.filter(
 mint =>
 !prices.has(mint)
 );
 diagnostics.invalid_prices =
 diagnostics.invalid_prices.filter(
 mint =>
 !prices.has(mint) );
 if (
 prices.size > 0
 ){
 diagnostics.error =
 null;
 }
}
 if (
 diagnostics.returned === 0
 ){
 diagnostics.error ||=
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
){
 if (
 !jupiterPrice
 ){
 return {
 confirmed: false,
 difference: null,
 status:
 "NO_JUPITER_PRICE" };
 }
 if (
 !candidate.price ||
 candidate.price <= 0
 ){
 return {
 confirmed: false,
 difference: null,
 status:
 "NO_DEX_PRICE"
 };
 }
 const difference =
 Math.abs(
 jupiterPrice -
 candidate.price
 )/
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
){
 const reasons = [];
 let penalty = 0;
 if (
 candidate.change_1h >=
 EXTREME_1H_MOVE
 ){
 penalty += 10;
 reasons.push(
 "EXTREME_1H_MOVE"
 );
 }
 if (
 candidate.change_6h >=
 1.00
 ){
 penalty += 8;
 reasons.push(
 "EXTREME_6H_MOVE"
 );
}
if (
 candidate.change_5m >=
 0.15
){
 penalty += 8;
 reasons.push(
 "EXTREME_5M_MOVE"
 );
}
if (
 candidate.change_6h <=
 STRONG_NEGATIVE_6H
){
 penalty += 10;
 reasons.push(
 "STRONG_NEGATIVE_6H"
 );
}
if (
 candidate.change_5m <=
 STRONG_NEGATIVE_5M
){
 penalty += 8;
 reasons.push(
 "STRONG_NEGATIVE_5M"
 );
}if (
 candidate.change_5m >=
 BOUNCE_5M &&
 candidate.change_1h < 0
){
 penalty -= 4;
 reasons.push( "BOUNCE_ATTEMPT"
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
){
 let score = 0;
 const breakdown = {};
 let momentum = 0;
 if (
 candidate.change_5m > 0
 ){
 momentum += 5;
 }
 if (
 candidate.change_1h > 0
 ){
 momentum += 5;
 }
 if (
 candidate.change_6h > 0
){
 momentum += 5;
}
if (
 candidate.change_24h > 0
){
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
){ volume += 5;
}
if (
 candidate.volume_24h_usd >=
 25000
){
 volume += 4;
}
if (
 candidate.volume_24h_usd >=
 100000
){
 volume += 4;
}
if (
 candidate.volume_1h_usd >=
 1000
){
 volume += 2;
}
if (
 candidate.volume_1h_usd >=
 5000
){
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
){
 liquidity += 5;
}
if (
 candidate.liquidity_usd >=
 25000
){
 liquidity += 4;
}
if (
 candidate.liquidity_usd >=
 50000
){
 liquidity += 3;
}
if (
 candidate.liquidity_usd >=
 100000
){
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
){
 buyPressure += 5;}
if (
 candidate.buy_pressure_5m >=
 0.60
){
 buyPressure += 3;
}
if (
 candidate.buy_pressure_1h >=
 0.50){
 buyPressure += 4;
}
if (
 candidate.buy_pressure_1h >=
 0.60
){
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
){
 acceleration += 3;
}
if (
 candidate.change_1h >
 candidate.change_6h
){
 acceleration += 2;
}
if (
 candidate.change_5m >= 0.02 &&
 candidate.change_5m <= 0.10
){
 acceleration += 2;
}
if (
 candidate.change_1h >= 0.03 &&
 candidate.change_1h <= 0.30
){
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
){
 crossSource += 5;
}
if (
 candidate.gecko_confirmed
){
 crossSource += 3;
}
if (
 candidate.jupiter_confirmed){
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
){
 const reasons = [];
 if ( candidate.liquidity_usd <
 MIN_LIQUIDITY_USD
 ){
 reasons.push(
 "LOW_LIQUIDITY"
 );
 }
 if (
 candidate.volume_1h_usd <
 MIN_VOLUME_1H_USD
 ){
 reasons.push(
 "LOW_1H_VOLUME"
 );
 }
 if (
 candidate.momentum_score <
 MIN_MOMENTUM_SCORE
 ){
 reasons.push(
 "WEAK_MOMENTUM"
 );
 }
 if (
 candidate.change_5m <=
 STRONG_NEGATIVE_5M
 ){
 reasons.push(
 "SEVERE_5M_DECLINE"
 ); }
 if (
 candidate.change_5m >
 MAX_5M_GAIN
){
 reasons.push(
 "CHASE_PROTECTION_5M"
 );
}
if (
 candidate.change_1h >
 MAX_1H_GAIN
){
 reasons.push(
 "CHASE_PROTECTION_1H"
 );
}
if (
 candidate.change_6h >
 MAX_6H_GAIN
){
 reasons.push(
 "CHASE_PROTECTION_6H"
 );
}
if (
 candidate.change_24h >
 MAX_24H_GAIN
){
 reasons.push(
 "CHASE_PROTECTION_24H"
 );
}
if (
 candidate.age_days !== null &&
 candidate.age_days <=
 NEW_TOKEN_MAX_AGE_DAYS
){
 if (
 candidate.change_1h >=
 0.25
 ){
 reasons.push(
 "NEW_TOKEN_PARABOLIC_MOVE"
 );
 }
 }
 if (
 candidate.score <
 MIN_ENTRY_SCORE
 ){
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
 candidate){
 const reasons = [];
 if (
 !Number.isFinite(
 candidate.price
 ) ||
 candidate.price <
 MIN_TOKEN_PRICE
 ){
 reasons.push(
 "INVALID_PRICE"
 );
 }
 if (
 candidate.liquidity_usd <
 MIN_LIQUIDITY_USD
){
 reasons.push(
 "LOW_LIQUIDITY"
 );
}
if (
 candidate.volume_24h_usd <
 MIN_VOLUME_24H_USD
){
 reasons.push(
 "LOW_24H_VOLUME"
 );
}
if (
 candidate.volume_1h_usd <
 MIN_VOLUME_1H_USD){
 reasons.push(
 "LOW_1H_VOLUME"
 );
}
if (
 candidate.change_5m <=
 STRONG_NEGATIVE_5M
){
 reasons.push(
 "SEVERE_5M_DECLINE"
 );
}
if (
 candidate.change_6h <=
 STRONG_NEGATIVE_6H
){
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
 ){
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
){
 const sourceCounts = {
 dexscreener_discovery: 0,
 dexscreener_search: 0,
 dexscreener_top_boosts: 0,
 gecko_trending: 0,
 gecko_confirmed_tokens: 0,
 jupiter_price_checked: 0,
 jupiter_price_confirmed: 0,
 hydrated_pairs: 0,
 gecko_tokens_received: 0, gecko_tokens_with_address: 0,
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
 "DEXSCREENER_TOP_BOOSTS" ).length;
const dexSearchResult =
 await getDexSearch();
discoveryDiagnostics.dexscreener_search =
 dexSearchResult.diagnostics;
const dexSearch =
 dexSearchResult.results;
sourceCounts.dexscreener_search =
 dexSearch.length;
const geckoMints = [];
discoveryDiagnostics.gecko_trending = {
 ...discoveryDiagnostics.gecko_trending,
 attempted: false,
 error: "SKIPPED_TO_PROTECT_SUBREQUEST_BUDGET"
};
discoveryDiagnostics.gecko_top_pools = { ...discoveryDiagnostics.gecko_top_pools,
 attempted: false,
 error: "SKIPPED_TO_PROTECT_SUBREQUEST_BUDGET"
};
discoveryDiagnostics.gecko_new_pools = {
 ...discoveryDiagnostics.gecko_new_pools,
 attempted: false,
 error: "SKIPPED_TO_PROTECT_SUBREQUEST_BUDGET"
};
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
){
 if (!item.mint) {
 continue;
 }
 if (
 seen.has(
 item.mint
 )
 ){
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
 ){
 break;
 }
}
/* ==========================================================
 BATCH HYDRATION
 ========================================================== */
const hydrationMints =
 limited.map( item =>
 item.mint
 );
const batchResults = [];
for (
 let offset = 0;
 offset < hydrationMints.length;
 offset += 30
){
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
){
 for (
 const [
 mint,
 pairs
 ] of
 batchResult.pairsByMint
 ){
 pairsByMint.set(
 mint,
 pairs );
 }
}
const candidates = [];
for (
 const item of
 limited
){
 const isGecko =
 item.source === "GECKOTERMINAL";
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
){
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
 )<
 MIN_LIQUIDITY_USD
){
 sourceCounts.dex_below_min_liquidity_pairs++;
}
const liquiditySource =
 pairDiagnostic.selected_liquidity_source ||
 "UNKNOWN";
hydrationDiagnostics.selected_liquidity_sources[
 liquiditySource
]=
 (
 hydrationDiagnostics.selected_liquidity_sources[
 liquiditySource
 ] || 0
 ) + 1;
if (
 hydrationDiagnostics.selected_pair_samples.length <
 10
){
 hydrationDiagnostics.selected_pair_samples.push({
 mint:
 item.mint,
 symbol:
 pairDiagnostic.selected_base_symbol,
 pair_address: pairDiagnostic.selected_pair_address,
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
){
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
 pairDiagnostic.positive_liquidity_pairs, selection_reason: pairDiagnostic.selection_reason,
 top_pairs:
 pairDiagnostic.top_pairs
 });
}
if (
 pairDiagnostic.selected_liquidity_source ===
 "DEXSCREENER_LIQUIDITY_FIELD_MISSING" &&
 hydrationDiagnostics.missing_liquidity_samples.length <
 10
 ){
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
 ]=
 (
 hydrationDiagnostics.failure_reasons[
 reason
 ] || 0
 ) + 1;
 if (
 hydrationDiagnostics.samples.length <
 10
 ){
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
 ]=
 (
 hydrationDiagnostics.failure_reasons[
 "NORMALIZATION_FAILED"
 ] || 0
 ) + 1;
 continue;
}
 candidate.sources = unique([
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
 JUPITER PRICE CHECK ========================================================== */
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
 );const jupiterPrices =
 jupiterResult.prices;
const jupiterDiagnostics =
 jupiterResult.diagnostics;
for (
 const candidate of
 candidates
){
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
 ){
 jupiterDiagnostics.mismatched_prices++;
 if (
 jupiterDiagnostics.mismatch_samples.length <
 10
 ){
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
/*
 If we have a Jupiter price but no Dex price, expose this
 explicitly instead of silently calling it a mismatch.
*/
jupiterDiagnostics.no_dex_price_candidates =
 candidates.filter(
 candidate =>
 candidate.jupiter_price &&
 (
 !candidate.price ||
 candidate.price <= 0
 )
 ).length;
/* ==========================================================
 SCORE CANDIDATES
 ========================================================== */
for (
 const candidate of
 candidates
){
 const scoring =
 scoreCandidate( candidate
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
} candidates.sort(
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
){
 return {
 time:
 Date.now(),
 price:
 safeNumber( candidate.price
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
){
 let priority = 0;
 if (
 candidate.risk_pass
 ){
 priority += 100;
 }
 if (
 candidate.entry_eligible
 ){
 priority += 40;
 }
 priority +=
 safeNumber(
 candidate.score
 );
 priority +=
 safeNumber(
 candidate.liquidity_usd
 )/
 50000;
 priority +=
 safeNumber(
 candidate.volume_1h_usd
 )/
 10000;
 return priority;
}
function shouldRememberCandidate(
 candidate
){
 if (
 !candidate.mint
 ){
 return false;
 }
 if (
 !Number.isFinite(
 candidate.price
 ) ||
 candidate.price <= 0
 ){
 return false;
 }
 if ( candidate.risk_pass ||
 candidate.score >= 35 ||
 candidate.liquidity_usd >=
 MIN_LIQUIDITY_USD
 ){
 return true;
 }
 return false;
}
function cleanupMarketMemory(
 portfolio
){
 if (
 !portfolio.market_memory ||
 typeof portfolio.market_memory !==
 "object"
 ){ portfolio.market_memory = {};
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
){
if (
!mint ||
!memory ||
!Array.isArray(
memory.observations
)
){
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
)>0
)
.slice(
-MAX_MEMORY_OBSERVATIONS
);
if (
!observations.length
){
continue;
}
cleaned[mint] = {
symbol:
memory.symbol ||
"UNKNOWN",
name:
memory.name ||
"UNKNOWN",
priority: safeNumber(
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
){
 return (
 portfolio.market_memory?.[
 mint
 ] || null
 );
}
function evaluateHistoricalSetup(
 candidate,
 memory
){
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
){
 return result;
}
const observations =
 memory.observations;
result.observations =
 observations.length;
if (
 observations.length <
 MIN_HISTORY_OBSERVATIONS
){
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
 previous.change_5m );
const delta1h = current.change_1h -
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
){
 score += 3;
 result.signals.push(
 "IMPROVING_5M_MOMENTUM"
 );
}
if (
 delta5m >= 0.03
){
 score += 2;
 result.signals.push(
 "STRONG_5M_ACCELERATION"
 );
}
if (
 delta1h >= 0.01
){
 score += 2;
 result.signals.push( "1H_RECOVERY"
 );
}
if (
 deltaBuy5m >= 0.05
){
 score += 2;
 result.signals.push(
 "IMPROVING_5M_BUY_PRESSURE"
 );
}
if (
 deltaBuy1h >= 0.03
){
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
){
 score += 2;
 result.signals.push(
 "RISING_1H_VOLUME"
 );
}
if (
 current.liquidity > 0 &&
 previous.liquidity > 0
){
 const liquidityRatio =
 current.liquidity /
 previous.liquidity;
 if (
 liquidityRatio >= 0.95
 ){
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
 hasTrendRecovery || hasPressureImprovement
 );
result.setup_score =
 clamp(
 score,
 0,
 MAX_HISTORICAL_SETUP_BONUS
 );
if (
 result.confirmed
 ){
 result.setup_bonus =
 Math.min(
 result.setup_score,
 MAX_HISTORICAL_SETUP_BONUS
 );
 }
 return result;}
function updateMarketMemory(
 portfolio,
 candidates
){
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
 ){
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
 ]={
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
 last && Math.abs(
 safeNumber(
 last.price
 )-
 observation.price
 ) === 0 &&
 Date.now() -
 safeNumber(
 last.time
 )<
 30000
 ){
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
 )-
 safeNumber(
 a[1]?.priority
 )
 );
 const trimmed = {};
 for (
 const [mint, memory] of entries.slice(
 0,
 MAX_MEMORY_CANDIDATES
 )
 ){
 trimmed[mint] =
 memory;
 }
 portfolio.market_memory =
 trimmed;
}
function applyHistoricalSetup(
 portfolio,
 candidates
){
 for (
 const candidate of
 candidates
 ){
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
candidate.setup_signals = setup.signals;
candidate.setup_deltas =
 setup.deltas;
if (
 setup.confirmed &&
 setup.setup_bonus > 0
){
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
){
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
){
 const counts = {};
 for (
 const candidate of
 candidates
 ){
 for (
 const reason of
 candidate[field] || []
 ){
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
 b[1] - a[1]
 )
 );
}
function buildRejectionDiagnostics(
 candidates
){
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
 return { risk_rejections:
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
){
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
){
 portfolio.cooldowns[mint] =
 Date.now();
}
/* ============================================================
 LIVE BETA SAFETY GATE
 ============================================================ */
function liveBetaExecutionStatus() {
 return {
 enabled: LIVE_BETA_MODE,
 transaction_execution: TRANSACTION_EXECUTION,
 confirmation_required: true,
 automatic_signing: TRANSACTION_EXECUTION,
 automatic_broadcast: TRANSACTION_EXECUTION,
 ledger_simulation: !TRANSACTION_EXECUTION,
 max_trade_usd: MAX_LIVE_TRADE_USD,
 max_live_bankroll_usd: MAX_LIVE_BANKROLL_USD,
 min_sol_reserve: LIVE_MIN_SOL_RESERVE,
 slippage_bps: LIVE_SLIPPAGE_BPS,
 required_secrets: [
 "SOLANA_RPC_URL",
 "WALLET_PRIVATE_KEY",
 "LIVE_EXECUTION_TOKEN"
 ]
 };
}
/* ============================================================
 LIVE SOLANA / JUPITER EXECUTION
 ============================================================ */
function requireLiveConfig(env) {
 if (!TRANSACTION_EXECUTION || PAPER_MODE) throw new Error("LIVE_TRANSACTION_EXECUTION_NOT_ENABLED");
 if (!env.SOLANA_RPC_URL) throw new Error("MISSING_SOLANA_RPC_URL");
 if (!env.WALLET_PRIVATE_KEY) throw new Error("MISSING_WALLET_PRIVATE_KEY");
}
function base58Decode(value) {
 const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
 const map = new Map([...alphabet].map((c, i) => [c, i]));
 const input = String(value).trim();
 if (!input) return new Uint8Array();
 let bytes = [0];
 for (const char of input) {
 const digit = map.get(char);
 if (digit === undefined) throw new Error("INVALID_BASE58_PRIVATE_KEY");
 let carry = digit;
 for (let i = 0; i < bytes.length; i++) {
 const x = bytes[i] * 58 + carry;
 bytes[i] = x & 255;
 carry = x >> 8;
 }
 while (carry > 0) { bytes.push(carry & 255); carry >>= 8; }
 }
 let leadingZeros = 0;
 for (const char of input) { if (char !== "1") break; leadingZeros++; }
 const payload = (bytes.length === 1 && bytes[0] === 0) ? [] : bytes;
 const out = new Uint8Array(leadingZeros + payload.length);
 for (let i = 0; i < payload.length; i++) out[leadingZeros + payload.length - 1 - i] = payload[i];
 return out;
}
function base58Encode(bytes) {
 const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
 const input = Uint8Array.from(bytes);
 if (!input.length) return "";
 let digits = [0];
 for (const byte of input) {
 let carry = byte;
 for (let i = 0; i < digits.length; i++) {
 const x = digits[i] * 256 + carry;
 digits[i] = x % 58;
 carry = Math.floor(x / 58);
 }
 while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
 }
 let zeros = 0;
 for (const byte of input) { if (byte !== 0) break; zeros++; }
 let out = "1".repeat(zeros);
 for (let i = digits.length - 1; i >= 0; i--) out += alphabet[digits[i]];
 return out;
}
function base64ToBytes(value) { const binary = atob(value);
 const out = new Uint8Array(binary.length);
 for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
 return out;
}
function bytesToBase64(bytes) {
 let out = "";
 const chunk = 0x8000;
 for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
 return btoa(out);
}
function parseWalletSecret(value) {
 const raw = String(value).trim();
 let bytes;
 if (raw.startsWith("[")) {
 let parsed;
 try { parsed = JSON.parse(raw); } catch { throw new Error("INVALID_WALLET_PRIVATE_KEY_JSON"); }
 if (!Array.isArray(parsed)) throw new Error("INVALID_WALLET_PRIVATE_KEY_JSON");
 bytes = Uint8Array.from(parsed);
 } else if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
 bytes = new Uint8Array(raw.length / 2);
 for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
 } else {
 bytes = base58Decode(raw);
 }
 if (bytes.length !== 64) throw new Error("WALLET_PRIVATE_KEY_MUST_BE_64_BYTES");
 return bytes;
}
function readCompactU16(bytes, offset) {
 let value = 0;
 let shift = 0;
 let cursor = offset;
 for (let i = 0; i < 3; i++) {
 if (cursor >= bytes.length) throw new Error("INVALID_SOLANA_TRANSACTION_LENGTH");
 const b = bytes[cursor++];
 value |= (b & 0x7f) << shift;
 if ((b & 0x80) === 0) return { value, offset: cursor };
 shift += 7;
 }
 throw new Error("INVALID_SOLANA_COMPACT_U16");
}
async function signSolanaTransaction(transactionBase64, env) {
 const secret = parseWalletSecret(env.WALLET_PRIVATE_KEY);
 const publicKey = secret.slice(32, 64);
 const tx = base64ToBytes(transactionBase64);
 const sigInfo = readCompactU16(tx, 0);
 if (sigInfo.value < 1) throw new Error("SOLANA_TRANSACTION_HAS_NO_SIGNER");
 if (sigInfo.value !== 1) throw new Error("UNSUPPORTED_MULTISIGNER_JUPITER_TRANSACTION");
 const messageOffset = sigInfo.offset + sigInfo.value * 64;
 if (messageOffset >= tx.length) throw new Error("INVALID_SOLANA_TRANSACTION_MESSAGE");
 const versioned = (tx[messageOffset] & 0x80) !== 0;
 const headerOffset = messageOffset + (versioned ? 1 : 0);
 if (headerOffset + 3 > tx.length) throw new Error("INVALID_SOLANA_MESSAGE_HEADER");
 if (tx[headerOffset] !== 1) throw new Error("UNSUPPORTED_SOLANA_REQUIRED_SIGNATURE_COUNT");
 const accountCount = readCompactU16(tx, headerOffset + 3);
 if (accountCount.offset + 32 > tx.length) throw new Error("INVALID_SOLANA_ACCOUNT_KEYS");
 const feePayer = tx.slice(accountCount.offset, accountCount.offset + 32);
 for (let i = 0; i < 32; i++) if (feePayer[i] !== publicKey[i]) throw new Error("JUPITER_TRANSACTION_FEEPAYER_DOES_NOT_MATCH_WALLET");
 const message = tx.slice(messageOffset);
 const pkcs8Prefix = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
 const pkcs8 = new Uint8Array(pkcs8Prefix.length + 32);
 pkcs8.set(pkcs8Prefix);
 pkcs8.set(secret.slice(0, 32), pkcs8Prefix.length);
 const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8.buffer, { name: "Ed25519" }, false, ["sign"]);
 const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, message));
 if (signature.length !== 64) throw new Error("INVALID_ED25519_SIGNATURE_LENGTH");
 const signed = tx.slice();
 signed.set(signature, sigInfo.offset);
 return { transactionBase64: bytesToBase64(signed), publicKey: base58Encode(publicKey) };
}
async function solanaRpc(env, method, params = []) {
 const response = await fetch(env.SOLANA_RPC_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Dat
e.now(), method, params }) });
 const data = await response.json();
 if (!response.ok || data.error) throw new Error(`SOLANA_RPC_${method}: ${data.error?.message || `HTTP ${response.status}`}`);
 return data.result;
}
async function getLiveWalletPublicKey(env) {
 const secret = parseWalletSecret(env.WALLET_PRIVATE_KEY);
 return base58Encode(secret.slice(32, 64));
}
async function getSolUsdPrice(env) {
 const single = await getJupiterSinglePrice(SOL_MINT, env);
 const price = single.prices.get(SOL_MINT);
 if (!price || price <= 0) throw new Error("LIVE_SOL_USD_PRICE_UNAVAILABLE");
 return price;
}
async function jupiterQuote(env, inputMint, outputMint, amount) {
 const url = new URL(`${LIVE_QUOTE_API}/quote`);
 url.searchParams.set("inputMint", inputMint);
 url.searchParams.set("outputMint", outputMint);
 url.searchParams.set("amount", String(Math.floor(amount)));
 url.searchParams.set("slippageBps", String(LIVE_SLIPPAGE_BPS));
 url.searchParams.set("swapMode", "ExactIn");
 const headers = { accept: "application/json" };
 if (env.JUPITER_API_KEY) headers["x-api-key"] = env.JUPITER_API_KEY;
 const result = await fetchJsonDiagnostic(url.toString(), { headers });
 if (!result.ok) throw new Error(`JUPITER_QUOTE_FAILED: ${result.error}`);
 if (!result.data?.outAmount || !result.data?.inAmount) throw new Error("JUPITER_QUOTE_MISSING_AMOUNTS");
 return result.data;
}
async function jupiterSwapTransaction(env, quoteResponse, userPublicKey) {
 const headers = { "content-type": "application/json", accept: "application/json" };
 if (env.JUPITER_API_KEY) headers["x-api-key"] = env.JUPITER_API_KEY;
 const result = await fetchJsonDiagnostic(`${LIVE_QUOTE_API}/swap`, { method: "POST", headers, body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitL
imit: true, prioritizationFeeLamports: "auto" }) });
 if (!result.ok) throw new Error(`JUPITER_SWAP_BUILD_FAILED: ${result.error}`);
 if (!result.data?.swapTransaction) throw new Error("JUPITER_SWAP_TRANSACTION_MISSING");
 return result.data.swapTransaction;
}
async function broadcastAndConfirmLiveTransaction(env, unsignedTransactionBase64) {
 const signed = await signSolanaTransaction(unsignedTransactionBase64, env);
 const signature = await solanaRpc(env, "sendTransaction", [signed.transactionBase64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2 }]);
 const started = Date.now();
 while (Date.now() - started < 45000) {
 const statuses = await solanaRpc(env, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]); const status = statuses?.value?.[0];
 if (status?.err) throw new Error(`LIVE_TRANSACTION_FAILED:${JSON.stringify(status.err)}`);
 if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return { signature, confirmation_status: status.confirmationStatus, slot: status.slot ?? null, 
wallet_public_key: signed.publicKey };
 await new Promise(resolve => setTimeout(resolve, 1500));
 }
 throw new Error(`LIVE_TRANSACTION_CONFIRMATION_TIMEOUT:${signature}`);
}
async function executeLiveSwap(env, inputMint, outputMint, inputAmount) {
 requireLiveConfig(env);
 const walletPublicKey = await getLiveWalletPublicKey(env);
 const quote = await jupiterQuote(env, inputMint, outputMint, inputAmount);
 const unsigned = await jupiterSwapTransaction(env, quote, walletPublicKey);
 const transaction = await broadcastAndConfirmLiveTransaction(env, unsigned);
 return { quote, transaction };
}
/* ============================================================
 LIVE BUY
 ============================================================ */
async function liveBuy(env, portfolio, candidate, amountUsd) {
 if (!LIVE_BETA_MODE || !TRANSACTION_EXECUTION || PAPER_MODE) throw new Error("LIVE_BUY_GATED");
 if (amountUsd <= 0 || amountUsd > MAX_LIVE_TRADE_USD) throw new Error("LIVE_BUY_AMOUNT_LIMIT");
 if (portfolio.starting_cash_usd > MAX_LIVE_BANKROLL_USD) throw new Error("LIVE_BANKROLL_LIMIT_EXCEEDED");
 if (portfolio.positions.length >= MAX_POSITIONS) return { ok: false, reason: "MAX_POSITIONS" };
 if (portfolio.positions.some(p => p.mint === candidate.mint)) return { ok: false, reason: "ALREADY_HOLDING" };
 const availableCash = portfolio.cash_usd - MIN_CASH_RESERVE_USD;
 if (availableCash < amountUsd) return { ok: false, reason: "INSUFFICIENT_CASH" };
 const solPrice = await getSolUsdPrice(env);
 const lamports = Math.floor((amountUsd / solPrice) * 1_000_000_000);
 if (lamports <= 0) return { ok: false, reason: "AMOUNT_TOO_SMALL" };
 const wallet = await getLiveWalletPublicKey(env);
 const balance = await solanaRpc(env, "getBalance", [wallet, { commitment: "confirmed" }]);
 const reserveLamports = Math.floor(LIVE_MIN_SOL_RESERVE * 1_000_000_000);
 if (safeNumber(balance?.value) < lamports + reserveLamports) return { ok: false, reason: "INSUFFICIENT_SOL_BALANCE" };
 const execution = await executeLiveSwap(env, SOL_MINT, candidate.mint, lamports);
 const actualInputUsd = safeNumber(execution.quote.inAmount) / 1_000_000_000 * solPrice;
 const quantityRaw = String(execution.quote.outAmount);
 const position = { id: `${candidate.mint}-${execution.transaction.signature}`, mint: candidate.mint, symbol: candidate.symbol, name: candidate.name, quantity: safeNumber(quantityRaw), quanti
ty_raw: quantityRaw, invested_usd: actualInputUsd, entry_price: candidate.price, current_price: candidate.price, peak_price: candidate.price, pnl_percent: 0, pnl_usd: 0, trailing_active: fals
e, reversal_confirmations: 0, entry_score: candidate.score, entry_momentum_score: candidate.momentum_score, entry_setup_score: candidate.setup_score, entry_setup_confirmed: candidate.setup_co
nfirmed, entry_history_observations: candidate.history_observations, entry_score_breakdown: candidate.score_breakdown, entry_sources: candidate.sources, entry_time: nowIso(), transaction_sign
ature: execution.transaction.signature };
 portfolio.cash_usd -= actualInputUsd;
 portfolio.positions.push(position);
 setCooldown(portfolio, candidate.mint);
 addHistory(portfolio, { type: "LIVE_BUY", mint: candidate.mint, symbol: candidate.symbol, price: candidate.price, amount_usd: actualInputUsd, quantity_raw: quantityRaw, score: candidate.scor
e, momentum_score: candidate.momentum_score, setup_score: candidate.setup_score, setup_confirmed: candidate.setup_confirmed, history_observations: candidate.history_observations, reason: "ENT
RY_ELIGIBLE_HISTORICAL_SETUP", transaction_signature: execution.transaction.signature });
 return { ok: true, position, transaction_signature: execution.transaction.signature, quoted_input_lamports: execution.quote.inAmount, quoted_output_raw: quantityRaw, sol_usd_price: solPrice 
};
}
/* ============================================================
 LIVE SELL
 ============================================================ */
async function liveSell(env, portfolio, position, candidate, reason) {
 if (!LIVE_BETA_MODE || !TRANSACTION_EXECUTION || PAPER_MODE) throw new Error("LIVE_SELL_GATED");
 const rawAmount = String(position.quantity_raw || Math.floor(position.quantity));
 if (!/^\d+$/.test(rawAmount) || rawAmount === "0") throw new Error("LIVE_POSITION_QUANTITY_INVALID");
 const solPrice = await getSolUsdPrice(env);
 const execution = await executeLiveSwap(env, candidate.mint, SOL_MINT, rawAmount);
 const proceedsSol = safeNumber(execution.quote.outAmount) / 1_000_000_000;
 const proceeds = proceedsSol * solPrice;
 const pnl = proceeds - position.invested_usd;
 const pnlPercent = position.invested_usd > 0 ? pnl / position.invested_usd : 0;
 portfolio.cash_usd += proceeds;
 portfolio.realized_pnl_usd += pnl;
 portfolio.positions = portfolio.positions.filter(p => p.id !== position.id);
 setCooldown(portfolio, position.mint);
 addHistory(portfolio, { type: "LIVE_SELL", mint: position.mint, symbol: position.symbol, price: candidate.price, proceeds_usd: proceeds, proceeds_sol: proceedsSol, pnl_usd: pnl, pnl_percent:
 pnlPercent, reason, transaction_signature: execution.transaction.signature });
 return { ok: true, mint: position.mint, symbol: position.symbol, price: candidate.price, proceeds_usd: proceeds, pnl_usd: pnl, pnl_percent: pnlPercent, reason, transaction_signature: executi
on.transaction.signature, quoted_input_raw: execution.quote.inAmount, quoted_output_lamports: execution.quote.outAmount, sol_usd_price: solPrice };
}
/* ============================================================
 PAPER BUY
 ============================================================ */
function paperBuy(
 portfolio,
 candidate,
 amountUsd
){
 if (!PAPER_MODE) {
 throw new Error(
 "LIVE TRADING IS DISABLED"
 );
 }
 if (
 portfolio.positions.length >=
 MAX_POSITIONS
 ){
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
 ){
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
 ){
 return {
 ok: false,
 reason:
 "ALREADY_HOLDING"
 };
}
const quantity = amountUsd /
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
 amountUsd, entry_price:
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
 position };
}
/* ============================================================
 PAPER SELL
 ============================================================ */
function paperSell(
 portfolio,
 position,
 price,
 reason
){
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
 portfolio, {
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
);return {
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
){
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
 ?(
 price -
 position.entry_price
 )/
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
){
 position.peak_price =
 price;
}
if (
 pnl <=
 STOP_LOSS
){
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
){
 position.trailing_active =
 true;
}
if (
 position.trailing_active &&
 position.peak_price > 0
){
 const drawdownFromPeak =
 ( price -
 position.peak_price
 )/
 position.peak_price;
 if (
 drawdownFromPeak <=
 -TRAILING_STOP
 ){
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
 1/
 HOURLY_SELL_RATIO;
const reversalSignal =
 shortTermSelling ||
 hourlySelling;
if (
 position.trailing_active &&
 pnl > 0 && reversalSignal
){
 position.reversal_confirmations =
 safeNumber(
 position.reversal_confirmations
 ) + 1;
} else if (
 !reversalSignal
){
 position.reversal_confirmations =
 0;
 }
 if (
 position.trailing_active &&
 pnl > 0 &&
 position.reversal_confirmations >=
 REVERSAL_CONFIRMATIONS_REQUIRED
 ){
 const sellThreshold =
 1/
 PROFIT_REVERSAL_SELL_RATIO;
 if (
 candidate.buy_pressure_1h <=
 sellThreshold
 ){
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
 position.trailing_active || beforeReversal !==
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
){
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
){
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
){
const candidate =
byMint.get(
position.mint
);
if (candidate) {
position.current_price =
candidate.price; const pnl =
position.entry_price > 0
?(
candidate.price -
position.entry_price)/
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
1+
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
 ), unrealized_pnl_usd:
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
){
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
 price: candidate.price,
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
setup_confirmed: candidate.setup_confirmed,
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
 ), 2
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
 }) )
 };
}
/* ============================================================
 RUN TRADING ENGINE
 ============================================================ */
async function runPaperEngine(
 env
){
 if (!PAPER_MODE && !TRANSACTION_EXECUTION) throw new Error("NO_EXECUTION_MODE_ENABLED");
 const portfolio =
 await loadPortfolio(env);
 const beforeRun =
 cloneObject(
 portfolio
 );
const buys = [];const sells = [];
const blockedSells = [];
const liveExecution = {
 attempted: 0,
 succeeded: 0,
 failed: 0,
 attempts: [],
 failures: []
 };
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
){
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
){
 importantStateChanged =
 true;
}
if (
 decision.sell
){
 if (
 !persistenceReady
 ){
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
 let result;
 try {
 if (!PAPER_MODE) liveExecution.attempted++;
 result = PAPER_MODE
 ? paperSell(portfolio, position, candidate.price, decision.reason)
 : await liveSell(env, portfolio, position, candidate, decision.reason);
 if (!PAPER_MODE) {
 liveExecution.succeeded++;
 liveExecution.attempts.push({
 side: "SELL",
 mint: position.mint,
 symbol: position.symbol,
 transaction_signature: result.transaction_signature || null,
 reason: decision.reason
 });
 }
 if (result.ok) {
 sells.push(result);
 }
 } catch (error) {
 if (!PAPER_MODE) {
 liveExecution.failed++;
 liveExecution.failures.push({
 side: "SELL",
 mint: position.mint,
 symbol: position.symbol,
 reason: decision.reason,
 error: errorText(error)
 });
 } else {
 throw error;
 }
 }
 }
}
let buysRemaining =
 MAX_NEW_BUYS_PER_RUN;
let tradeBlocked =
 !persistenceReady;
if ( persistenceReady &&
 portfolio.positions.length <
 MAX_POSITIONS
){
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
 )-
 safeNumber(
 a.setup_score
 );
 if (
 setupDifference !== 0
 ){
 return setupDifference;
 }
 return (
 safeNumber(
 b.score
 )-
 safeNumber(
 a.score
 )
 );
 }
);
for (
 const candidate of
 eligible
){
 if (
 buysRemaining <= 0
 ){
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
 Math.min( amount,
 PAPER_MODE ? MAX_PAPER_POSITION_USD : MAX_LIVE_TRADE_USD,
 availableCash
 );
if (
 amount <= 0
){
 break;
}
let result;
try {
 if (!PAPER_MODE) liveExecution.attempted++;
 result = PAPER_MODE
 ? paperBuy(portfolio, candidate, amount)
 : await liveBuy(env, portfolio, candidate, amount);
 if (!PAPER_MODE) {
 liveExecution.succeeded++;
 liveExecution.attempts.push({
 side: "BUY",
 mint: candidate.mint,
 symbol: candidate.symbol,
 amount_usd: amount,
 transaction_signature: result.transaction_signature || null
 });
 }
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
 transaction_signature:
 result.transaction_signature || null,
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
} catch (error) {
 if (!PAPER_MODE) {
 liveExecution.failed++;
 liveExecution.failures.push({ side: "BUY",
 mint: candidate.mint,
 symbol: candidate.symbol,
 amount_usd: amount,
 error: errorText(error)
 });
 } else {
 throw error;
 }
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
){
 if (
 portfolio.positions.length >=
 MAX_POSITIONS
 ){
 noTradeReason =
 "MAX_POSITIONS_REACHED";
 } else if (
 portfolio.cash_usd <=
 MIN_CASH_RESERVE_USD
 ){
 noTradeReason =
 "CASH_RESERVE";
 } else if (
 candidates.length === 0
 ){
 noTradeReason =
 "NO_CANDIDATES";
 } else if (
 !persistenceReady
 ){
 noTradeReason =
 "PERSISTENCE_THROTTLE";
 } else if (
 riskPassCount === 0
 ){
 noTradeReason =
 "NO_RISK_PASS_CANDIDATES";
 } else if (
 eligibleCount === 0
 ){
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
 persistence.attempted = true;
 try {
 persistence = await savePortfolio(env, portfolio, PAPER_MODE ? "TRADE" : "LIVE_TRADE", { force: true });
 } catch (error) {
 if (PAPER_MODE) {
 restoreObject(portfolio, beforeRun);
 throw new Error(`PAPER_TRADE_ROLLED_BACK_PERSISTENCE_FAILED: ${errorText(error)}`);
 }
 persistence = { attempted: true, saved: false, throttled: false, reason: "LIVE_TRADE_PERSISTENCE_FAILED_AFTER_BROADCAST", error: errorText(error) };
 }
} else if (
 importantStateChanged &&
 persistenceReady
){
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
 persistence = { attempted: true,
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
){
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
){
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
 PAPER_MODE ? "PAPER" : "LIVE", transaction_execution:
 TRANSACTION_EXECUTION,
 execution: liveBetaExecutionStatus()
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
execution_diagnostics:
 liveExecution,
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
 MAX_LIVE_TRADE_USD,
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
){
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
 bot: BOT_NAME,
 mode: { type:
 PAPER_MODE ? "PAPER" : "LIVE",
 transaction_execution:
 TRANSACTION_EXECUTION,
 execution: liveBetaExecutionStatus()
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
){
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
 PAPER_MODE ? "PAPER" : "LIVE", transaction_execution:
 TRANSACTION_EXECUTION,
 execution:
 liveBetaExecutionStatus()
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
 memory.observations.length - 1 ]
 : null
 })
 )
},
portfolio:
 mark,
accounting: calculateAccountingCheck(
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
 RESET TRADING ACCOUNT
 ============================================================ */
async function resetPaper(
 env
){
 const portfolio =
 createEmptyPortfolio();
 const persistence =
 await savePortfolio(
 env,
 portfolio, "RESET",
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
 PAPER_MODE ? "PAPER" : "LIVE",
 transaction_execution:
 TRANSACTION_EXECUTION,
 execution: liveBetaExecutionStatus()
 },
 message:
 "Beta portfolio reset. Starting bankroll reset to $20.",
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
){
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
function requireExecutionAuthorization(request, env) {
 if (!env.LIVE_EXECUTION_TOKEN) throw new Error("MISSING_LIVE_EXECUTION_TOKEN");
 const authorization = request.headers.get("authorization") || "";
 const expected = `Bearer ${env.LIVE_EXECUTION_TOKEN}`;
 const providedBytes = new TextEncoder().encode(authorization);
 const expectedBytes = new TextEncoder().encode(expected);
 if (providedBytes.length !== expectedBytes.length) throw new Error("UNAUTHORIZED_LIVE_EXECUTION_REQUEST");
 let difference = 0;
 for (let i = 0; i < expectedBytes.length; i++) difference |= providedBytes[i] ^ expectedBytes[i];
 if (difference !== 0) throw new Error("UNAUTHORIZED_LIVE_EXECUTION_REQUEST");
}
/* ============================================================
 HTTP ROUTER
 ============================================================ */export default {
 async fetch(
 request,
 env
 ){
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
 ){
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
 ){
 return jsonResponse({
 ok: true,
 bot:
 BOT_NAME, mode:
 PAPER_MODE ? "PAPER" : "LIVE",
 transaction_execution:
 TRANSACTION_EXECUTION,
 execution:
 liveBetaExecutionStatus(),
 time:
 nowIso()
 });
}
if (
 path === "/run"
){
 if (!PAPER_MODE && TRANSACTION_EXECUTION) requireExecutionAuthorization(request, env);
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
){
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
){
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
){
 if (!PAPER_MODE && TRANSACTION_EXECUTION) requireExecutionAuthorization(request, env);
 const confirm =
 url.searchParams.get(
 "confirm"
 );
 if (
 confirm !==
 "RESET"
 ){
 return jsonResponse(
 {
 ok: false,
 error:
 "Reset requires ?confirm=RESET"
 },
 400
 );
 } const result =
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
 "ENGINE_ERROR", error:
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
 type: PAPER_MODE ? "PAPER" : "LIVE",
 transaction_execution: TRANSACTION_EXECUTION,
 execution: liveBetaExecutionStatus()
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
){
 ctx.waitUntil(
 (async () => {
 try {
 if (PAPER_MODE || !LIVE_BETA_MODE || !TRANSACTION_EXECUTION) {
 throw new Error("LIVE_SCHEDULE_EXECUTION_NOT_ENABLED");
 }
 requireLiveConfig(env);
 const result = await runPaperEngine(env);
 console.log(JSON.stringify({
 cron: true,
 bot: BOT_NAME,
 time: nowIso(),
 buys: result.buys,
 sells: result.sells,
 blocked_sells: result.blocked_sells?.length || 0,
 no_trade_reason: result.no_trade_reason,
 equity: result.portfolio.equity_usd,
 eligible: result.scan.eligible_candidates,
 persistence: result.persistence,
 discovery: result.scan.discovery_diagnostics,
 hydration: result.scan.hydration_diagnostics,
 jupiter: result.scan.jupiter_diagnostics
 }));
 } catch (error) {
 console.error(JSON.stringify({
 cron: true,
 bot: BOT_NAME,
 type: "CRON_ERROR",
 error: errorText(error),
 time: nowIso()
 }));
 }
 })()
 );
 }};
