const BOT_NAME = "memebott";

const WALLET_ADDRESS =
  "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const LIVE_TRADING = true;

/*
  PROFIT / LOSS

  Hard stop: -2%

  Trailing profit:
  Activates: +3%
  Distance: 1.25%
*/

const HARD_STOP_PCT = -0.02;
const TRAILING_ACTIVATE_PCT = 0.03;
const TRAILING_DISTANCE_PCT = 0.0125;

/*
  TRADE SIZE

  Wallet under $100:
    $5 maximum trade

  Wallet $100 or more:
    $20 maximum trade
*/

const SMALL_WALLET_LIMIT_USD = 100;
const SMALL_TRADE_USD = 5;
const LARGE_TRADE_USD = 20;

/*
  SAFETY
*/

const SOL_RESERVE = 0.01;
const MAX_POSITIONS = 10;

const SLIPPAGE_BPS = 50;

const COOLDOWN_SECONDS = 30;

const MAX_CANDIDATES = 3;

const TRENDING_CACHE_SECONDS = 120;
const TRENDING_BACKOFF_SECONDS = 120;

const IMMEDIATE_LOSS_FILTER = 0.005;

/*
  KV KEYS
*/

const POSITIONS_KEY = "POSITIONS";
const COOLDOWN_KEY = "TRADE_COOLDOWN";
const TRENDING_CACHE_KEY = "JUPITER_TRENDING_CACHE";
const TRENDING_BACKOFF_KEY = "JUPITER_TRENDING_BACKOFF";

