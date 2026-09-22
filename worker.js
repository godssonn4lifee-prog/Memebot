const LIVE_TRADING = true;

// ===============================
// TRADING SETTINGS
// ===============================

const PROFIT_TARGET = 0.015;       // +1.5%
const STOP_LOSS = -0.01;           // -1%

const SMALL_TRADE_CAP_USD = 2;     // Under $20 wallet value
const LARGE_TRADE_CAP_USD = 5;     // $20+ wallet value
const BALANCE_THRESHOLD_USD = 20;

const MIN_SOL_RESERVE = 0.01;

// Reject a token if an immediate buy -> sell round trip
// would lose more than 0.5%.
const MAX_ROUND_TRIP_LOSS = 0.005;

const MIN_LIQUIDITY_USD = 25000;

const MAX_CANDIDATES = 5;

const RATE_LIMIT_COOLDOWN_MS = 120000;
const SCAN_COOLDOWN_MS = 60000;

// ===============================
// API ENDPOINTS
// ===============================

const SWAP_API = "https://api.jup.ag/swap/v2";
const TOKEN_API = "https://api.jup.ag/tokens/v2";
const PRICE_API = "https://api.jup.ag/price/v3";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const WALLET_ADDRESS =
  "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

// ===============================
// WORKER
// ===============================

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        return json({
          ok: true,
          bot: "memebott",
          live_trading: LIVE_TRADING,
          message: "Memebott is running."
        });
      }

      if (url.pathname === "/status") {
        return await getStatus(env);
      }

      if (url.pathname === "/run") {
        return await runBot(env, true);
      }

      return json({
        ok: false,
        error: "Not found"
      }, 404);

    } catch (error) {
      return json({
        ok: false,
        error: error?.message || String(error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBot(env, false)
        .catch(error => {
          console.error("Scheduled bot error:", error);
        })
    );
  }
};

// ===============================
// MAIN BOT
// ===============================

async function runBot(env, manual = false) {
  const validation = validateSecrets(env);

  if (!validation.ok) {
    return json({
      ok: false,
      error: validation.error
    }, 500);
  }

  const wallet = await getWalletInfo(env);

  // Always manage an existing position first.
  const position = await getPosition(env);

  if (position) {
    return await managePosition(env, wallet, position);
  }

  // Don't repeatedly hit Jupiter if it recently rate-limited us.
  const cooldown = await getCooldown(env);

  if (cooldown > Date.now()) {
    return json({
      ok: true,
      action: "COOLDOWN",
      seconds_remaining: Math.ceil(
        (cooldown - Date.now()) / 1000
      )
    });
  }

  // Prevent repeated scans during the same minute.
  const lastScan = await getLastScan(env);

  if (!manual && lastScan > Date.now() - SCAN_COOLDOWN_MS) {
    return json({
      ok: true,
      action: "SCAN_COOLDOWN"
    });
  }

  await setLastScan(env);

  return await findAndBuy(env, wallet);
}

// ===============================
// FIND AND BUY
// ===============================

async function findAndBuy(env, wallet) {
  const solBalance = wallet.solBalance;

  if (solBalance <= MIN_SOL_RESERVE) {
    return json({
      ok: true,
      action: "NO_TRADE",
      reason: "Not enough SOL after reserve.",
      sol_balance: solBalance
    });
  }

  const solPriceUsd = await getUsdPrice(env, SOL_MINT);

  if (!solPriceUsd || solPriceUsd <= 0) {
    return json({
      ok: false,
      error: "Could not determine SOL price."
    }, 500);
  }

  const walletValueUsd = solBalance * solPriceUsd;

  // ===============================
  // DYNAMIC TRADE CAP
  // ===============================

  const maxTradeUsd =
    walletValueUsd >= BALANCE_THRESHOLD_USD
      ? LARGE_TRADE_CAP_USD
      : SMALL_TRADE_CAP_USD;

  const availableSol =
    Math.max(0, solBalance - MIN_SOL_RESERVE);

  const availableUsd =
    availableSol * solPriceUsd;

  const tradeUsd =
    Math.min(maxTradeUsd, availableUsd);

  if (tradeUsd <= 0) {
    return json({
      ok: true,
      action: "NO_TRADE",
      reason: "Available trade balance is too small.",
      sol_balance: solBalance,
      wallet_value_usd: walletValueUsd,
      max_trade_usd: maxTradeUsd
    });
  }

  const tradeLamports = Math.floor(
    (tradeUsd / solPriceUsd) * 1_000_000_000
  );

  if (tradeLamports <= 0) {
    return json({
      ok: true,
      action: "NO_TRADE",
      reason: "Trade amount rounded to zero."
    });
  }

  let candidate;

  try {
    candidate = await selectCandidate(
      env,
      tradeLamports
    );
  } catch (error) {
    if (isRateLimitError(error)) {
      await setCooldown(
        env,
        Date.now() + RATE_LIMIT_COOLDOWN_MS
      );
    }

    throw error;
  }

  if (!candidate) {
    return json({
      ok: true,
      action: "NO_TRADE",
      reason: "No suitable token found.",
      wallet_value_usd: walletValueUsd,
      max_trade_usd: maxTradeUsd
    });
  }

  if (!LIVE_TRADING) {
    return json({
      ok: true,
      action: "PAPER_BUY",
      token: candidate.symbol,
      mint: candidate.mint,
      trade_usd: tradeUsd,
      wallet_value_usd: walletValueUsd,
      max_trade_usd: maxTradeUsd
    });
  }

  const order = await getOrder(
    env,
    SOL_MINT,
    candidate.mint,
    tradeLamports
  );

  if (!order) {
    return json({
      ok: false,
      error: "Jupiter did not return a buy order."
    }, 500);
  }

  const executed = await executeOrder(env, order);

  if (!executed || !executed.signature) {
    return json({
      ok: false,
      error: "Buy transaction was not confirmed.",
      result: executed
    }, 500);
  }

  const position = {
    mint: candidate.mint,
    symbol: candidate.symbol || "UNKNOWN",
    entrySol: Number(
      order.inAmount
        ? Number(order.inAmount) / 1_000_000_000
        : tradeLamports / 1_000_000_000
    ),
    entryUsd: tradeUsd,
    buySignature: executed.signature,
    createdAt: Date.now()
  };

  await savePosition(env, position);

  return json({
    ok: true,
    action: "BOUGHT",
    token: position.symbol,
    mint: position.mint,
    entry_sol: position.entrySol,
    entry_usd: position.entryUsd,
    wallet_value_usd: walletValueUsd,
    max_trade_usd: maxTradeUsd,
    profit_target: "1.5%",
    stop_loss: "-1%",
    signature: executed.signature
  });
}

// ===============================
// MANAGE EXISTING POSITION
// ===============================

async function managePosition(env, wallet, position) {
  const tokenBalance = await getTokenBalance(
    env,
    position.mint
  );

  if (!tokenBalance || tokenBalance.amount <= 0) {
    return json({
      ok: false,
      action: "POSITION_ERROR",
      reason: "Token balance not found."
    }, 500);
  }

  const quote = await getOrder(
    env,
    position.mint,
    SOL_MINT,
    tokenBalance.rawAmount
  );

  if (!quote) {
    return json({
      ok: false,
      action: "QUOTE_ERROR",
      token: position.symbol
    }, 500);
  }

  const currentSol =
    Number(quote.outAmount) / 1_000_000_000;

  const entrySol =
    Number(position.entrySol);

  if (!entrySol || entrySol <= 0) {
    return json({
      ok: false,
      action: "POSITION_ERROR",
      reason: "Invalid entry SOL amount."
    }, 500);
  }

  const change =
    (currentSol - entrySol) / entrySol;

  const changePercent =
    change * 100;

  // TAKE PROFIT
  if (change >= PROFIT_TARGET) {
    return await sellPosition(
      env,
      position,
      tokenBalance,
      "TAKE_PROFIT",
      currentSol,
      changePercent
    );
  }

  // STOP LOSS
  if (change <= STOP_LOSS) {
    return await sellPosition(
      env,
      position,
      tokenBalance,
      "STOP_LOSS",
      currentSol,
      changePercent
    );
  }

  return json({
    ok: true,
    action: "HOLDING_TOKEN",
    token: position.symbol,
    mint: position.mint,
    entry_sol: entrySol,
    current_sol: currentSol,
    change_percent: Number(
      changePercent.toFixed(4)
    ),
    take_profit_percent: 1.5,
    stop_loss_percent: -1
  });
}

// ===============================
// SELL POSITION
// ===============================

async function sellPosition(
  env,
  position,
  tokenBalance,
  reason,
  currentSol,
  changePercent
) {
  if (!LIVE_TRADING) {
    await clearPosition(env);

    return json({
      ok: true,
      action: "PAPER_SELL",
      reason,
      token: position.symbol,
      current_sol: currentSol,
      change_percent: changePercent
    });
  }

  const order = await getOrder(
    env,
    position.mint,
    SOL_MINT,
    tokenBalance.rawAmount
  );

  if (!order) {
    return json({
      ok: false,
      action: "SELL_QUOTE_ERROR",
      token: position.symbol
    }, 500);
  }

  const executed = await executeOrder(
    env,
    order
  );

  if (!executed || !executed.signature) {
    return json({
      ok: false,
      action: "SELL_ERROR",
      reason,
      token: position.symbol,
      result: executed
    }, 500);
  }

  await clearPosition(env);

  return json({
    ok: true,
    action: "SOLD",
    reason,
    token: position.symbol,
    mint: position.mint,
    entry_sol: position.entrySol,
    exit_sol: currentSol,
    change_percent: Number(
      changePercent.toFixed(4)
    ),
    signature: executed.signature
  });
}

// ===============================
// TOKEN SELECTION
// ===============================

async function selectCandidate(env, tradeLamports) {
  const tokens = await getTrendingTokens(env);

  if (!tokens.length) {
    return null;
  }

  const unique = [];
  const seen = new Set();

  for (const token of tokens) {
    const mint = token.address || token.mint;

    if (!mint) continue;
    if (mint === SOL_MINT) continue;

    if (seen.has(mint)) continue;

    seen.add(mint);
    unique.push(token);
  }

  const filtered = unique
    .filter(token => {
      const mint = token.address || token.mint;

      if (!mint) return false;

      const liquidity =
        Number(
          token.liquidity ??
          token.liquidityUsd ??
          token.liquidityUSD ??
          0
        );

      if (
        liquidity > 0 &&
        liquidity < MIN_LIQUIDITY_USD
      ) {
        return false;
      }

      const symbol =
        String(
          token.symbol ||
          token.name ||
          ""
        ).toUpperCase();

      if (
        symbol === "SOL" ||
        symbol === "USDC" ||
        symbol === "USDT"
      ) {
        return false;
      }

      return true;
    })
    .slice(0, MAX_CANDIDATES);

  if (!filtered.length) {
    return null;
  }

  let prices = {};

  try {
    prices = await getPrices(
      env,
      filtered.map(
        token => token.address || token.mint
      )
    );
  } catch (error) {
    console.error(
      "Price lookup error:",
      error?.message || error
    );
  }

  const candidates = [];

  for (const token of filtered) {
    const mint =
      token.address || token.mint;

    const priceData =
      prices[mint];

    const price =
      Number(
        priceData?.usdPrice ??
        priceData?.price ??
        0
      );

    const liquidity =
      Number(
        token.liquidity ??
        token.liquidityUsd ??
        token.liquidityUSD ??
        0
      );

    const organicScore =
      Number(
        token.organicScore ??
        token.organic_score ??
        0
      );

    const momentum =
      Number(
        token.momentum ??
        token.stats5m?.priceChange ??
        token.stats1h?.priceChange ??
        0
      );

    const score =
      organicScore +
      Math.log10(
        Math.max(liquidity, 1)
      ) +
      momentum;

    candidates.push({
      ...token,
      mint,
      price,
      liquidity,
      organicScore,
      momentum,
      score
    });
  }

  candidates.sort(
    (a, b) => b.score - a.score
  );

  // Only test the two strongest candidates
  // with actual Jupiter round-trip quotes.
  const testCandidates =
    candidates.slice(0, 2);

  for (const candidate of testCandidates) {
    try {
      const buyOrder = await getOrder(
        env,
        SOL_MINT,
        candidate.mint,
        tradeLamports
      );

      if (!buyOrder) {
        continue;
      }

      const tokenOut =
        buyOrder.outAmount;

      if (!tokenOut || Number(tokenOut) <= 0) {
        continue;
      }

      const sellOrder = await getOrder(
        env,
        candidate.mint,
        SOL_MINT,
        tokenOut
      );

      if (!sellOrder) {
        continue;
      }

      const sellSol =
        Number(sellOrder.outAmount) /
        1_000_000_000;

      const buySol =
        Number(tradeLamports) /
        1_000_000_000;

      if (buySol <= 0) {
        continue;
      }

      const roundTripChange =
        (sellSol - buySol) / buySol;

      if (
        roundTripChange <
        -MAX_ROUND_TRIP_LOSS
      ) {
        continue;
      }

      candidate.roundTripChange =
        roundTripChange;

      return candidate;

    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }

      console.error(
        "Candidate test error:",
        error?.message || error
      );
    }
  }

  return null;
}

