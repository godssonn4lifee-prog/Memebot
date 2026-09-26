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
 const persistedAt = Date.now();
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
 "LIVE_BETA_PORTFOLIO",
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
 time: payload.updated_at
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
function pairLiquidityScore(pair) {
 const liquidity =
 safeNumber(
 pair?.liquidity?.usd
 );
 const volume24 =
 safeNumber(
 pair?.volume?.h24
 );
 const volume1 =
 safeNumber(
 pair?.volume?.h1
 );
 return (
 Math.log10(
 Math.max(
 liquidity,
 1
 )
 ) * 2 +
 Math.log10(
 Math.max(
 volume24,
 1
 )
 ) +
 Math.log10(
 Math.max(
 volume1,
 1
 )
 ) * 0.5
 );
}
function chooseBestDexPair(
 pairs,
 mint
) {
 const matches =
 (pairs || [])
 .filter(
 pair =>
 String(
 pair?.chainId ||
 ""
 ).toLowerCase() ===
 "solana" &&
 String(
 pair?.baseToken?.address ||
 ""
 ).toLowerCase() ===
 String(mint).toLowerCase()
 );
 if (!matches.length) {
 return {
 pair: null,
 diagnostics: {
 mint,
 pair_count: 0,
 candidates: []
 }
 };
 }
 const ranked =
 [...matches]
 .sort(
 (a, b) =>
 pairLiquidityScore(b) -
 pairLiquidityScore(a)
 );
 return {
 pair:
 ranked[0],
 diagnostics: {
 mint,
 pair_count:
 matches.length,
 candidates:
 ranked
 .slice(0, 5)
 .map(
 summarizeDexPair
 )
 }
 };
}
/* ============================================================
 DEXSCREENER TOKEN HYDRATION
 ============================================================ */
async function hydrateDexTokens(
 mints
) {
 const uniqueMints =
 unique(mints);
 const chunks = [];
 for (
 let i = 0;
 i < uniqueMints.length;
 i += 30
 ) {
 chunks.push(
 uniqueMints.slice(
 i,
 i + 30
 )
 );
 }
 const allPairs = [];
 const diagnostics = {
 attempted:
 uniqueMints.length,
 successful: 0,
 failed: 0,
 requests: [],
 pair_count: 0
 };
 for (
 const chunk of
 chunks
 ) {
 const url =
 `${DEX_BASE}/latest/dex/tokens/${chunk.join(",")}`;
 const result =
 await fetchJsonDiagnostic(
 url
 );
 const requestDiagnostic = {
 count: chunk.length,
 http_status:
 result.status,
 error:
 result.error || null,
 pair_count: 0
 };
 diagnostics.requests.push(
 requestDiagnostic
 );
 if (!result.ok) {
 diagnostics.failed++;
 continue;
 }
 const pairs =
 Array.isArray(
 result.data?.pairs
 )
 ? result.data.pairs
 : [];
 requestDiagnostic.pair_count =
 pairs.length;
 diagnostics.pair_count +=
 pairs.length;
 diagnostics.successful++;
 allPairs.push(
 ...pairs
 );
 }
 return {
 pairs: allPairs,
 diagnostics
 };
}
/* ============================================================
 DEXSCREENER SEARCH PAIRS ARE REUSED DIRECTLY
 ============================================================ */
function normalizeDexPair(
 pair,
 source = "DEXSCREENER"
) {
 const mint =
 pair?.baseToken?.address;
 if (!mint) {
 return null;
 }
 const price =
 safeNumber(
 pair?.priceUsd,
 NaN
 );
 const liquidity =
 safeNumber(
 pair?.liquidity?.usd,
 0
 );
 const volume24h =
 safeNumber(
 pair?.volume?.h24,
 0
 );
 const volume1h =
 safeNumber(
 pair?.volume?.h1,
 0
 );
 const volume5m =
 safeNumber(
 pair?.volume?.h6,
 0
 );
 const change5m =
 safeNumber(
 pair?.priceChange?.m5,
 0
 ) / 100;
 const change1h =
 safeNumber(
 pair?.priceChange?.h1,
 0
 ) / 100;
 const change6h =
 safeNumber(
 pair?.priceChange?.h6,
 0
 ) / 100;
 const change24h =
 safeNumber(
 pair?.priceChange?.h24,
 0
 ) / 100;
 const buys5m =
 safeNumber(
 pair?.txns?.m5?.buys,
 0
 );
 const sells5m =
 safeNumber(
 pair?.txns?.m5?.sells,
 0
 );
 const buys1h =
 safeNumber(
 pair?.txns?.h1?.buys,
 0
 );
 const sells1h =
 safeNumber(
 pair?.txns?.h1?.sells,
 0
 );
 const createdAt =
 safeNumber(
 pair?.pairCreatedAt,
 0
 );
 const ageDays =
 createdAt > 0
 ? Math.max(
 0,
 (Date.now() -
 createdAt) /
 86400000
 )
 : null;
 return {
 mint,
 symbol:
 pair?.baseToken?.symbol ||
 "UNKNOWN",
 name:
 pair?.baseToken?.name ||
 "Unknown",
 dex:
 pair?.dexId ||
 "unknown",
 pair_address:
 pair?.pairAddress ||
 null,
 url:
 pair?.url ||
 null,
 price,
 liquidity_usd:
 liquidity,
 volume_24h_usd:
 volume24h,
 volume_1h_usd:
 volume1h,
 volume_5m_usd:
 volume5m,
 change_5m:
 change5m,
 change_1h:
 change1h,
 change_6h:
 change6h,
 change_24h:
 change24h,
 buys_5m:
 buys5m,
 sells_5m:
 sells5m,
 buys_1h:
 buys1h,
 sells_1h:
 sells1h,
 pair_created_at:
 createdAt || null,
 age_days:
 ageDays,
 source,
 raw_pair:
 pair
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
 const key =
 String(mint);
 const direct =
 data?.[key];
 const candidates = [
 direct,
 direct?.price,
 data?.data?.[key],
 data?.data?.[key]?.price,
 data?.prices?.[key],
 data?.[key]?.usdPrice
 ];
 for (
 const value of
 candidates
 ) {
 const numeric =
 safeNumber(
 value,
 NaN
 );
 if (
 Number.isFinite(
 numeric
 ) &&
 numeric > 0
 ) {
 return numeric;
 }
 }
 return null;
}
async function getJupiterPrices(
 mints,
 diagnostics
) {
 const selected =
 unique(mints)
 .slice(
 0,
 MAX_JUPITER_PRICE_CHECKS
 );
 diagnostics.attempted =
 selected.length;
 diagnostics.requested_mints =
 selected;
 if (!selected.length) {
 return {};
 }
 const url =
 `${JUPITER_PRICE_API}?ids=${selected.join(",")}`;
 const result =
 await fetchJsonDiagnostic(
 url,
 {
 headers: {
 accept:
 "application/json"
 }
 }
 );
 diagnostics.http_status =
 result.status;
 diagnostics.response_shape =
 responseShape(
 result.data
 );
 if (!result.ok) {
 diagnostics.error =
 result.error;
 return {};
 }
 const prices = {};
 for (
 const mint of
 selected
 ) {
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
 }
 }
 diagnostics.returned_keys =
 Object.keys(
 result.data || {}
 ).length;
 diagnostics.usable_prices =
 Object.keys(
 prices
 ).length;
 diagnostics.sample =
 selected
 .slice(0, 5)
 .map(
 mint => ({
 mint,
 price:
 prices[mint] ??
 null
 })
 );
 return prices;
}
async function getJupiterSinglePrice(
 mint
) {
 const url =
 `${JUPITER_PRICE_API}?ids=${encodeURIComponent(mint)}`;
 const result =
 await fetchJsonDiagnostic(
 url,
 {
 headers: {
 accept:
 "application/json"
 }
 }
 );
 if (!result.ok) {
 throw new Error(
 `JUPITER_PRICE_HTTP_${result.status || "ERROR"}:${result.error || ""}`
 );
 }
 const price =
 extractJupiterPrice(
 result.data,
 mint
 );
 if (
 !Number.isFinite(price) ||
 price <= 0
 ) {
 throw new Error(
 "JUPITER_PRICE_UNAVAILABLE"
 );
 }
 return price;
}
/* ============================================================
 JUPITER FALLBACK DIAGNOSTICS
 ============================================================ */
async function runJupiterFallback(
 mints,
 diagnostics
) {
 const selected =
 unique(mints)
 .slice(
 0,
 MAX_JUPITER_FALLBACK_CHECKS
 );
 diagnostics.attempted =
 selected.length;
 diagnostics.results = [];
 const prices = {};
 for (
 const mint of
 selected
 ) {
 const url =
 `${JUPITER_PRICE_API}?ids=${encodeURIComponent(mint)}`;
 const result =
 await fetchJsonDiagnostic(
 url
 );
 const item = {
 mint,
 http_status:
 result.status,
 response_shape:
 responseShape(
 result.data
 ),
 price: null,
 error:
 result.error || null
 };
 if (result.ok) {
 const price =
 extractJupiterPrice(
 result.data,
 mint
 );
 item.price =
 Number.isFinite(price)
 ? price
 : null;
 if (
 Number.isFinite(price) &&
 price > 0
 ) {
 prices[mint] =
 price;
 }
 }
 diagnostics.results.push(
 item
 );
 }
 diagnostics.usable_prices =
 Object.keys(
 prices
 ).length;
 return prices;
}
/* ============================================================
 CANDIDATE MERGING
 ============================================================ */