/*
  ENTRY POINT
*/

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/") {
        return json({
          ok: true,
          bot: BOT_NAME,
          liveTrading: LIVE_TRADING,
          message: "memebott is running"
        });
      }

      if (url.pathname === "/status") {
        return await handleStatus(env);
      }

      if (url.pathname === "/test") {
        return await handleTest(env);
      }

      if (url.pathname === "/repair") {
        return await handleRepair(env);
      }

      if (url.pathname === "/run") {
        const result = await runBot(env, "manual");
        return json(result);
      }

      return json({
        ok: false,
        error: "Unknown endpoint"
      }, 404);

    } catch (error) {
      console.error(error);

      return json({
        ok: false,
        error: error?.message || String(error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBot(env, "cron").catch(error => {
        console.error("Scheduled bot error:", error);
      })
    );
  }
};


/*
  MAIN BOT
*/

async function runBot(env, source) {
  validateEnv(env);

  console.log(`memebott ${source} run started`);

  await repairPositions(env);

  let positions = await loadPositions(env);

  const solBalance = await getSolBalance(env);
  const solPrice = await getSolPrice(env);

  const walletUsd = solBalance * solPrice;

  console.log("SOL balance:", solBalance);
  console.log("SOL price:", solPrice);
  console.log("Wallet USD:", walletUsd);
  console.log("Positions:", positions.length);

  /*
    ALWAYS MANAGE EXISTING POSITIONS FIRST
  */

  if (positions.length > 0) {
    for (const position of [...positions]) {
      try {
        await managePosition(env, position);
      } catch (error) {
        console.error(
          `Position management failed for ${position.mint}:`,
          error
        );
      }
    }
  }

  positions = await loadPositions(env);

  /*
    MAX POSITION CHECK
  */

  if (positions.length >= MAX_POSITIONS) {
    console.log("Maximum positions reached.");

    return {
      ok: true,
      action: "hold",
      reason: "max_positions",
      positions: positions.length
    };
  }

  /*
    COOLDOWN
  */

  const cooldown = await getCooldown(env);

  if (cooldown > Date.now()) {
    return {
      ok: true,
      action: "hold",
      reason: "cooldown",
      cooldownUntil: cooldown
    };
  }

  /*
    RESERVE SOL
  */

  const availableSol = solBalance - SOL_RESERVE;

  if (availableSol <= 0) {
    return {
      ok: true,
      action: "hold",
      reason: "insufficient_sol_reserve",
      solBalance
    };
  }

  /*
    DETERMINE TRADE SIZE
  */

  const tradeUsd =
    walletUsd < SMALL_WALLET_LIMIT_USD
      ? SMALL_TRADE_USD
      : LARGE_TRADE_USD;

  const actualTradeUsd = Math.min(
    tradeUsd,
    availableSol * solPrice
  );

  if (actualTradeUsd <= 0) {
    return {
      ok: true,
      action: "hold",
      reason: "trade_size_zero"
    };
  }

  /*
    FIND CANDIDATE
  */

  const candidate = await findCandidate(env, positions);

  if (!candidate) {
    return {
      ok: true,
      action: "hold",
      reason: "no_candidate"
    };
  }

  console.log("Candidate:", candidate);

  /*
    BUY
  */

  const result = await buyToken(
    env,
    candidate,
    actualTradeUsd,
    solPrice
  );

  return result;
}


/*
  ENVIRONMENT VALIDATION

  IMPORTANT:
  Uses BOT_PRIVATE_KEY to match the
  Cloudflare secret from the existing setup.
*/

function validateEnv(env) {
  const required = [
    "BOT_KV",
    "BOT_PRIVATE_KEY",
    "HELIUS_API_KEY"
  ];

  const missing = required.filter(key => !env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing Cloudflare binding/secret: ${missing.join(", ")}`
    );
  }
}


/*
  STATUS
*/

async function handleStatus(env) {
  validateEnv(env);

  const positions = await loadPositions(env);
  const solBalance = await getSolBalance(env);
  const solPrice = await getSolPrice(env);

  return json({
    ok: true,
    bot: BOT_NAME,
    liveTrading: LIVE_TRADING,
    wallet: WALLET_ADDRESS,
    solBalance,
    solPrice,
    walletUsd: solBalance * solPrice,
    positions,
    settings: {
      hardStopPct: HARD_STOP_PCT,
      trailingActivatePct: TRAILING_ACTIVATE_PCT,
      trailingDistancePct: TRAILING_DISTANCE_PCT,
      smallWalletLimitUsd: SMALL_WALLET_LIMIT_USD,
      smallTradeUsd: SMALL_TRADE_USD,
      largeTradeUsd: LARGE_TRADE_USD,
      solReserve: SOL_RESERVE,
      maxPositions: MAX_POSITIONS,
      slippageBps: SLIPPAGE_BPS,
      cooldownSeconds: COOLDOWN_SECONDS
    }
  });
}


/*
  TEST

  NEVER BUYS OR SELLS
*/

async function handleTest(env) {
  validateEnv(env);

  const solBalance = await getSolBalance(env);
  const solPrice = await getSolPrice(env);
  const positions = await loadPositions(env);

  let candidates = [];

  try {
    candidates = await getTrendingTokens(env);
  } catch (error) {
    console.error("Candidate test failed:", error);
  }

  return json({
    ok: true,
    trading: false,
    message: "TEST MODE ONLY. No buy or sell was performed.",
    wallet: WALLET_ADDRESS,
    solBalance,
    solPrice,
    walletUsd: solBalance * solPrice,
    positions,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, MAX_CANDIDATES)
  });
}


/*
  REPAIR ENDPOINT

  NEVER BUYS OR SELLS
*/

async function handleRepair(env) {
  validateEnv(env);

  const repaired = await repairPositions(env);

  return json({
    ok: true,
    trading: false,
    message: "Position repair completed. No buy or sell was performed.",
    repaired
  });
}


/*
  POSITION STORAGE
*/

async function loadPositions(env) {
  const raw = await env.BOT_KV.get(POSITIONS_KEY);

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed;
  } catch {
    console.error("Invalid POSITIONS KV data.");
    return [];
  }
}


async function savePositions(env, positions) {
  await env.BOT_KV.put(
    POSITIONS_KEY,
    JSON.stringify(positions)
  );
}


/*
  SAFE REPAIR

  Adds missing entry prices when possible.
*/

async function repairPositions(env) {
  const positions = await loadPositions(env);

  if (!positions.length) {
    return 0;
  }

  let repaired = 0;
  let changed = false;

  for (const position of positions) {
    if (
      !position.entryPrice ||
      !Number.isFinite(Number(position.entryPrice)) ||
      Number(position.entryPrice) <= 0
    ) {
      const amount = Number(position.amount);
      const tradeUsd = Number(position.trade_usd);

      if (
        Number.isFinite(amount) &&
        amount > 0 &&
        Number.isFinite(tradeUsd) &&
        tradeUsd > 0
      ) {
        position.entryPrice = tradeUsd / amount;
        repaired++;
        changed = true;
      }
    }

    if (
      !position.highestPrice &&
      position.entryPrice
    ) {
      position.highestPrice = Number(position.entryPrice);
      changed = true;
    }
  }

  if (changed) {
    await savePositions(env, positions);
  }

  return repaired;
}


/*
  COOLDOWN
*/

async function getCooldown(env) {
  const raw = await env.BOT_KV.get(COOLDOWN_KEY);

  if (!raw) {
    return 0;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return 0;
  }

  return value;
}


async function setCooldown(env) {
  const until =
    Date.now() +
    COOLDOWN_SECONDS * 1000;

  await env.BOT_KV.put(
    COOLDOWN_KEY,
    String(until)
  );
}


/*
  SOL BALANCE
*/

async function getSolBalance(env) {
  const result = await heliusRpc(
    env,
    "getBalance",
    [WALLET_ADDRESS]
  );

  const lamports =
    result?.result?.value ?? 0;

  return Number(lamports) / 1e9;
}


/*
  SOL PRICE
*/

async function getSolPrice(env) {
  const price = await getTokenPrice(
    env,
    SOL_MINT
  );

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Unable to obtain SOL price.");
  }

  return price;
}


/*
  TOKEN PRICE
*/

async function getTokenPrice(env, mint) {
  const url =
    `https://api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Jupiter price request failed: ${response.status}`
    );
  }

  const data = await response.json();

  const item = data?.[mint];

  if (!item) {
    return 0;
  }

  const price = Number(item.usdPrice);

  if (!Number.isFinite(price)) {
    return 0;
  }

  return price;
}