// ===============================
// JUPITER TRENDING TOKENS
// ===============================

async function getTrendingTokens(env) {
  const endpoints = [
    "/toptrending/5m",
    "/toptrending/1h",
    "/toptraded/1h"
  ];

  const all = [];

  for (const endpoint of endpoints) {
    try {
      const data =
        await jupiterFetch(
          env,
          TOKEN_API + endpoint
        );

      if (Array.isArray(data)) {
        all.push(...data);
      } else if (
        Array.isArray(data?.tokens)
      ) {
        all.push(...data.tokens);
      } else if (
        Array.isArray(data?.data)
      ) {
        all.push(...data.data);
      }

    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }

      console.error(
        "Trending endpoint error:",
        endpoint,
        error?.message || error
      );
    }
  }

  return all;
}

// ===============================
// PRICE API
// ===============================

async function getPrices(env, mints) {
  if (!mints.length) {
    return {};
  }

  const ids = mints.join(",");

  const data =
    await jupiterFetch(
      env,
      `${PRICE_API}?ids=${encodeURIComponent(ids)}`
    );

  return data?.data || data || {};
}

async function getUsdPrice(env, mint) {
  const prices =
    await getPrices(env, [mint]);

  const item =
    prices[mint];

  return Number(
    item?.usdPrice ??
    item?.price ??
    0
  );
}

