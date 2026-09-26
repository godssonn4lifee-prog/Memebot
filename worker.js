import { Connection, Keypair, PublicKey, VersionedTransaction } from "npm:@solana/web3.js";
import bs58 from "npm:bs58";
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
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const LIVE_EXECUTION_RESERVE_SOL = 0.01;
const LIVE_MAX_BANKROLL_USD = STARTING_CASH_USD;
const LIVE_SLIPPAGE_BPS = 100;
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
 UTILITY FUNCTIONS ============================================================ */
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
function createEmptyPortfolio() { return {
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
 ){
 return createEmptyPortfolio(); }
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
 JSON.stringify(payload));
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
 error: null, sample: []
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
 return { results:
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
 if (!mint) { continue;
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
 );for (
 const item of
 items
){
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
 null, requested_mints: mints.length,
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
 "NO_SOLANA_PAIRS" }
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
 a?.liquidity?.usd,
 0
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
 mint, status:
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
 ? buys5m / total5m : 0;
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
 )/
 86400000;
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
 ============================================================ *//*
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
 price: null,
 field: null
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
 priceData, mint
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
 )
){
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
 key => extractJupiterPriceValue(
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
/*
 Candidate 2:
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
 "DIRECT_PRICE_RECORD" }
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
 http_status:
 null,
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
 diagnostics.price = direct.price;
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
 parsed.price
 );
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
 so the query is formed consistently.*/
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