/*
  TRENDING TOKENS
*/

async function getTrendingTokens(env) {
  const now = Date.now();

  /*
    BACKOFF
  */

  const backoffRaw =
    await env.BOT_KV.get(TRENDING_BACKOFF_KEY);

  if (backoffRaw) {
    const backoffUntil = Number(backoffRaw);

    if (
      Number.isFinite(backoffUntil) &&
      now < backoffUntil
    ) {
      const cached =
        await env.BOT_KV.get(TRENDING_CACHE_KEY);

      if (cached) {
        try {
          return JSON.parse(cached);
        } catch {
          return [];
        }
      }

      return [];
    }
  }

  /*
    CACHE
  */

  const cachedRaw =
    await env.BOT_KV.get(TRENDING_CACHE_KEY);

  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);

      if (
        cached &&
        Number(cached.timestamp) +
          TRENDING_CACHE_SECONDS * 1000 >
          now
      ) {
        return Array.isArray(cached.tokens)
          ? cached.tokens
          : [];
      }
    } catch {
      // Ignore bad cache.
    }
  }

  /*
    FETCH JUPITER TRENDING
  */

  const url =
    "https://api.jup.ag/tokens/v2/toptrending/24h";

  let response;

  try {
    response = await fetch(url);
  } catch (error) {
    await setTrendingBackoff(env);
    throw error;
  }

  if (!response.ok) {
    await setTrendingBackoff(env);

    throw new Error(
      `Jupiter trending request failed: ${response.status}`
    );
  }

  const data = await response.json();

  const list =
    Array.isArray(data)
      ? data
      : Array.isArray(data?.tokens)
        ? data.tokens
        : [];

  const tokens = list
    .filter(token => {
      const address =
        token?.id ||
        token?.address ||
        token?.mint;

      return (
        address &&
        address !== SOL_MINT
      );
    })
    .slice(0, MAX_CANDIDATES);

  await env.BOT_KV.put(
    TRENDING_CACHE_KEY,
    JSON.stringify({
      timestamp: now,
      tokens
    })
  );

  await env.BOT_KV.delete(
    TRENDING_BACKOFF_KEY
  );

  return tokens;
}