// ===============================
// JUPITER SWAP API
// ===============================

async function getOrder(
  env,
  inputMint,
  outputMint,
  amount
) {
  const url =
    `${SWAP_API}/order` +
    `?inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&taker=${encodeURIComponent(WALLET_ADDRESS)}`;

  return await jupiterFetch(
    env,
    url,
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}

async function executeOrder(env, order) {
  const transaction =
    order?.transaction ||
    order?.swapTransaction;

  if (!transaction) {
    throw new Error(
      "Jupiter order did not contain a transaction."
    );
  }

  const privateKey =
    env.WALLET_PRIVATE_KEY;

  const signer =
    await importPrivateKey(privateKey);

  const transactionBytes =
    base64ToBytes(transaction);

  const signedBytes =
    await crypto.subtle.sign(
      {
        name: "Ed25519"
      },
      signer,
      transactionBytes
    );

  const signedTransaction =
    replaceSignature(
      transactionBytes,
      new Uint8Array(signedBytes)
    );

  const rpcResponse =
    await fetch(
      "https://mainnet.helius-rpc.com/?api-key=" +
      encodeURIComponent(env.HELIUS_API_KEY),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          params: [
            bytesToBase64(signedTransaction),
            {
              encoding: "base64",
              skipPreflight: false,
              maxRetries: 3
            }
          ]
        })
      }
    );

  const result =
    await rpcResponse.json();

  if (result?.error) {
    throw new Error(
      result.error.message ||
      JSON.stringify(result.error)
    );
  }

  return {
    signature: result.result
  };
}