function mergeCandidateSource(
 existing,
 incoming
) {
 if (!existing) {
 return {
 ...incoming,
 sources: [
 incoming.source
 ].filter(Boolean)
 };
 }
 const sources =
 unique([
 ...(existing.sources || []),
 incoming.source
 ]);
 const merged = {
 ...existing,
 ...incoming,
 sources
 };
 if (
 existing.raw_pair &&
 !incoming.raw_pair
 ) {
 merged.raw_pair =
 existing.raw_pair;
 }
 return merged;
}
function mergeCandidateMaps(
 ...groups
) {
 const map = new Map();
 for (
 const group of groups
 ) {
 for (
 const candidate of
 group || []
 ) {
 if (!candidate?.mint) {
 continue;
 }
 const key =
 String(
 candidate.mint
 ).toLowerCase();
 const existing =
 map.get(key);
 map.set(
 key,
 mergeCandidateSource(
 existing,
 candidate
 )
 );
 }
 }
 return [
 ...map.values()
 ];
}
/* ============================================================
 MARKET MEMORY
 ============================================================ */
function cleanupMarketMemory(
 portfolio
) {
 const memory =
 portfolio.market_memory || {};
 const cutoff =
 Date.now() -
 7 * 86400000;
 for (
 const [mint, entry]
 of Object.entries(memory)
 ) {
 const observations =
 Array.isArray(
 entry?.observations
 )
 ? entry.observations
 : [];
 const recent =
 observations.filter(
 observation =>
 safeNumber(
 new Date(
 observation.time
 ).getTime()
 ) >= cutoff
 );
 if (!recent.length) {
 delete memory[mint];
 continue;
 }
 entry.observations =
 recent.slice(
 -MAX_MEMORY_OBSERVATIONS
 );
 }
 const entries =
 Object.entries(memory)
 .sort(
 (a, b) =>
 safeNumber(
 new Date(
 b[1]?.last_seen
 ).getTime()
 ) -
 safeNumber(
 new Date(
 a[1]?.last_seen
 ).getTime()
 )
 );
 portfolio.market_memory =
 Object.fromEntries(
 entries.slice(
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
 const mint =
 String(
 candidate.mint
 );
 portfolio.market_memory ||= {};
 const entry =
 portfolio.market_memory[mint] ||= {
 mint,
 symbol:
 candidate.symbol ||
 null,
 name:
 candidate.name ||
 null,
 observations: [],
 first_seen:
 nowIso(),
 last_seen:
 nowIso()
 };
 entry.symbol =
 candidate.symbol ||
 entry.symbol ||
 null;
 entry.name =
 candidate.name ||
 entry.name ||
 null;
 entry.last_seen =
 nowIso();
 entry.observations ||= [];
 entry.observations.push({
 time: nowIso(),
 price:
 safeNumber(
 candidate.price,
 0
 ),
 score:
 safeNumber(
 candidate.score,
 0
 ),
 momentum_score:
 safeNumber(
 candidate.momentum_score,
 0
 ),
 setup_score:
 safeNumber(
 candidate.setup_score,
 0
 ),
 setup_confirmed:
 !!candidate.setup_confirmed,
 liquidity_usd:
 safeNumber(
 candidate.liquidity_usd,
 0
 ),
 volume_1h_usd:
 safeNumber(
 candidate.volume_1h_usd,
 0
 ),
 volume_24h_usd:
 safeNumber(
 candidate.volume_24h_usd,
 0
 ),
 change_5m:
 safeNumber(
 candidate.change_5m,
 0
 ),
 change_1h:
 safeNumber(
 candidate.change_1h,
 0
 ),
 change_6h:
 safeNumber(
 candidate.change_6h,
 0
 ),
 change_24h:
 safeNumber(
 candidate.change_24h,
 0
 ),
 filter_reasons:
 candidate.filter_reasons ||
 []
 });
 entry.observations =
 entry.observations.slice(
 -MAX_MEMORY_OBSERVATIONS
 );
 cleanupMarketMemory(
 portfolio
 );
}
function getMarketMemory(
 portfolio,
 mint
) {
 return (
 portfolio.market_memory?.[
 String(mint)
 ] || null
 );
}
function getHistoryObservationCount(
 portfolio,
 mint
) {
 const memory =
 getMarketMemory(
 portfolio,
 mint
 );
 return Array.isArray(
 memory?.observations
 )
 ? memory.observations.length
 : 0;
}
function getHistoricalSetupBonus(
 portfolio,
 mint
) {
 const memory =
 getMarketMemory(
 portfolio,
 mint
 );
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
 const confirmed =
 observations.filter(
 observation =>
 observation.setup_confirmed
 ).length;
 if (!confirmed) {
 return 0;
 }
 const averageScore =
 observations.reduce(
 (sum, observation) =>
 sum +
 safeNumber(
 observation.setup_score
 ),
 0
 ) /
 observations.length;
 const consistency =
 confirmed /
 observations.length;
 const bonus =
 Math.round(
 clamp(
 averageScore *
 consistency *
 0.35,
 0,
 MAX_HISTORICAL_SETUP_BONUS
 )
 );
 return bonus;
}
/* ============================================================
 COOLDOWN
 ============================================================ */
function isOnCooldown(
 portfolio,
 mint
) {
 const until =
 safeNumber(
 portfolio.cooldowns?.[
 String(mint)
 ]
 );
 return (
 until > Date.now()
 );
}
function setCooldown(
 portfolio,
 mint
) {
 portfolio.cooldowns ||= {};
 portfolio.cooldowns[
 String(mint)
 ] =
 Date.now() +
 COOLDOWN_SECONDS *
 1000;
}
function cleanupCooldowns(
 portfolio
) {
 const now =
 Date.now();
 for (
 const [mint, until]
 of Object.entries(
 portfolio.cooldowns || {}
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
 MARKET FILTERS
 ============================================================ */
function evaluateMarketFilters(
 candidate
) {
 const reasons = [];
 const price =
 safeNumber(
 candidate.price
 );
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
 const ageDays =
 candidate.age_days;
 if (
 !Number.isFinite(price) ||
 price < MIN_TOKEN_PRICE
 ) {
 reasons.push(
 "INVALID_PRICE"
 );
 }
 if (
 liquidity < MIN_LIQUIDITY_USD
 ) {
 reasons.push(
 "LOW_LIQUIDITY"
 );
 }
 if (
 volume24h <
 MIN_VOLUME_24H_USD
 ) {
 reasons.push(
 "LOW_24H_VOLUME"
 );
 }
 if (
 volume1h <
 MIN_VOLUME_1H_USD
 ) {
 reasons.push(
 "LOW_1H_VOLUME"
 );
 }
 const isNew =
 Number.isFinite(
 ageDays
 ) &&
 ageDays <=
 NEW_TOKEN_MAX_AGE_DAYS;
 if (
 isNew &&
 liquidity <
 NEW_TOKEN_MIN_LIQUIDITY_USD
 ) {
 reasons.push(
 "NEW_TOKEN_LOW_LIQUIDITY"
 );
 }
 if (
 candidate.change_5m >
 MAX_5M_GAIN
 ) {
 reasons.push(
 "CHASE_5M"
 );
 }
 if (
 candidate.change_1h >
 MAX_1H_GAIN
 ) {
 reasons.push(
 "CHASE_1H"
 );
 }
 if (
 candidate.change_6h >
 MAX_6H_GAIN
 ) {
 reasons.push(
 "CHASE_6H"
 );
 }
 if (
 candidate.change_24h >
 MAX_24H_GAIN
 ) {
 reasons.push(
 "CHASE_24H"
 );
 }
 if (
 isNew &&
 candidate.change_1h >
 EXTREME_1H_MOVE
 ) {
 reasons.push(
 "NEW_TOKEN_PARABOLIC"
 );
 }
 return {
 passed:
 reasons.length === 0,
 reasons
 };
}
/* ============================================================
 MARKET SHAPE
 ============================================================ */
function calculateMomentumScore(
 candidate
) {
 let score = 0;
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
 if (
 change5m > 0.01
 ) {
 score += 3;
 }
 if (
 change5m > BOUNCE_5M
 ) {
 score += 3;
 }
 if (
 change1h > 0.03
 ) {
 score += 3;
 }
 if (
 change1h > 0.10
 ) {
 score += 3;
 }
 if (
 change6h > 0.05
 ) {
 score += 3;
 }
 if (
 change24h > 0.10
 ) {
 score += 3;
 }
 if (
 change6h <
 STRONG_NEGATIVE_6H
 ) {
 score -= 5;
 }
 if (
 change5m <
 STRONG_NEGATIVE_5M
 ) {
 score -= 3;
 }
 const buys5m =
 safeNumber(
 candidate.buys_5m
 );
 const sells5m =
 safeNumber(
 candidate.sells_5m
 );
 if (
 buys5m >
 0 &&
 buys5m /
 Math.max(
 sells5m,
 1
 ) >=
 SHORT_TERM_SELL_RATIO
 ) {
 score += 4;
 }
 const buys1h =
 safeNumber(
 candidate.buys_1h
 );
 const sells1h =
 safeNumber(
 candidate.sells_1h
 );
 if (
 buys1h >
 0 &&
 buys1h /
 Math.max(
 sells1h,
 1
 ) >=
 HOURLY_SELL_RATIO
 ) {
 score += 4;
 }
 return clamp(
 score,
 -20,
 20
 );
}
function calculateSetupScore(
 candidate
) {
 let score = 0;
 const liquidity =
 safeNumber(
 candidate.liquidity_usd
 );
 const volume1h =
 safeNumber(
 candidate.volume_1h_usd
 );
 const volume24h =
 safeNumber(
 candidate.volume_24h_usd
 );
 const buyRatio5m =
 safeNumber(
 candidate.buys_5m
 ) /
 Math.max(
 safeNumber(
 candidate.sells_5m
 ),
 1
 );
 const buyRatio1h =
 safeNumber(
 candidate.buys_1h
 ) /
 Math.max(
 safeNumber(
 candidate.sells_1h
 ),
 1
 );
 if (
 liquidity >=
 MIN_LIQUIDITY_USD * 2
 ) {
 score += 4;
 }
 if (
 liquidity >=
 100000
 ) {
 score += 4;
 }
 if (
 volume1h >=
 MIN_VOLUME_1H_USD * 2
 ) {
 score += 4;
 }
 if (
 volume1h >=
 10000
 ) {
 score += 4;
 }
 if (
 volume24h >=
 100000
 ) {
 score += 3;
 }
 if (
 buyRatio5m >=
 SHORT_TERM_SELL_RATIO
 ) {
 score += 3;
 }
 if (
 buyRatio1h >=
 HOURLY_SELL_RATIO
 ) {
 score += 3;
 }
 if (
 candidate.change_5m >
 0 &&
 candidate.change_1h >
 0 &&
 candidate.change_6h >
 0
 ) {
 score += 3;
 }
 if (
 candidate.change_5m >
 0 &&
 candidate.change_1h <
 0
 ) {
 score += 2;
 }
 if (
 candidate.change_6h <
 STRONG_NEGATIVE_6H &&
 candidate.change_5m >
 BOUNCE_5M
 ) {
 score += 5;
 }
 return clamp(
 score,
 -20,
 30
 );
}
function buildCandidateScore(
 portfolio,
 candidate
) {
 const momentumScore =
 calculateMomentumScore(
 candidate
 );
 const setupScore =
 calculateSetupScore(
 candidate
 );
 const historicalBonus =
 getHistoricalSetupBonus(
 portfolio,
 candidate.mint
 );
 const setupConfirmed =
 setupScore >=
 MIN_SETUP_SCORE;
 let riskPenalty = 0;
 if (
 candidate.age_days !== null &&
 candidate.age_days <=
 NEW_TOKEN_MAX_AGE_DAYS &&
 candidate.change_1h >
 EXTREME_1H_MOVE
 ) {
 riskPenalty += 15;
 }
 if (
 candidate.change_6h >
 MAX_6H_GAIN
 ) {
 riskPenalty += 8;
 }
 if (
 candidate.change_5m >
 MAX_5M_GAIN
 ) {
 riskPenalty += 5;
 }
 const score =
 momentumScore +
 setupScore +
 historicalBonus -
 riskPenalty;
 return {
 score,
 momentum_score:
 momentumScore,
 setup_score:
 setupScore,
 historical_bonus:
 historicalBonus,
 setup_confirmed:
 setupConfirmed,
 risk_penalty:
 riskPenalty,
 history_observations:
 getHistoryObservationCount(
 portfolio,
 candidate.mint
 ),
 score_breakdown: {
 momentum:
 momentumScore,
 setup:
 setupScore,
 historical_bonus:
 historicalBonus,
 risk_penalty:
 riskPenalty
 }
 };
}
/* ============================================================
 CANDIDATE NORMALIZATION
 ============================================================ */
function normalizeCandidate(
 portfolio,
 candidate
) {
 const normalized = {
 ...candidate,
 price:
 safeNumber(
 candidate.price,
 0
 ),
 liquidity_usd:
 safeNumber(
 candidate.liquidity_usd,
 0
 ),
 volume_24h_usd:
 safeNumber(
 candidate.volume_24h_usd,
 0
 ),
 volume_1h_usd:
 safeNumber(
 candidate.volume_1h_usd,
 0
 ),
 volume_5m_usd:
 safeNumber(
 candidate.volume_5m_usd,
 0
 ),
 change_5m:
 safeNumber(
 candidate.change_5m,
 0
 ),
 change_1h:
 safeNumber(
 candidate.change_1h,
 0
 ),
 change_6h:
 safeNumber(
 candidate.change_6h,
 0
 ),
 change_24h:
 safeNumber(
 candidate.change_24h,
 0
 ),
 buys_5m:
 safeNumber(
 candidate.buys_5m,
 0
 ),
 sells_5m:
 safeNumber(
 candidate.sells_5m,
 0
 ),
 buys_1h:
 safeNumber(
 candidate.buys_1h,
 0
 ),
 sells_1h:
 safeNumber(
 candidate.sells_1h,
 0
 ),
 jupiter_price_usd:
 Number.isFinite(
 safeNumber(
 candidate.jupiter_price_usd,
 NaN
 )
 )
 ? safeNumber(
 candidate.jupiter_price_usd
 )
 : null
 };
 const filterResult =
 evaluateMarketFilters(
 normalized
 );
 normalized.filter_reasons =
 filterResult.reasons;
 const scoring =
 buildCandidateScore(
 portfolio,
 normalized
 );
 Object.assign(
 normalized,
 scoring
 );
 normalized.eligible =
 filterResult.passed &&
 normalized.score >=
 MIN_ENTRY_SCORE &&
 normalized.momentum_score >=
 MIN_MOMENTUM_SCORE &&
 normalized.setup_score >=
 MIN_SETUP_SCORE &&
 normalized.setup_confirmed &&
 normalized.history_observations >=
 MIN_HISTORY_OBSERVATIONS &&
 !isOnCooldown(
 portfolio,
 normalized.mint
 );
 return normalized;
}
/* ============================================================
 PORTFOLIO VALUATION
 ============================================================ */
function markPosition(
 position,
 candidate
) {
 const currentPrice =
 safeNumber(
 candidate?.price,
 position.current_price
 );
 position.current_price =
 currentPrice;
 position.peak_price =
 Math.max(
 safeNumber(
 position.peak_price,
 position.entry_price
 ),
 currentPrice
 );
 if (
 position.entry_price >
 0
 ) {
 position.pnl_percent =
 (
 currentPrice -
 position.entry_price
 ) /
 position.entry_price;
 }
 position.pnl_usd =
 safeNumber(
 position.invested_usd
 ) *
 safeNumber(
 position.pnl_percent
 );
 if (
 position.pnl_percent >=
 TRAILING_ACTIVATION
 ) {
 position.trailing_active =
 true;
 }
 return position;
}
function portfolioEquity(
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
 String(
 position.mint
 ).toLowerCase()
 );
 if (candidate) {
 markPosition(
 position,
 candidate
 );
 }
 equity +=
 safeNumber(
 position.invested_usd
 ) *
 (
 1 +
 safeNumber(
 position.pnl_percent
 )
 );
 }
 return equity;
}
/* ============================================================
 EXIT SIGNALS
 ============================================================ */
function evaluateExit(
 position,
 candidate
) {
 const pnlPercent =
 safeNumber(
 candidate?.price
 ) > 0 &&
 safeNumber(
 position.entry_price
 ) > 0
 ? (
 safeNumber(
 candidate.price
 ) -
 safeNumber(
 position.entry_price
 )
 ) /
 safeNumber(
 position.entry_price
 )
 : safeNumber(
 position.pnl_percent
 );
 const peak =
 Math.max(
 safeNumber(
 position.peak_price,
 position.entry_price
 ),
 safeNumber(
 candidate?.price,
 position.current_price
 )
 );
 const drawdownFromPeak =
 peak > 0
 ? (
 safeNumber(
 candidate?.price,
 position.current_price
 ) -
 peak
 ) /
 peak
 : 0;
 if (
 pnlPercent <=
 STOP_LOSS
 ) {
 return {
 sell: true,
 reason:
 "STOP_LOSS",
 pnl_percent:
 pnlPercent
 };
 }
 if (
 position.trailing_active &&
 drawdownFromPeak <=
 -TRAILING_STOP
 ) {
 return {
 sell: true,
 reason:
 "TRAILING_STOP",
 pnl_percent:
 pnlPercent
 };
 }
 const shortSells =
 safeNumber(
 candidate?.sells_5m
 );
 const shortBuys =
 safeNumber(
 candidate?.buys_5m
 );
 const shortRatio =
 shortBuys > 0
 ? shortSells /
 shortBuys
 : shortSells > 0
 ? Infinity
 : 0;
 if (
 pnlPercent > 0 &&
 shortRatio >=
 PROFIT_REVERSAL_SELL_RATIO
 ) {
 position.reversal_confirmations =
 safeNumber(
 position.reversal_confirmations
 ) + 1;
 } else {
 position.reversal_confirmations = 0;
 }
 if (
 position.reversal_confirmations >=
 REVERSAL_CONFIRMATIONS_REQUIRED
 ) {
 return {
 sell: true,
 reason:
 "PROFIT_REVERSAL",
 pnl_percent:
 pnlPercent
 };
 }
 return {
 sell: false,
 reason: null,
 pnl_percent:
 pnlPercent
 };
}
/* ============================================================
 LIVE BETA STATUS
 ============================================================ */
function liveBetaExecutionStatus() {
 return {
 enabled:
 LIVE_BETA_MODE,
 transaction_execution:
 TRANSACTION_EXECUTION,
 paper_mode:
 PAPER_MODE,
 live_mode:
 !PAPER_MODE,
 max_trade_usd:
 MAX_LIVE_TRADE_USD,
 max_bankroll_usd:
 LIVE_MAX_BANKROLL_USD,
 reserve_sol:
 LIVE_EXECUTION_RESERVE_SOL,
 confirmation_gated:
 false
 };
}
/* ============================================================
 WALLET / SOLANA LIVE EXECUTION HELPERS
 ============================================================ */
function parseWalletSecret(
 value
) {
 if (!value) {
 throw new Error(
 "MISSING_WALLET_PRIVATE_KEY"
 );
 }
 if (
 Array.isArray(value)
 ) {
 const bytes =
 Uint8Array.from(
 value.map(
 x => safeNumber(x)
 )
 );
 if (
 bytes.length !==
 64
 ) {
 throw new Error(
 "WALLET_PRIVATE_KEY_MUST_BE_64_BYTES"
 );
 }
 return bytes;
 }
 const text =
 String(value).trim();
 if (
 text.startsWith("[")
 ) {
 try {
 const parsed =
 JSON.parse(text);
 return parseWalletSecret(
 parsed
 );
 } catch {
 throw new Error(
 "INVALID_WALLET_PRIVATE_KEY_JSON"
 );
 }
 }
 if (
 /^[0-9a-fA-F]+$/.test(text) &&
 text.length === 128
 ) {
 const bytes =
 new Uint8Array(64);
 for (
 let i = 0;
 i < 64;
 i++
 ) {
 bytes[i] =
 parseInt(
 text.slice(
 i * 2,
 i * 2 + 2
 ),
 16
 );
 }
 return bytes;
 }
 try {
 return bs58.decode(
 text
 );
 } catch {
 throw new Error(
 "INVALID_WALLET_PRIVATE_KEY_BASE58"
 );
 }
}
function readCompactU16(
 bytes,
 offset
) {
 let value = 0;
 let size = 0;
 let shift = 0;
 while (true) {
 if (
 offset + size >=
 bytes.length
 ) {
 throw new Error(
 "INVALID_TRANSACTION_SIGNATURE_LENGTH"
 );
 }
 const byte =
 bytes[offset + size];
 value |=
 (byte & 0x7f) <<
 shift;
 size++;
 if (
 (byte & 0x80) ===
 0
 ) {
 break;
 }
 shift += 7;
 if (shift > 28) {
 throw new Error(
 "INVALID_COMPACT_U16"
 );
 }
 }
 return {
 value,
 size
 };
}
async function signSolanaTransaction(
 transactionBase64,
 env
) {
 const secret =
 parseWalletSecret(
 env.WALLET_PRIVATE_KEY
 );
 const keypair =
 Keypair.fromSecretKey(
 secret
 );
 const tx =
 Uint8Array.from(
 atob(transactionBase64),
 char => char.charCodeAt(0)
 );
 const signatureInfo =
 readCompactU16(
 tx,
 0
 );
 const signatureCount =
 signatureInfo.value;
 if (
 signatureCount !== 1
 ) {
 throw new Error(
 `UNSUPPORTED_SIGNATURE_COUNT_${signatureCount}`
 );
 }
 const messageOffset =
 signatureInfo.size +
 signatureCount *
 64;
 if (
 messageOffset >=
 tx.length
 ) {
 throw new Error(
 "INVALID_TRANSACTION_MESSAGE_OFFSET"
 );
 }
 const versioned =
 (tx[messageOffset] &
 0x80) !== 0;
 const headerOffset =
 messageOffset +
 (
 versioned
 ? 1
 : 0
 );
 if (
 headerOffset + 3 >=
 tx.length
 ) {
 throw new Error(
 "INVALID_TRANSACTION_HEADER"
 );
 }
 const requiredSignatures =
 tx[headerOffset];
 if (
 requiredSignatures !== 1
 ) {
 throw new Error(
 `UNSUPPORTED_REQUIRED_SIGNATURES_${requiredSignatures}`
 );
 }
 const accountCountInfo =
 readCompactU16(
 tx,
 headerOffset + 3
 );
 const accountCount =
 accountCountInfo.value;
 const accountStart =
 headerOffset + 3 +
 accountCountInfo.size;
 const accountEnd =
 accountStart +
 accountCount *
 32;
 if (
 accountEnd > tx.length
 ) {
 throw new Error(
 "INVALID_ACCOUNT_KEYS"
 );
 }
 const feePayer =
 tx.slice(
 accountStart,
 accountStart + 32
 );
 const walletPublicKey =
 keypair.publicKey.toBytes();
 for (
 let i = 0;
 i < 32;
 i++
 ) {
 if (
 feePayer[i] !==
 walletPublicKey[i]
 ) {
 throw new Error(
 "LIVE_TRANSACTION_FEE_PAYER_MISMATCH"
 );
 }
 }
 const pkcs8Prefix =
 Uint8Array.from([
 0x30, 0x2e,
 0x02, 0x01, 0x00,
 0x30, 0x05,
 0x06, 0x03,
 0x2b, 0x65, 0x70,
 0x04, 0x22,
 0x04, 0x20
 ]);
 const privateSeed =
 secret.slice(
 0,
 32
 );
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
 const cryptoKey =
 await crypto.subtle.importKey(
 "pkcs8",
 pkcs8,
 {
 name: "Ed25519"
 },
 false,
 ["sign"]
 );
 const message =
 tx.slice(
 messageOffset
 );
 const signature =
 new Uint8Array(
 await crypto.subtle.sign(
 "Ed25519",
 cryptoKey,
 message
 )
 );
 tx.set(
 signature,
 signatureInfo.size
 );
 let binary = "";
 const chunkSize =
 0x8000;
 for (
 let i = 0;
 i < tx.length;
 i += chunkSize
 ) {
 binary += String.fromCharCode(
 ...tx.slice(
 i,
 Math.min(
 i + chunkSize,
 tx.length
 )
 )
 );
 }
 return {
 signedTransactionBase64:
 btoa(binary),
 publicKey:
 keypair.publicKey.toBase58()
 };
}
async function solanaRpc(
 env,
 method,
 params = []
) {
 const rpcUrl =
 env.SOLANA_RPC_URL ||
 SOLANA_RPC_URL;
 const response =
 await fetch(
 rpcUrl,
 {
 method: "POST",
 headers: {
 "content-type":
 "application/json"
 },
 body:
 JSON.stringify({
 jsonrpc: "2.0",
 id: Date.now(),
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
 const payload =
 await response.json();
 if (
 payload.error
 ) {
 throw new Error(
 `SOLANA_RPC_${method}:${JSON.stringify(payload.error)}`
 );
 }
 return payload.result;
}
async function getLiveWalletPublicKey(
 env
) {
 const secret =
 parseWalletSecret(
 env.WALLET_PRIVATE_KEY
 );
 return Keypair
 .fromSecretKey(
 secret
 )
 .publicKey
 .toBase58();
}
async function getSolUsdPrice(
 env
) {
 try {
 return await getJupiterSinglePrice(
 WSOL_MINT
 );
 } catch {
 const fallback =
 await fetchJsonDiagnostic(
 "https://api.dexscreener.com/latest/dex/tokens/" +
 WSOL_MINT
 );
 const pairs =
 Array.isArray(
 fallback.data?.pairs
 )
 ? fallback.data.pairs
 : [];
 const solPair =
 pairs.find(
 pair =>
 safeNumber(
 pair?.priceUsd,
 NaN
 ) > 0
 );
 const price =
 safeNumber(
 solPair?.priceUsd,
 NaN
 );
 if (
 !Number.isFinite(price) ||
 price <= 0
 ) {
 throw new Error(
 "SOL_USD_PRICE_UNAVAILABLE"
 );
 }
 return price;
}
}
async function jupiterQuote(
 env,
 inputMint,
 outputMint,
 amount
) {
 const params =
 new URLSearchParams({
 inputMint,
 outputMint,
 amount:
 String(amount),
 swapMode:
 "ExactIn",
 slippageBps:
 String(
 LIVE_SLIPPAGE_BPS
 )
 });
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
 const result =
 await fetchJsonDiagnostic(
 `${env.LIVE_QUOTE_API || "https://quote-api.jup.ag/v6"}/quote?${params.toString()}`,
 {
 headers
 }
 );
 if (!result.ok) {
 throw new Error(
 `JUPITER_QUOTE_FAILED:${result.error || result.status}`
 );
 }
 return result.data;
}
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
 const result =
 await fetchJsonDiagnostic(
 `${env.LIVE_QUOTE_API || "https://quote-api.jup.ag/v6"}/swap`,
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
 if (!result.ok) {
 throw new Error(
 `JUPITER_SWAP_BUILD_FAILED:${result.error || result.status}`
 );
 }
 const transaction =
 result.data?.swapTransaction;
 if (!transaction) {
 throw new Error(
 "JUPITER_SWAP_TRANSACTION_MISSING"
 );
 }
 return transaction;
}
async function broadcastAndConfirmLiveTransaction(
 env,
 unsignedTransactionBase64
) {
 const signed =
 await signSolanaTransaction(
 unsignedTransactionBase64,
 env
 );
 const signature =
 await solanaRpc(
 env,
 "sendTransaction",
 [
 signed.signedTransactionBase64,
 {
 encoding:
 "base64",
 skipPreflight:
 false,
 preflightCommitment:
 "confirmed",
 maxRetries:
 2
 }
 ]
 );
 const deadline =
 Date.now() +
 45000;
 let lastStatus =
 null;
 while (
 Date.now() <
 deadline
 ) {
 const statusResult =
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
 statusResult?.value?.[0];
 lastStatus =
 status || null;
 if (
 status?.err
 ) {
 throw new Error(
 `LIVE_TRANSACTION_FAILED:${JSON.stringify(status.err)}`
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
 confirmation_status:
 status.confirmationStatus,
 slot:
 status.slot ||
 null,
 public_key:
 signed.publicKey
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
 `LIVE_TRANSACTION_CONFIRMATION_TIMEOUT:${signature}:${JSON.stringify(lastStatus)}`
 );
}
async function executeLiveSwap(
 env,
 inputMint,
 outputMint,
 inputAmount
) {
 const wallet =
 await getLiveWalletPublicKey(
 env
 );
 const quote =
 await jupiterQuote(
 env,
 inputMint,
 outputMint,
 inputAmount
 );
 const unsigned =
 await jupiterSwapTransaction(
 env,
 quote,
 wallet
 );
 const transaction =
 await broadcastAndConfirmLiveTransaction(
 env,
 unsigned
 );
 return {
 quote,
 transaction
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
 if (
 !LIVE_BETA_MODE ||
 !TRANSACTION_EXECUTION ||
 PAPER_MODE
 ) {
 throw new Error(
 "LIVE_BUY_GATED"
 );
 }
 if (
 amountUsd <= 0 ||
 amountUsd >
 MAX_LIVE_TRADE_USD
 ) {
 throw new Error(
 "LIVE_BUY_AMOUNT_LIMIT"
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
 const solPrice =
 await getSolUsdPrice(
 env
 );
 const lamports =
 Math.floor(
 (amountUsd /
 solPrice) *
 1_000_000_000
 );
 if (
 lamports <= 0
 ) {
 return {
 ok: false,
 reason:
 "AMOUNT_TOO_SMALL"
 };
 }
 const wallet =
 await getLiveWalletPublicKey(
 env
 );
 const balance =
 await solanaRpc(
 env,
 "getBalance",
 [
 wallet,
 {
 commitment:
 "confirmed"
 }
 ]
 );
 const reserveLamports =
 Math.floor(
 LIVE_EXECUTION_RESERVE_SOL *
 1_000_000_000
 );
 if (
 safeNumber(
 balance?.value
 ) <
 lamports +
 reserveLamports
 ) {
 return {
 ok: false,
 reason:
 "INSUFFICIENT_SOL_BALANCE"
 };
 }
 const execution =
 await executeLiveSwap(
 env,
 WSOL_MINT,
 candidate.mint,
 lamports
 );
 const actualInputUsd =
 safeNumber(
 execution.quote.inAmount
 ) /
 1_000_000_000 *
 solPrice;
 const quantityRaw =
 String(
 execution.quote.outAmount
 );
 const position = {
 id:
 `${candidate.mint}-${execution.transaction.signature}`,
 mint:
 candidate.mint,
 symbol:
 candidate.symbol,
 name:
 candidate.name,
 quantity:
 safeNumber(
 quantityRaw
 ),
 quantity_raw:
 quantityRaw,
 invested_usd:
 actualInputUsd,
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
 nowIso(),
 transaction_signature:
 execution.transaction.signature
 };
 portfolio.cash_usd -=
 actualInputUsd;
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
 "LIVE_BUY",
 mint:
 candidate.mint,
 symbol:
 candidate.symbol,
 price:
 candidate.price,
 amount_usd:
 actualInputUsd,
 quantity_raw:
 quantityRaw,
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
 "ENTRY_ELIGIBLE_HISTORICAL_SETUP",
 transaction_signature:
 execution.transaction.signature
 }
 );
 return {
 ok: true,
 position,
 transaction_signature:
 execution.transaction.signature,
 quoted_input_lamports:
 execution.quote.inAmount,
 quoted_output_raw:
 quantityRaw,
 sol_usd_price:
 solPrice
 };
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
 if (
 !LIVE_BETA_MODE ||
 !TRANSACTION_EXECUTION ||
 PAPER_MODE
 ) {
 throw new Error(
 "LIVE_SELL_GATED"
 );
 }
 const rawAmount =
 String(
 position.quantity_raw ||
 Math.floor(
 position.quantity
 )
 );
 if (
 !/^\d+$/.test(
 rawAmount
 ) ||
 rawAmount === "0"
 ) {
 throw new Error(
 "LIVE_POSITION_QUANTITY_INVALID"
 );
 }
 const solPrice =
 await getSolUsdPrice(
 env
 );
 const execution =
 await executeLiveSwap(
 env,
 candidate.mint,
 WSOL_MINT,
 rawAmount
 );
 const proceedsSol =
 safeNumber(
 execution.quote.outAmount
 ) /
 1_000_000_000;
 const proceeds =
 proceedsSol *
 solPrice;
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
 "LIVE_SELL",
 mint:
 position.mint,
 symbol:
 position.symbol,
 price:
 candidate.price,
 proceeds_usd:
 proceeds,
 proceeds_sol:
 proceedsSol,
 pnl_usd:
 pnl,
 pnl_percent:
 pnlPercent,
 reason,
 transaction_signature:
 execution.transaction.signature
 }
 );
 return {
 ok: true,
 mint:
 position.mint,
 symbol:
 position.symbol,
 price:
 candidate.price,
 proceeds_usd:
 proceeds,
 pnl_usd:
 pnl,
 pnl_percent:
 pnlPercent,
 reason,
 transaction_signature:
 execution.transaction.signature,
 quoted_input_raw:
 execution.quote.inAmount,
 quoted_output_lamports:
 execution.quote.outAmount,
 sol_usd_price:
 solPrice
 };
}
/* ============================================================
 PAPER BUY
 ============================================================ */
function paperBuy(
 portfolio,
 candidate,
 amountUsd
) {
 if (
 amountUsd <= 0
 ) {
 return {
 ok: false,
 reason:
 "INVALID_AMOUNT"
 };
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
 if (
 portfolio.cash_usd -
 MIN_CASH_RESERVE_USD <
 amountUsd
 ) {
 return {
 ok: false,
 reason:
 "INSUFFICIENT_CASH"
 };
 }
 const quantity =
 candidate.price > 0
 ? amountUsd /
 candidate.price
 : 0;
 if (
 quantity <= 0
 ) {
 return {
 ok: false,
 reason:
 "INVALID_QUANTITY"
 };
 }
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
 quantity_raw:
 String(
 Math.floor(
 quantity
 )
 ),
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
 quantity:
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
 candidate,
 reason
) {
 const proceeds =
 safeNumber(
 position.invested_usd
 ) *
 (
 1 +
 safeNumber(
 candidate?.price
 ) > 0 &&
 safeNumber(
 position.entry_price
 ) > 0
 ? (
 safeNumber(
 candidate.price
 ) -
 safeNumber(
 position.entry_price
 )
 ) /
 safeNumber(
 position.entry_price
 )
 : 0
 );
 const pnl =
 proceeds -
 safeNumber(
 position.invested_usd
 );
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
 price:
 candidate?.price ||
 position.current_price,
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
 price:
 candidate?.price ||
 position.current_price,
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
 SCAN PIPELINE
 ============================================================ */
async function scanCandidates(
 env,
 portfolio
) {
 const discoveryDiagnostics =
 createDiscoveryDiagnostics();
 const dexDiscovery =
 await getDexDiscovery();
 Object.assign(
 discoveryDiagnostics.dexscreener_profiles,
 dexDiscovery.diagnostics.dexscreener_profiles
 );
 Object.assign(
 discoveryDiagnostics.dexscreener_boosts,
 dexDiscovery.diagnostics.dexscreener_boosts
 );
 Object.assign(
 discoveryDiagnostics.dexscreener_top_boosts,
 dexDiscovery.diagnostics.dexscreener_top_boosts
 );
 const dexSearch =
 await getDexSearch();
 discoveryDiagnostics.dexscreener_search =
 dexSearch.diagnostics;
 const gecko =
 await getGeckoCandidates();
 discoveryDiagnostics.gecko_trending =
 gecko.diagnostics.gecko_trending;
 discoveryDiagnostics.gecko_top_pools =
 gecko.diagnostics.gecko_top_pools;
 discoveryDiagnostics.gecko_new_pools =
 gecko.diagnostics.gecko_new_pools;
 const discoveredMints =
 unique([
 ...dexDiscovery.results.map(
 item => item.mint
 ),
 ...dexSearch.results.map(
 item => item.mint
 ),
 ...gecko.mints
 ]);
 const sourceMap =
 new Map();
 for (
 const item of
 dexDiscovery.results
 ) {
 const key =
 String(
 item.mint
 ).toLowerCase();
 sourceMap.set(
 key,
 unique([
 ...(sourceMap.get(key) || []),
 item.source
 ])
 );
 }
 for (
 const item of
 dexSearch.results
 ) {
 const key =
 String(
 item.mint
 ).toLowerCase();
 sourceMap.set(
 key,
 unique([
 ...(sourceMap.get(key) || []),
 item.source
 ])
 );
 }
 for (
 const mint of
 gecko.mints
 ) {
 const key =
 String(
 mint
 ).toLowerCase();
 sourceMap.set(
 key,
 unique([
 ...(sourceMap.get(key) || []),
 "GECKOTERMINAL"
 ])
 );
 }
 const limitedMints =
 discoveredMints.slice(
 0,
 MAX_DEX_TOKENS_ANALYZED
 );
 const hydration =
 await hydrateDexTokens(
 limitedMints
 );
 const dexPairs =
 hydration.pairs;
 const dexCandidates =
 [];
 const groupedPairs =
 new Map();
 for (
 const pair of
 dexPairs
 ) {
 const mint =
 pair?.baseToken?.address;
 if (!mint) {
 continue;
 }
 const key =
 String(
 mint
 ).toLowerCase();
 const list =
 groupedPairs.get(key) ||
 [];
 list.push(
 pair
 );
 groupedPairs.set(
 key,
 list
 );
 }
 for (
 const [key, pairs]
 of groupedPairs
 ) {
 const best =
 chooseBestDexPair(
 pairs,
 key
 );
 if (!best.pair) {
 continue;
 }
 const candidate =
 normalizeDexPair(
 best.pair,
 "DEXSCREENER_HYDRATION"
 );
 if (!candidate) {
 continue;
 }
 candidate.source_mints =
 sourceMap.get(
 key
 ) || [];
 candidate.dex_pair_diagnostics =
 best.diagnostics;
 dexCandidates.push(
 candidate
 );
 }
 const searchCandidates =
 [];
 for (
 const pair of
 dexSearch.results
 ) {
 const mint =
 pair.mint;
 const matchingPairs =
 dexPairs.filter(
 p =>
 String(
 p?.baseToken?.address ||
 ""
 ).toLowerCase() ===
 String(
 mint
 ).toLowerCase()
 );
 if (!matchingPairs.length) {
 continue;
 }
 const best =
 chooseBestDexPair(
 matchingPairs,
 mint
 );
 if (!best.pair) {
 continue;
 }
 const candidate =
 normalizeDexPair(
 best.pair,
 "DEXSCREENER_SEARCH"
 );
 if (!candidate) {
 continue;
 }
 searchCandidates.push(
 candidate
 );
 }
 const merged =
 mergeCandidateMaps(
 dexCandidates,
 searchCandidates
 );
 const jupiterDiagnostics = {
 attempted: 0,
 http_status: null,
 response_shape: null,
 requested_mints: [],
 returned_keys: 0,
 usable_prices: 0,
 sample: [],
 error: null
 };
 const jupiterPrices =
 await getJupiterPrices(
 merged.map(
 candidate =>
 candidate.mint
 ),
 jupiterDiagnostics
 );
 const jupiterFallbackDiagnostics = {
 attempted: 0,
 usable_prices: 0,
 results: []
 };
 let fallbackPrices = {};
 const missingJupiterMints =
 merged
 .filter(
 candidate =>
 !(
 Number.isFinite(
 jupiterPrices[
 candidate.mint
 ]
 ) &&
 jupiterPrices[
 candidate.mint
 ] > 0
 )
 )
 .map(
 candidate =>
 candidate.mint
 );
 if (
 Object.keys(
 jupiterPrices
 ).length === 0 &&
 missingJupiterMints.length
 ) {
 fallbackPrices =
 await runJupiterFallback(
 missingJupiterMints,
 jupiterFallbackDiagnostics
 );
 }
 const allJupiterPrices = {
 ...fallbackPrices,
 ...jupiterPrices
 };
 const candidates =
 [];
 for (
 const candidate of
 merged
 ) {
 const jupiterPrice =
 allJupiterPrices[
 candidate.mint
 ];
 candidate.jupiter_price_usd =
 Number.isFinite(
 jupiterPrice
 )
 ? jupiterPrice
 : null;
 if (
 Number.isFinite(
 jupiterPrice
 ) &&
 jupiterPrice > 0 &&
 candidate.price > 0
 ) {
 const divergence =
 Math.abs(
 jupiterPrice -
 candidate.price
 ) /
 candidate.price;
 candidate.jupiter_price_divergence =
 divergence;
 } else {
 candidate.jupiter_price_divergence =
 null;
 }
 const normalized =
 normalizeCandidate(
 portfolio,
 candidate
 );
 recordMarketObservation(
 portfolio,
 normalized
 );
 candidates.push(
 normalized
 );
 }
 cleanupMarketMemory(
 portfolio
 );
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
 discovery:
 discoveryDiagnostics,
 hydration:
 hydration.diagnostics,
 jupiter: {
 batch:
 jupiterDiagnostics,
 fallback:
 jupiterFallbackDiagnostics
 },
 candidate_count:
 candidates.length,
 discovered_mints:
 discoveredMints.length,
 hydrated_pairs:
 dexPairs.length,
 estimated_subrequests:
 3 +
 3 +
 hydration.diagnostics.successful +
 1 +
 (
 jupiterFallbackDiagnostics.attempted
 || 0
 ) +
 1
 }
 };
}
/* ============================================================
 ENGINE
 ============================================================ */
async function runPaperEngine(
 env
) {
 const portfolio =
 await loadPortfolio(
 env
 );
 cleanupCooldowns(
 portfolio
 );
 const scan =
 await scanCandidates(
 env,
 portfolio
 );
 const candidateMap =
 new Map(
 scan.candidates.map(
 candidate => [
 String(
 candidate.mint
 ).toLowerCase(),
 candidate
 ]
 )
 );
 const equityBefore =
 portfolioEquity(
 portfolio,
 candidateMap
 );
 const liveExecution = {
 attempted: 0,
 succeeded: 0,
 failed: 0,
 attempts: [],
 failures: []
 };
 const sells = [];
 const buys = [];
 for (
 const position of
 [...portfolio.positions]
 ) {
 const candidate =
 candidateMap.get(
 String(
 position.mint
 ).toLowerCase()
 );
 if (!candidate) {
 continue;
 }
 markPosition(
 position,
 candidate
 );
 const exit =
 evaluateExit(
 position,
 candidate
 );
 if (!exit.sell) {
 continue;
 }
 if (
 !PAPER_MODE &&
 TRANSACTION_EXECUTION
 ) {
 liveExecution.attempted++;
 try {
 const result =
 await liveSell(
 env,
 portfolio,
 position,
 candidate,
 exit.reason
 );
 liveExecution.succeeded++;
 liveExecution.attempts.push({
 side:
 "SELL",
 mint:
 position.mint,
 symbol:
 position.symbol,
 reason:
 exit.reason,
 transaction_signature:
 result.transaction_signature ||
 null
 });
 sells.push(
 result
 );
 } catch (error) {
 liveExecution.failed++;
 liveExecution.failures.push({
 side:
 "SELL",
 mint:
 position.mint,
 symbol:
 position.symbol,
 reason:
 exit.reason,
 error:
 errorText(error)
 });
 }
 } else {
 const result =
 paperSell(
 portfolio,
 position,
 candidate,
 exit.reason
 );
 sells.push(
 result
 );
 }
 }
 let newBuys =
 0;
 const equity =
 portfolioEquity(
 portfolio,
 candidateMap
 );
 const positionSize =
 getPositionSize(
 equity
 );
 for (
 const candidate of
 scan.candidates
 ) {
 if (
 newBuys >=
 MAX_NEW_BUYS_PER_RUN
 ) {
 break;
 }
 if (
 !candidate.eligible
 ) {
 continue;
 }
 if (
 portfolio.positions.some(
 p =>
 String(
 p.mint
 ).toLowerCase() ===
 String(
 candidate.mint
 ).toLowerCase()
 )
 ) {
 continue;
 }
 if (
 isOnCooldown(
 portfolio,
 candidate.mint
 )
 ) {
 continue;
 }
 const amount =
 Math.min(
 positionSize,
 MAX_PAPER_POSITION_USD
 );
 if (
 amount <= 0
 ) {
 continue;
 }
 if (
 !PAPER_MODE &&
 TRANSACTION_EXECUTION
 ) {
 liveExecution.attempted++;
 try {
 const result =
 await liveBuy(
 env,
 portfolio,
 candidate,
 Math.min(
 amount,
 MAX_LIVE_TRADE_USD
 )
 );
 if (!result.ok) {
 liveExecution.failed++;
 liveExecution.failures.push({
 side:
 "BUY",
 mint:
 candidate.mint,
 symbol:
 candidate.symbol,
 reason:
 result.reason ||
 "LIVE_BUY_REJECTED"
 });
 continue;
 }
 liveExecution.succeeded++;
 liveExecution.attempts.push({
 side:
 "BUY",
 mint:
 candidate.mint,
 symbol:
 candidate.symbol,
 amount_usd:
 result.position
 ?.invested_usd ||
 amount,
 transaction_signature:
 result.transaction_signature ||
 null
 });
 buys.push(
 result
 );
 newBuys++;
 } catch (error) {
 liveExecution.failed++;
 liveExecution.failures.push({
 side:
 "BUY",
 mint:
 candidate.mint,
 symbol:
 candidate.symbol,
 reason:
 "LIVE_BUY_EXCEPTION",
 error:
 errorText(error)
 });
 }
 } else {
 const result =
 paperBuy(
 portfolio,
 candidate,
 amount
 );
 if (
 result.ok
 ) {
 buys.push(
 result
 );
 newBuys++;
 }
 }
 }
 const candidateMapAfter =
 new Map(
 scan.candidates.map(
 candidate => [
 String(
 candidate.mint
 ).toLowerCase(),
 candidate
 ]
 )
 );
 const equityAfter =
 portfolioEquity(
 portfolio,
 candidateMapAfter
 );
 portfolio.last_scan = {
 time:
 nowIso(),
 candidates:
 scan.candidates,
 diagnostics:
 scan.diagnostics
 };
 const persistence =
 await savePortfolio(
 env,
 portfolio,
 liveExecution.succeeded >
 0
 ? "LIVE_TRANSACTION_SUCCESS"
 : (
 checkpointDue(
 portfolio
 )
 ? "CHECKPOINT"
 : "SCAN"
 )
 );
 return {
 ok: true,
 bot:
 BOT_NAME,
 scanner_status:
 "OK",
 mode: {
 type:
 PAPER_MODE
 ? "PAPER"
 : "LIVE",
 transaction_execution:
 TRANSACTION_EXECUTION,
 execution:
 liveBetaExecutionStatus()
 },
 scan: {
 candidate_count:
 scan.candidates.length,
 eligible_count:
 scan.candidates.filter(
 candidate =>
 candidate.eligible
 ).length,
 strongest_candidate:
 scan.candidates[0] ||
 null
 },
 portfolio: {
 cash_usd:
 round(
 portfolio.cash_usd,
 6
 ),
 positions:
 portfolio.positions,
 realized_pnl_usd:
 round(
 portfolio.realized_pnl_usd,
 6
 ),
 equity_before:
 round(
 equityBefore,
 6
 ),
 equity_after:
 round(
 equityAfter,
 6
 )
 },
 trades: {
 buys,
 sells
 },
 execution_diagnostics:
 liveExecution,
 persistence,
 diagnostics:
 scan.diagnostics
 };
}
/* ============================================================
 HTTP AUTHORIZATION
 ============================================================ */
function requireExecutionAuthorization(
 request,
 env
) {
 if (
 !env.LIVE_EXECUTION_TOKEN
 ) {
 throw new Error(
 "MISSING_LIVE_EXECUTION_TOKEN"
 );
 }
 const authorization =
 request.headers.get(
 "authorization"
 ) || "";
 const expected =
 `Bearer ${env.LIVE_EXECUTION_TOKEN}`;
 if (
 authorization !==
 expected
 ) {
 throw new Error(
 "UNAUTHORIZED_LIVE_EXECUTION_REQUEST"
 );
 }
}
/* ============================================================
 RESET
 ============================================================ */
async function resetPortfolio(
 env
) {
 const portfolio =
 createEmptyPortfolio();
 await env.BOT_KV.put(
 "LIVE_BETA_PORTFOLIO",
 JSON.stringify(
 portfolio
 )
 );
 return {
 ok: true,
 reset: true,
 portfolio
 };
}
/* ============================================================
 HTTP HANDLER
 ============================================================ */
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
 path === "/health"
 ) {
 return Response.json({
 ok: true,
 bot:
 BOT_NAME,
 scanner_status:
 "OK",
 mode:
 liveBetaExecutionStatus(),
 time:
 nowIso()
 });
 }
 if (
 path === "/status"
 ) {
 const portfolio =
 await loadPortfolio(
 env
 );
 return Response.json({
 ok: true,
 bot:
 BOT_NAME,
 mode:
 liveBetaExecutionStatus(),
 portfolio: {
 cash_usd:
 round(
 portfolio.cash_usd,
 6
 ),
 positions:
 portfolio.positions,
 realized_pnl_usd:
 round(
 portfolio.realized_pnl_usd,
 6
 ),
 history_count:
 portfolio.history.length
 },
 time:
 nowIso()
 });
 }
 if (
 path === "/scan"
 ) {
 const portfolio =
 await loadPortfolio(
 env
 );
 const scan =
 await scanCandidates(
 env,
 portfolio
 );
 return Response.json({
 ok: true,
 bot:
 BOT_NAME,
 mode:
 liveBetaExecutionStatus(),
 scanner_status:
 "OK",
 scan,
 time:
 nowIso()
 });
 }
 if (
 path === "/run"
 ) {
 if (
 !PAPER_MODE &&
 TRANSACTION_EXECUTION
 ) {
 requireExecutionAuthorization(
 request,
 env
 );
 }
 const result =
 await runPaperEngine(
 env
 );
 return Response.json(
 result
 );
 }
 if (
 path === "/reset"
 ) {
 if (
 !PAPER_MODE &&
 TRANSACTION_EXECUTION
 ) {
 requireExecutionAuthorization(
 request,
 env
 );
 }
 return Response.json(
 await resetPortfolio(
 env
 )
 );
 }
 return new Response(
 "Not found",
 {
 status: 404
 }
 );
}
/* ============================================================
 CRON
 ============================================================ */
async function handleScheduled(
 event,
 env,
 ctx
) {
 ctx.waitUntil(
 (async () => {
 try {
 await runPaperEngine(
 env
 );
 } catch (error) {
 try {
 await env.BOT_KV.put(
 "LIVE_BETA_LAST_ERROR",
 JSON.stringify({
 time:
 nowIso(),
 error:
 errorText(error)
 })
 );
 } catch {
 // Ignore secondary KV failure.
 }
 }
 })()
 );
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
 return Response.json(
 {
 ok: false,
 bot:
 BOT_NAME,
 error:
 errorText(error),
 time:
 nowIso()
 },
 {
 status:
 500
 }
 );
 }
 },
 async scheduled(
 event,
 env,
 ctx
 ) {
 await handleScheduled(
 event,
 env,
 ctx
 );
 }
};}
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

function base64ToBytes(value) {
 const binary = atob(value);
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
 const response = await fetch(env.SOLANA_RPC_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
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
 const result = await fetchJsonDiagnostic(`${LIVE_QUOTE_API}/swap`, { method: "POST", headers, body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }) });
 if (!result.ok) throw new Error(`JUPITER_SWAP_BUILD_FAILED: ${result.error}`);
 if (!result.data?.swapTransaction) throw new Error("JUPITER_SWAP_TRANSACTION_MISSING");
 return result.data.swapTransaction;
}

async function broadcastAndConfirmLiveTransaction(env, unsignedTransactionBase64) {
 const signed = await signSolanaTransaction(unsignedTransactionBase64, env);
 const signature = await solanaRpc(env, "sendTransaction", [signed.transactionBase64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2 }]);
 const started = Date.now();
 while (Date.now() - started < 45000) {
  const statuses = await solanaRpc(env, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
  const status = statuses?.value?.[0];
  if (status?.err) throw new Error(`LIVE_TRANSACTION_FAILED:${JSON.stringify(status.err)}`);
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return { signature, confirmation_status: status.confirmationStatus, slot: status.slot ?? null, wallet_public_key: signed.publicKey };
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
async function liveBuy(env, portfolio, candidate) {
 if (PAPER_MODE || !TRANSACTION_EXECUTION || !LIVE_BETA_MODE) throw new Error("LIVE_BUY_BLOCKED");
 if (portfolio.positions.length >= MAX_POSITIONS) throw new Error("MAX_POSITIONS_REACHED");
 if (candidate.price <= 0) throw new Error("LIVE_BUY_INVALID_PRICE");
 const solPrice = await getSolUsdPrice(env);
 if (!solPrice || solPrice <= 0) throw new Error("LIVE_SOL_PRICE_UNAVAILABLE");
 const tradeUsd = Math.min(MAX_LIVE_TRADE_USD, getPositionSize(portfolio.equity_usd));
 if (tradeUsd <= 0) throw new Error("LIVE_BUY_INVALID_TRADE_SIZE");
 if (portfolio.cash_usd - tradeUsd < MIN_CASH_RESERVE_USD) throw new Error("LIVE_BUY_CASH_RESERVE");
 const solNeeded = tradeUsd / solPrice;
 if (portfolio.live_sol_balance != null && portfolio.live_sol_balance < solNeeded + LIVE_MIN_SOL_RESERVE) throw new Error("LIVE_BUY_SOL_RESERVE");
 const lamports = Math.floor(solNeeded * 1e9);
 if (lamports <= 0) throw new Error("LIVE_BUY_ZERO_LAMPORTS");
 const execution = await executeLiveSwap(env, SOL_MINT, candidate.mint, lamports);
 const outputRaw = String(execution.quote.outAmount || "");
 if (!/^\d+$/.test(outputRaw) || Number(outputRaw) <= 0) throw new Error("LIVE_BUY_INVALID_OUTPUT_AMOUNT");
 const tokenDecimals = Number.isFinite(candidate.token_decimals) ? candidate.token_decimals : 6;
 const quantity = Number(outputRaw) / Math.pow(10, tokenDecimals);
 if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("LIVE_BUY_INVALID_TOKEN_QUANTITY");
 portfolio.cash_usd = Math.max(0, portfolio.cash_usd - tradeUsd);
 portfolio.positions.push({
  mint: candidate.mint,
  symbol: candidate.symbol,
  quantity,
  token_decimals: tokenDecimals,
  entry_price: candidate.price,
  current_price: candidate.price,
  invested_usd: tradeUsd,
  pnl_usd: 0,
  pnl_percent: 0,
  peak_price: candidate.price,
  trailing_active: false,
  reversal_confirmations: 0,
  entry_score: candidate.score,
  entry_setup_score: candidate.setup_score,
  entry_setup_confirmed: candidate.setup_confirmed,
  entry_history_observations: candidate.history_observations,
  entry_time: Date.now(),
  source: candidate.source,
  live: true,
  transaction_signature: execution.transaction.signature,
  transaction_confirmation_status: execution.transaction.confirmation_status,
  transaction_slot: execution.transaction.slot,
  entry_sol_amount: solNeeded,
  entry_raw_amount: outputRaw
 });
 return {
  symbol: candidate.symbol,
  mint: candidate.mint,
  amount_usd: tradeUsd,
  quantity,
  transaction_signature: execution.transaction.signature,
  confirmation_status: execution.transaction.confirmation_status,
  quote_out_amount_raw: outputRaw
 };
}

/* ============================================================
 LIVE SELL
 ============================================================ */
async function liveSell(env, portfolio, position, reason) {
 if (PAPER_MODE || !TRANSACTION_EXECUTION || !LIVE_BETA_MODE) throw new Error("LIVE_SELL_BLOCKED");
 const rawAmount = String(position.entry_raw_amount || "");
 if (!/^\d+$/.test(rawAmount) || Number(rawAmount) <= 0) throw new Error("LIVE_SELL_INVALID_RAW_AMOUNT");
 const execution = await executeLiveSwap(env, position.mint, SOL_MINT, Number(rawAmount));
 const outLamports = String(execution.quote.outAmount || "");
 if (!/^\d+$/.test(outLamports) || Number(outLamports) <= 0) throw new Error("LIVE_SELL_INVALID_OUTPUT_AMOUNT");
 const solPrice = await getSolUsdPrice(env);
 const proceedsSol = Number(outLamports) / 1e9;
 const proceedsUsd = proceedsSol * solPrice;
 const pnl = proceedsUsd - position.invested_usd;
 portfolio.cash_usd += proceedsUsd;
 return {
  symbol: position.symbol,
  mint: position.mint,
  amount_usd: proceedsUsd,
  pnl_usd: pnl,
  reason,
  transaction_signature: execution.transaction.signature,
  confirmation_status: execution.transaction.confirmation_status,
  quote_out_amount_raw: outLamports
 };
}
/* ============================================================
 PAPER / LIVE ENGINE
 ============================================================ */
async function runPaperEngine(
 env
){
 const beforeRun =
 deepClone(
 await loadPortfolio(
 env
 )
 );
 const portfolio =
 deepClone(
 beforeRun
 );
 const scanResult =
 await buildCandidates(
 env
 );
 const candidates =
 scanResult.candidates;
 const accountingBefore =
 calculateAccountingCheck(
 portfolio
 );
 const sells = [];
 const buys = [];
 const blockedSells = [];
 const liveExecution = {
 attempted: 0,
 succeeded: 0,
 failed: 0,
 attempts: [],
 failures: []
 };
 const now =
 Date.now();
 const openMints =
 new Set(
 portfolio.positions.map(
 position => position.mint
 )
 );
 let importantStateChanged =
 false;
 let noTradeReason =
 "NO_ELIGIBLE_SETUP";
 const priceMap =
 new Map(
 candidates.map(
 candidate => [
 candidate.mint,
 candidate.price
 ]
 )
 );
 for (
 const position of portfolio.positions
 ){
 const candidatePrice =
 priceMap.get(
 position.mint
 );
 if (
 Number.isFinite(
 candidatePrice
 ) &&
 candidatePrice > 0
 ){
 position.current_price =
 candidatePrice;
 if (
 candidatePrice >
 position.peak_price
 ){
 position.peak_price =
 candidatePrice;
 }
 position.pnl_usd =
 (
 position.current_price -
 position.entry_price
 ) *
 position.quantity;
 position.pnl_percent =
 position.entry_price > 0
 ? (
 (position.current_price -
 position.entry_price) /
 position.entry_price
 )
 : 0;
 if (
 !position.trailing_active &&
 position.pnl_percent >=
 TRAILING_ACTIVATION
 ){
 position.trailing_active =
 true;
 }
 }
 }
 const markBefore =
 markPortfolio(
 portfolio,
 candidates
 );
 const sellCandidates =
 portfolio.positions
 .map(
 position => {
 const pnlPct =
 position.pnl_percent ||
 0;
 const trailingTrigger =
 position.trailing_active &&
 position.current_price <=
 position.peak_price *
 (1 -
 TRAILING_STOP);
 const stopTrigger =
 pnlPct <=
 STOP_LOSS;
 const reversalSignal =
 shouldSellOnReversal(
 position,
 candidates
 );
 const shouldSell =
 stopTrigger ||
 trailingTrigger ||
 reversalSignal;
 return {
 position,
 stopTrigger,
 trailingTrigger,
 reversalSignal,
 shouldSell
 };
 }
 )
 .filter(
 item =>
 item.shouldSell
 );
 for (
 const item of sellCandidates
 ){
 const position =
 item.position;
 const reason =
 item.stopTrigger
 ? "STOP_LOSS"
 : item.trailingTrigger
 ? "TRAILING_STOP"
 : "REVERSAL";
 if (
 PAPER_MODE
 ){
 const proceeds =
 position.quantity *
 position.current_price;
 const pnl =
 proceeds -
 position.invested_usd;
 portfolio.cash_usd +=
 proceeds;
 const index =
 portfolio.positions.indexOf(
 position
 );
 if (
 index >= 0
 ){
 portfolio.positions.splice(
 index,
 1
 );
 }
 sells.push({
 symbol:
 position.symbol,
 mint:
 position.mint,
 amount_usd:
 proceeds,
 pnl_usd:
 pnl,
 reason,
 paper:
 true
 });
 importantStateChanged =
 true;
 openMints.delete(
 position.mint
 );
 } else {
 liveExecution.attempted++;
 try {
 const result =
 await liveSell(
 env,
 portfolio,
 position,
 reason
 );
 const index =
 portfolio.positions.indexOf(
 position
 );
 if (
 index >= 0
 ){
 portfolio.positions.splice(
 index,
 1
 );
 }
 sells.push({
 ...result,
 live:
 true
 });
 liveExecution.succeeded++;
 liveExecution.attempts.push({
  action:
  "SELL",
  symbol:
  position.symbol,
  mint:
  position.mint,
  transaction_signature:
  result.transaction_signature,
  reason
 });
 importantStateChanged =
 true;
 openMints.delete(
 position.mint
 );
 } catch (
 error
 ){
 liveExecution.failed++;
 const failure = {
  action:
  "SELL",
  symbol:
  position.symbol,
  mint:
  position.mint,
  reason,
  error:
  errorText(error)
 };
 liveExecution.failures.push(
  failure
 );
 blockedSells.push(
  failure
 );
 }
 }
 }
 const markAfterSells =
 markPortfolio(
 portfolio,
 candidates
 );
 const eligible =
 candidates
 .filter(
 candidate =>
 candidate.eligible &&
 !openMints.has(
 candidate.mint
 )
 )
 .sort(
 (a, b) =>
 b.score -
 a.score
 );
 let buysAllowed =
 Math.max(
 0,
 MAX_NEW_BUYS_PER_RUN
 );
 if (
 portfolio.positions.length >=
 MAX_POSITIONS
 ){
 buysAllowed = 0;
 }
 if (
 eligible.length > 0 &&
 buysAllowed > 0
 ){
 noTradeReason =
 "BUY_ELIGIBLE";
 } else if (
 eligible.length === 0
 ){
 noTradeReason =
 "NO_ELIGIBLE_SETUP";
 } else if (
 buysAllowed === 0
 ){
 noTradeReason =
 "BUY_LIMIT_REACHED";
 }
 for (
 const candidate of eligible
 ){
 if (
 buysAllowed <= 0
 ) break;
 if (
 portfolio.positions.length >=
 MAX_POSITIONS
 ) break;
 const estimatedTradeUsd =
 Math.min(
 MAX_LIVE_TRADE_USD,
 getPositionSize(
 markAfterSells.equity_usd
 )
 );
 if (
 portfolio.cash_usd -
 estimatedTradeUsd <
 MIN_CASH_RESERVE_USD
 ){
 noTradeReason =
 "CASH_RESERVE";
 continue;
 }
 if (
 PAPER_MODE
 ){
 const tradeUsd =
 Math.min(
 MAX_PAPER_POSITION_USD,
 getPositionSize(
 markAfterSells.equity_usd
 )
 );
 if (
 tradeUsd <= 0
 ){
 noTradeReason =
 "INVALID_POSITION_SIZE";
 continue;
 }
 portfolio.cash_usd -=
 tradeUsd;
 const quantity =
 candidate.price > 0
 ? tradeUsd /
 candidate.price
 : 0;
 portfolio.positions.push({
 mint:
 candidate.mint,
 symbol:
 candidate.symbol,
 quantity,
 token_decimals:
 candidate.token_decimals,
 entry_price:
 candidate.price,
 current_price:
 candidate.price,
 invested_usd:
 tradeUsd,
 pnl_usd:
 0,
 pnl_percent:
 0,
 peak_price:
 candidate.price,
 trailing_active:
 false,
 reversal_confirmations:
 0,
 entry_score:
 candidate.score,
 entry_setup_score:
 candidate.setup_score,
 entry_setup_confirmed:
 candidate.setup_confirmed,
 entry_history_observations:
 candidate.history_observations,
 entry_time:
 Date.now(),
 source:
 candidate.source
 });
 buys.push({
 symbol:
 candidate.symbol,
 mint:
 candidate.mint,
 amount_usd:
 tradeUsd,
 price:
 candidate.price,
 score:
 candidate.score,
 paper:
 true
 });
 importantStateChanged =
 true;
 openMints.add(
 candidate.mint
 );
 buysAllowed--;
 } else {
 liveExecution.attempted++;
 try {
 const result =
 await liveBuy(
 env,
 portfolio,
 candidate
 );
 buys.push({
 ...result,
 price:
 candidate.price,
 score:
 candidate.score,
 live:
 true
 });
 liveExecution.succeeded++;
 liveExecution.attempts.push({
  action:
  "BUY",
  symbol:
  candidate.symbol,
  mint:
  candidate.mint,
  transaction_signature:
  result.transaction_signature
 });
 importantStateChanged =
 true;
 openMints.add(
 candidate.mint
 );
 buysAllowed--;
 } catch (
 error
 ){
 liveExecution.failed++;
 const failure = {
  action:
  "BUY",
  symbol:
  candidate.symbol,
  mint:
  candidate.mint,
  error:
  errorText(error)
 };
 liveExecution.failures.push(
  failure
 );
 }
 }
 }
 const mark =
 markPortfolio(
 portfolio,
 candidates
 );
 const accounting =
 calculateAccountingCheck(
 portfolio
 );
 const checkpoint =
 now -
 (
 portfolio.last_persist_at ||
 0
 ) >=
 CHECKPOINT_INTERVAL_SECONDS *
 1000;
 const persistenceReady =
 canPersistNow(
 portfolio
 );
 let persistence = {
 attempted:
 false,
 saved:
 false,
 throttled:
 false,
 reason:
 "NO_PERSIST_REQUIRED"
 };
 if (
 importantStateChanged &&
 !accounting.ok
 ){
 const errorTextValue =
 accounting.errors.join(
 ","
 );
 if (
 PAPER_MODE
 ){
 restoreObject(
 portfolio,
 beforeRun
 );
 throw new Error(
 `PAPER_ACCOUNTING_INVARIANT_FAILED:${errorTextValue}`
 );
 }
 persistence = {
  attempted:
  false,
  saved:
  false,
  throttled:
  false,
  reason:
  "LIVE_ACCOUNTING_INVARIANT_FAILED_AFTER_EXECUTION",
  error:
  errorTextValue
 };
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
 } catch (
 error
 ){
 if (
 PAPER_MODE
 ){
 restoreObject(
 portfolio,
 beforeRun
 );
 throw new Error(
 `PAPER_TRADE_PERSISTENCE_FAILED: ${errorText(error)}`
 );
 }
 persistence = {
  attempted: true,
  saved: false,
  throttled: false,
  reason: "LIVE_TRADE_PERSISTENCE_FAILED_AFTER_BROADCAST",
  error: errorText(error)
 };
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
   execution:
   liveBetaExecutionStatus()
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
  markPortfolio,
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
  mode: {
   type:
   PAPER_MODE ? "PAPER" : "LIVE",
   transaction_execution:
   TRANSACTION_EXECUTION,
   execution:
   liveBetaExecutionStatus()
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
      memory.observations.length - 1
     ]
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
   execution:
   liveBetaExecutionStatus()
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
 if (!crypto.subtle.timingSafeEqual(providedBytes, expectedBytes)) throw new Error("UNAUTHORIZED_LIVE_EXECUTION_REQUEST");
}

/* ============================================================
 HTTP ROUTER
 ============================================================ */
export default {
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
      type: PAPER_MODE ? "PAPER" : "LIVE",
      transaction_execution:
      TRANSACTION_EXECUTION,
      execution:
      liveBetaExecutionStatus()
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