async function setTrendingBackoff(env) {
  const until =
    Date.now() +
    TRENDING_BACKOFF_SECONDS * 1000;

  await env.BOT_KV.put(
    TRENDING_BACKOFF_KEY,
    String(until)
  );
}


/*
  FIND BUY CANDIDATE
*/

async function findCandidate(env, positions) {
  const trending =
    await getTrendingTokens(env);

  const held = new Set(
    positions.map(position => position.mint)
  );

  for (const token of trending) {
    const mint =
      token?.id ||
      token?.address ||
      token?.mint;

    if (!mint) {
      continue;
    }

    if (mint === SOL_MINT) {
      continue;
    }

    if (held.has(mint)) {
      continue;
    }

    return {
      mint,
      symbol:
        token?.symbol ||
        token?.name ||
        "UNKNOWN",
      decimals:
        Number.isFinite(Number(token?.decimals))
          ? Number(token.decimals)
          : 0
    };
  }

  return null;
}


/*
  BUY TOKEN
*/

async function buyToken(
  env,
  candidate,
  tradeUsd,
  solPrice
) {
  const amountSol =
    tradeUsd / solPrice;

  const amountLamports =
    Math.floor(amountSol * 1e9);

  if (amountLamports <= 0) {
    throw new Error("Buy amount is too small.");
  }

  console.log(
    `Buying ${candidate.symbol} with $${tradeUsd}`
  );

  const order = await getJupiterOrder(
    env,
    SOL_MINT,
    candidate.mint,
    amountLamports,
    true
  );

  if (!order) {
    throw new Error("Jupiter returned no buy order.");
  }

  /*
    IMMEDIATE LOSS FILTER

    If Jupiter reports price impact above
    the configured threshold, do not buy.
  */

  const priceImpact =
    Number(order.priceImpactPct);

  if (
    Number.isFinite(priceImpact) &&
    priceImpact > IMMEDIATE_LOSS_FILTER
  ) {
    return {
      ok: true,
      action: "hold",
      reason: "price_impact_too_high",
      mint: candidate.mint,
      symbol: candidate.symbol,
      priceImpact
    };
  }

  if (!LIVE_TRADING) {
    return {
      ok: true,
      action: "paper_buy",
      mint: candidate.mint,
      symbol: candidate.symbol,
      tradeUsd
    };
  }

  const execution =
    await executeJupiterOrder(env, order);

  if (!execution.success) {
    throw new Error(
      execution.error ||
      "Jupiter buy execution failed."
    );
  }

  const outRaw =
    Number(order.outAmount);

  const decimals =
    Number.isFinite(Number(candidate.decimals))
      ? Number(candidate.decimals)
      : 0;

  const tokenAmount =
    outRaw > 0
      ? outRaw / Math.pow(10, decimals)
      : 0;

  if (tokenAmount <= 0) {
    throw new Error(
      "Buy succeeded but token amount could not be determined."
    );
  }

  let entryPrice =
    await getTokenPrice(
      env,
      candidate.mint
    );

  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0
  ) {
    entryPrice =
      tradeUsd / tokenAmount;
  }

  const positions =
    await loadPositions(env);

  positions.push({
    mint: candidate.mint,
    symbol: candidate.symbol,
    decimals,
    amount: tokenAmount,
    amount_raw: String(order.outAmount),
    trade_usd: tradeUsd,
    entryPrice,
    highestPrice: entryPrice,
    boughtAt: Date.now(),
    txid:
      execution.signature ||
      execution.txid ||
      null
  });

  await savePositions(env, positions);
  await setCooldown(env);

  console.log(
    `BUY COMPLETE ${candidate.symbol} ${candidate.mint}`
  );

  return {
    ok: true,
    action: "buy",
    mint: candidate.mint,
    symbol: candidate.symbol,
    tradeUsd,
    tokenAmount,
    entryPrice,
    txid:
      execution.signature ||
      execution.txid ||
      null
  };
}