// ===============================
// JUPITER FETCH
// ===============================

async function jupiterFetch(
  env,
  url,
  options = {},
  attempt = 0
) {
  const headers = {
    ...(options.headers || {}),
    "x-api-key": env.JUPITER_API_KEY
  };

  const response =
    await fetch(url, {
      ...options,
      headers
    });

  if (response.status === 429) {
    if (attempt < 2) {
      const delay =
        3000 * Math.pow(2, attempt);

      await sleep(delay);

      return await jupiterFetch(
        env,
        url,
        options,
        attempt + 1
      );
    }

    const error =
      new Error(
        "Jupiter API rate limit reached."
      );

    error.status = 429;

    throw error;
  }

  if (!response.ok) {
    const text =
      await response.text();

    const error =
      new Error(
        `Jupiter API error ${response.status}: ${text}`
      );

    error.status =
      response.status;

    throw error;
  }

  return await response.json();
}

// ===============================
// WALLET / BALANCES
// ===============================

async function getWalletInfo(env) {
  const data =
    await heliusRpc(
      env,
      "getBalance",
      [
        WALLET_ADDRESS
      ]
    );

  const lamports =
    Number(
      data?.result?.value || 0
    );

  return {
    solBalance:
      lamports / 1_000_000_000
  };
}

async function getTokenBalance(
  env,
  mint
) {
  const data =
    await heliusRpc(
      env,
      "getTokenAccountsByOwner",
      [
        WALLET_ADDRESS,
        {
          mint
        },
        {
          encoding: "jsonParsed"
        }
      ]
    );

  const accounts =
    data?.result?.value || [];

  if (!accounts.length) {
    return null;
  }

  let rawAmount = 0;
  let decimals = 0;

  for (const account of accounts) {
    const info =
      account?.account?.data?.parsed?.info;

    const tokenAmount =
      info?.tokenAmount;

    if (!tokenAmount) continue;

    rawAmount +=
      Number(tokenAmount.amount || 0);

    decimals =
      Number(
        tokenAmount.decimals || 0
      );
  }

  if (rawAmount <= 0) {
    return null;
  }

  return {
    rawAmount:
      String(Math.floor(rawAmount)),
    amount:
      rawAmount /
      Math.pow(10, decimals),
    decimals
  };
}

async function heliusRpc(
  env,
  method,
  params
) {
  const response =
    await fetch(
      "https://mainnet.helius-rpc.com/?api-key=" +
      encodeURIComponent(env.HELIUS_API_KEY),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params
        })
      }
    );

  if (!response.ok) {
    throw new Error(
      `Helius RPC HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (data?.error) {
    throw new Error(
      data.error.message ||
      JSON.stringify(data.error)
    );
  }

  return data;
}

// ===============================
// PRIVATE KEY
// ===============================

async function importPrivateKey(value) {
  const bytes =
    decodePrivateKey(value);

  let secretBytes;

  if (bytes.length === 64) {
    secretBytes =
      bytes.slice(0, 32);
  } else if (bytes.length === 32) {
    secretBytes =
      bytes;
  } else {
    throw new Error(
      "WALLET_PRIVATE_KEY must decode to 32 or 64 bytes."
    );
  }

  return await crypto.subtle.importKey(
    "raw",
    secretBytes,
    {
      name: "Ed25519"
    },
    false,
    ["sign"]
  );
}

function decodePrivateKey(value) {
  const text =
    String(value || "").trim();

  if (!text) {
    throw new Error(
      "WALLET_PRIVATE_KEY is empty."
    );
  }

  // JSON array format
  if (
    text.startsWith("[") &&
    text.endsWith("]")
  ) {
    const array =
      JSON.parse(text);

    return new Uint8Array(array);
  }

  // Base64 format
  try {
    const bytes =
      base64ToBytes(text);

    if (
      bytes.length === 32 ||
      bytes.length === 64
    ) {
      return bytes;
    }
  } catch (_) {}

  // Base58 format
  return base58Decode(text);
}

// ===============================
// TRANSACTION SIGNING
// ===============================

function replaceSignature(
  transaction,
  signature
) {
  // Solana legacy/versioned transactions
  // have the signature section first.
  const countInfo =
    readShortVec(transaction, 0);

  const signatureCount =
    countInfo.value;

  const offset =
    countInfo.offset;

  if (signatureCount < 1) {
    throw new Error(
      "Transaction contains no signatures."
    );
  }

  if (signature.length !== 64) {
    throw new Error(
      "Invalid Ed25519 signature length."
    );
  }

  const result =
    new Uint8Array(transaction);

  result.set(
    signature,
    offset
  );

  return result;
}

function readShortVec(bytes, offset) {
  let value = 0;
  let size = 0;
  let shift = 0;

  while (true) {
    const byte =
      bytes[offset + size];

    value |=
      (byte & 0x7f) << shift;

    size++;

    if ((byte & 0x80) === 0) {
      break;
    }

    shift += 7;

    if (size > 5) {
      throw new Error(
        "Invalid Solana shortvec."
      );
    }
  }

  return {
    value,
    offset:
      offset + size
  };
}

// ===============================
// BASE64
// ===============================

function base64ToBytes(value) {
  const binary =
    atob(value);

  const bytes =
    new Uint8Array(
      binary.length
    );

  for (let i = 0; i < binary.length; i++) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

// ===============================
// BASE58
// ===============================

function base58Decode(value) {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let num = 0n;

  for (const char of value) {
    const index =
      alphabet.indexOf(char);

    if (index < 0) {
      throw new Error(
        "Invalid base58 private key."
      );
    }

    num =
      num * 58n +
      BigInt(index);
  }

  const bytes = [];

  while (num > 0n) {
    bytes.push(
      Number(num & 255n)
    );

    num >>= 8n;
  }

  bytes.reverse();

  let leadingZeros = 0;

  for (
    let i = 0;
    i < value.length &&
    value[i] === "1";
    i++
  ) {
    leadingZeros++;
  }

  return new Uint8Array([
    ...new Array(leadingZeros).fill(0),
    ...bytes
  ]);
}

// ===============================
// KV POSITION STORAGE
// ===============================

async function getPosition(env) {
  const value =
    await env.BOT_KV.get(
      "position",
      "json"
    );

  return value || null;
}

async function savePosition(
  env,
  position
) {
  await env.BOT_KV.put(
    "position",
    JSON.stringify(position)
  );
}

async function clearPosition(env) {
  await env.BOT_KV.delete(
    "position"
  );
}

// ===============================
// KV COOLDOWNS
// ===============================

async function setCooldown(
  env,
  timestamp
) {
  const seconds =
    Math.max(
      1,
      Math.ceil(
        (timestamp - Date.now()) / 1000
      )
    );

  await env.BOT_KV.put(
    "rate_limit_cooldown",
    String(timestamp),
    {
      expirationTtl: seconds
    }
  );
}

async function getCooldown(env) {
  const value =
    await env.BOT_KV.get(
      "rate_limit_cooldown"
    );

  return Number(value || 0);
}

async function setLastScan(env) {
  await env.BOT_KV.put(
    "last_scan",
    String(Date.now())
  );
}

async function getLastScan(env) {
  const value =
    await env.BOT_KV.get(
      "last_scan"
    );

  return Number(value || 0);
}

// ===============================
// STATUS
// ===============================

async function getStatus(env) {
  try {
    const wallet =
      await getWalletInfo(env);

    const solPriceUsd =
      await getUsdPrice(
        env,
        SOL_MINT
      );

    const walletValueUsd =
      wallet.solBalance *
      solPriceUsd;

    const maxTradeUsd =
      walletValueUsd >=
      BALANCE_THRESHOLD_USD
        ? LARGE_TRADE_CAP_USD
        : SMALL_TRADE_CAP_USD;

    const position =
      await getPosition(env);

    return json({
      ok: true,
      bot: "memebott",
      live_trading: LIVE_TRADING,

      wallet: WALLET_ADDRESS,

      sol_balance:
        wallet.solBalance,

      sol_price_usd:
        solPriceUsd,

      wallet_value_usd:
        Number(
          walletValueUsd.toFixed(4)
        ),

      max_trade_usd:
        maxTradeUsd,

      balance_threshold_usd:
        BALANCE_THRESHOLD_USD,

      small_trade_cap_usd:
        SMALL_TRADE_CAP_USD,

      large_trade_cap_usd:
        LARGE_TRADE_CAP_USD,

      min_sol_reserve:
        MIN_SOL_RESERVE,

      profit_target_percent:
        PROFIT_TARGET * 100,

      stop_loss_percent:
        STOP_LOSS * 100,

      position:
        position || null
    });

  } catch (error) {
    return json({
      ok: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

// ===============================
// VALIDATION
// ===============================

function validateSecrets(env) {
  const required = [
    "HELIUS_API_KEY",
    "JUPITER_API_KEY",
    "WALLET_PRIVATE_KEY",
    "BOT_KV"
  ];

  for (const name of required) {
    if (!env[name]) {
      return {
        ok: false,
        error:
          `Missing ${name}`
      };
    }
  }

  return {
    ok: true
  };
}

// ===============================
// HELPERS
// ===============================

function isRateLimitError(error) {
  return (
    error?.status === 429 ||
    String(
      error?.message || ""
    ).toLowerCase()
      .includes("rate limit")
  );
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

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
        "Content-Type":
          "application/json"
      }
    }
  );
}