/*
  MANAGE POSITION
*/

async function managePosition(env, position) {
  const mint = position.mint;

  if (!mint) {
    return;
  }

  /*
    GET ACTUAL TOKEN BALANCE
  */

  const actualRaw =
    await getTokenBalanceRaw(
      env,
      mint
    );

  if (actualRaw <= 0) {
    console.log(
      `No token balance found for ${mint}. Removing position.`
    );

    const positions =
      await loadPositions(env);

    const remaining =
      positions.filter(
        item => item.mint !== mint
      );

    await savePositions(
      env,
      remaining
    );

    return;
  }

  const decimals =
    Number.isFinite(Number(position.decimals))
      ? Number(position.decimals)
      : 0;

  const actualAmount =
    actualRaw /
    Math.pow(10, decimals);

  position.amount = actualAmount;
  position.amount_raw = String(actualRaw);

  /*
    PRICE
  */

  const currentPrice =
    await getTokenPrice(
      env,
      mint
    );

  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    console.log(
      `Unable to get price for ${mint}.`
    );

    return;
  }

  /*
    ENTRY PRICE
  */

  let entryPrice =
    Number(position.entryPrice);

  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0
  ) {
    const tradeUsd =
      Number(position.trade_usd);

    if (
      Number.isFinite(tradeUsd) &&
      tradeUsd > 0 &&
      actualAmount > 0
    ) {
      entryPrice =
        tradeUsd / actualAmount;

      position.entryPrice =
        entryPrice;
    } else {
      console.log(
        `Cannot determine entry price for ${mint}.`
      );

      return;
    }
  }

  /*
    CURRENT PROFIT
  */

  const change =
    (currentPrice - entryPrice) /
    entryPrice;

  /*
    HIGHEST PRICE
  */

  let highestPrice =
    Number(position.highestPrice);

  if (
    !Number.isFinite(highestPrice) ||
    highestPrice <= 0
  ) {
    highestPrice = entryPrice;
  }

  if (currentPrice > highestPrice) {
    highestPrice = currentPrice;
    position.highestPrice = highestPrice;
  }

  /*
    TRAILING ACTIVATION
  */

  const highestProfit =
    (highestPrice - entryPrice) /
    entryPrice;

  let shouldSell = false;
  let reason = "";

  /*
    HARD STOP
  */

  if (change <= HARD_STOP_PCT) {
    shouldSell = true;
    reason = "hard_stop";
  }

  /*
    TRAILING STOP
  */

  if (
    !shouldSell &&
    highestProfit >= TRAILING_ACTIVATE_PCT
  ) {
    const trailingStop =
      highestPrice *
      (1 - TRAILING_DISTANCE_PCT);

    if (currentPrice <= trailingStop) {
      shouldSell = true;
      reason = "trailing_stop";
    }
  }

  console.log(
    `Position ${position.symbol || mint}:`,
    `change=${(change * 100).toFixed(2)}%`,
    `highest=${(highestProfit * 100).toFixed(2)}%`,
    `sell=${shouldSell}`,
    `reason=${reason}`
  );

  /*
    SAVE UPDATED HIGH
  */

  const allPositions =
    await loadPositions(env);

  const index =
    allPositions.findIndex(
      item => item.mint === mint
    );

  if (index >= 0) {
    allPositions[index] = position;
    await savePositions(
      env,
      allPositions
    );
  }

  /*
    SELL
  */

  if (!shouldSell) {
    return;
  }

  await sellToken(
    env,
    position,
    actualRaw,
    reason
  );
}


/*
  SELL TOKEN
*/

async function sellToken(
  env,
  position,
  rawAmount,
  reason
) {
  console.log(
    `Selling ${position.symbol || position.mint}: ${reason}`
  );

  const order =
    await getJupiterOrder(
      env,
      position.mint,
      SOL_MINT,
      rawAmount,
      false
    );

  if (!order) {
    throw new Error("Jupiter returned no sell order.");
  }

  if (!LIVE_TRADING) {
    return {
      ok: true,
      action: "paper_sell",
      mint: position.mint,
      reason
    };
  }

  const execution =
    await executeJupiterOrder(
      env,
      order
    );

  if (!execution.success) {
    throw new Error(
      execution.error ||
      "Jupiter sell execution failed."
    );
  }

  const positions =
    await loadPositions(env);

  const remaining =
    positions.filter(
      item => item.mint !== position.mint
    );

  await savePositions(
    env,
    remaining
  );

  await setCooldown(env);

  console.log(
    `SELL COMPLETE ${position.symbol || position.mint}`
  );

  return {
    ok: true,
    action: "sell",
    mint: position.mint,
    reason,
    txid:
      execution.signature ||
      execution.txid ||
      null
  };
}


/*
  JUPITER ORDER

  Jupiter Swap API v2
*/

async function getJupiterOrder(
  env,
  inputMint,
  outputMint,
  amount,
  exactIn
) {
  const params = new URLSearchParams();

  params.set("inputMint", inputMint);
  params.set("outputMint", outputMint);
  params.set("amount", String(amount));
  params.set(
    "taker",
    WALLET_ADDRESS
  );
  params.set(
    "slippageBps",
    String(SLIPPAGE_BPS)
  );

  if (!exactIn) {
    params.set(
      "swapMode",
      "ExactIn"
    );
  }

  const response =
    await fetch(
      `https://api.jup.ag/swap/v2/order?${params.toString()}`
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Jupiter order failed: ${response.status} ${text}`
    );
  }

  const data =
    await response.json();

  if (data?.error) {
    throw new Error(
      data.error
    );
  }

  return data;
}


/*
  EXECUTE JUPITER ORDER
*/

async function executeJupiterOrder(
  env,
  order
) {
  if (!env.BOT_PRIVATE_KEY) {
    throw new Error(
      "BOT_PRIVATE_KEY secret is missing"
    );
  }

  const transaction =
    order?.transaction;

  const requestId =
    order?.requestId;

  if (!transaction) {
    throw new Error(
      "Jupiter order did not contain a transaction."
    );
  }

  if (!requestId) {
    throw new Error(
      "Jupiter order did not contain a requestId."
    );
  }

  const signedTransaction =
    await signSolanaTransaction(
      transaction,
      env.BOT_PRIVATE_KEY
    );

  const response =
    await fetch(
      "https://api.jup.ag/swap/v2/execute",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          signedTransaction,
          requestId
        })
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    return {
      success: false,
      error:
        data?.error ||
        `Jupiter execute failed: ${response.status}`
    };
  }

  return {
    success:
      data?.status === "Success" ||
      data?.code === 0 ||
      data?.signature ||
      data?.txid
        ? true
        : false,

    signature:
      data?.signature ||
      data?.txid ||
      data?.transactionId ||
      null,

    txid:
      data?.txid ||
      data?.signature ||
      data?.transactionId ||
      null,

    error:
      data?.error ||
      null
  };
}


/*
  TOKEN BALANCE

  Uses Helius RPC.
*/

async function getTokenBalanceRaw(
  env,
  mint
) {
  const result =
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
    result?.result?.value || [];

  let total = 0;

  for (const account of accounts) {
    const amount =
      account?.account?.data?.parsed?.info
        ?.tokenAmount?.amount;

    if (amount) {
      total += Number(amount);
    }
  }

  return total;
}


/*
  HELIUS RPC
*/

async function heliusRpc(
  env,
  method,
  params
) {
  const url =
    `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(
      env.HELIUS_API_KEY
    )}`;

  const response =
    await fetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params
        })
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Helius RPC failed: ${response.status} ${text}`
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


/*
  SOLANA TRANSACTION SIGNING
*/

async function signSolanaTransaction(
  transactionBase64,
  privateKeyValue
) {
  const transaction =
    base64ToBytes(
      transactionBase64
    );

  const privateKeyBytes =
    decodePrivateKey(
      privateKeyValue
    );

  const signatureCount =
    decodeShortVec(
      transaction,
      0
    );

  const signatureOffset =
    signatureCount.offset;

  const count =
    signatureCount.value;

  if (count < 1) {
    throw new Error(
      "Transaction contains no signature slots."
    );
  }

  const messageOffset =
    signatureOffset +
    count * 64;

  if (
    messageOffset >
    transaction.length
  ) {
    throw new Error(
      "Invalid Solana transaction."
    );
  }

  const message =
    transaction.slice(
      messageOffset
    );

  const cryptoKey =
    await importEd25519PrivateKey(
      privateKeyBytes
    );

  const signature =
    await crypto.subtle.sign(
      "Ed25519",
      cryptoKey,
      message
    );

  const signatureBytes =
    new Uint8Array(signature);

  transaction.set(
    signatureBytes,
    signatureOffset
  );

  return bytesToBase64(
    transaction
  );
}


/*
  PRIVATE KEY DECODER
*/

function decodePrivateKey(value) {
  const trimmed =
    String(value).trim();

  /*
    JSON ARRAY FORMAT
  */

  if (trimmed.startsWith("[")) {
    let parsed;

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        "BOT_PRIVATE_KEY JSON is invalid."
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error(
        "BOT_PRIVATE_KEY must be an array or base58 key."
      );
    }

    const bytes =
      new Uint8Array(parsed);

    if (
      bytes.length !== 32 &&
      bytes.length !== 64
    ) {
      throw new Error(
        "BOT_PRIVATE_KEY must contain 32 or 64 bytes."
      );
    }

    return bytes.length === 64
      ? bytes.slice(0, 32)
      : bytes;
  }

  /*
    BASE58 FORMAT
  */

  const decoded =
    base58Decode(trimmed);

  if (
    decoded.length !== 32 &&
    decoded.length !== 64
  ) {
    throw new Error(
      "BOT_PRIVATE_KEY must decode to 32 or 64 bytes."
    );
  }

  return decoded.length === 64
    ? decoded.slice(0, 32)
    : decoded;
}


/*
  ED25519 PKCS8 IMPORT
*/

async function importEd25519PrivateKey(
  rawPrivateKey
) {
  if (rawPrivateKey.length !== 32) {
    throw new Error(
      "Ed25519 private key must be 32 bytes."
    );
  }

  const prefix =
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
      prefix.length +
      rawPrivateKey.length
    );

  pkcs8.set(prefix, 0);
  pkcs8.set(
    rawPrivateKey,
    prefix.length
  );

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    {
      name: "Ed25519"
    },
    false,
    ["sign"]
  );
}


/*
  BASE58 DECODER
*/

function base58Decode(value) {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let bytes = [0];

  for (const char of value) {
    const index =
      alphabet.indexOf(char);

    if (index < 0) {
      throw new Error(
        "Invalid base58 character in BOT_PRIVATE_KEY."
      );
    }

    let carry = index;

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {
      const x =
        bytes[i] * 58 +
        carry;

      bytes[i] =
        x & 0xff;

      carry =
        x >> 8;
    }

    while (carry > 0) {
      bytes.push(
        carry & 0xff
      );

      carry >>= 8;
    }
  }

  for (
    let i = 0;
    i < value.length &&
    value[i] === "1";
    i++
  ) {
    bytes.push(0);
  }

  return new Uint8Array(
    bytes.reverse()
  );
}


/*
  SHORTVEC DECODER
*/

function decodeShortVec(
  bytes,
  offset
) {
  let value = 0;
  let shift = 0;
  let position = offset;

  while (true) {
    if (position >= bytes.length) {
      throw new Error(
        "Invalid shortvec."
      );
    }

    const byte =
      bytes[position++];

    value |=
      (byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      break;
    }

    shift += 7;

    if (shift > 35) {
      throw new Error(
        "Invalid shortvec."
      );
    }
  }

  return {
    value,
    offset: position
  };
}


/*
  BASE64
*/

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


function bytesToBase64(bytes) {
  let binary = "";

  const chunkSize = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    binary += String.fromCharCode(
      ...bytes.slice(
        i,
        i + chunkSize
      )
    );
  }

  return btoa(binary);
}


/*
  JSON RESPONSE
*/

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
