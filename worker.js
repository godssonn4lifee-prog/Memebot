import {
  Connection,
  Keypair,
  VersionedTransaction
} from "@solana/web3.js";

const WALLET_ADDRESS =
  "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const MAX_SLIPPAGE_BPS = 50;
const MAX_PRICE_IMPACT_PERCENT = 0.5;

const MIN_LIQUIDITY_USD = 10000;
const MIN_ORGANIC_SCORE = 50;

const MAX_TRADE_UNDER_20_USD = 5;
const TRADE_PERCENT_OVER_20 = 0.25;

const MIN_SOL_RESERVE = 0.01;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        "Memebot is running. Trading is ENABLED."
      );
    }

    if (url.pathname === "/status") {
      return await walletStatus(env);
    }

    if (url.pathname === "/quote") {
      return await solQuote(env);
    }

    if (url.pathname === "/signal") {
      return await signalTest(env);
    }

    if (url.pathname === "/scan") {
      return await scanTrending(env);
    }

    if (url.pathname === "/trade") {
      return await executeTrade(env);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    console.log("Memebot scheduled scan running");

    ctx.waitUntil(
      runBot(env).catch(error => {
        console.error("Scheduled bot error:", error.message);
      })
    );
  }
};

async function walletStatus(env) {
  try {
    const rpcUrl =
      `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [WALLET_ADDRESS]
      })
    });

    const data = await response.json();
    const lamports = data?.result?.value ?? null;

    return json({
      bot: "Memebot",
      trading: "ENABLED",
      wallet: WALLET_ADDRESS,
      helius_connected: response.ok,
      balance_lamports: lamports,
      balance_sol:
        lamports !== null
          ? lamports / 1000000000
          : null
    });

  } catch (error) {
    return json({
      bot: "Memebot",
      trading: "ENABLED",
      error: error.message
    }, 500);
  }
}

async function solQuote(env) {
  try {
    const quote = await getQuote(
      env,
      SOL_MINT,
      USDC_MINT,
      "1000000"
    );

    return json({
      bot: "Memebot",
      trading: "ENABLED",
      jupiter_connected: true,
      quote
    });

  } catch (error) {
    return json({
      bot: "Memebot",
      trading: "ENABLED",
      error: error.message
    }, 500);
  }
}

async function signalTest(env) {
  try {
    const quote = await getQuote(
      env,
      SOL_MINT,
      USDC_MINT,
      "1000000"
    );

    const priceImpact =
      Number(quote.priceImpactPct || 999) * 100;

    const signal =
      quote.routePlan?.length > 0 &&
      priceImpact <= MAX_PRICE_IMPACT_PERCENT
        ? "WATCH"
        : "HOLD";

    return json({
      bot: "Memebot",
      trading: "ENABLED",
      signal,
      strategy: {
        cooldown: "NONE",
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        max_price_impact_percent:
          MAX_PRICE_IMPACT_PERCENT
      },
      quote: {
        output_raw: quote.outAmount,
        price_impact_percent: priceImpact,
        routes: quote.routePlan?.length || 0
      }
    });

  } catch (error) {
    return json({
      bot: "Memebot",
      trading: "ENABLED",
      signal: "HOLD",
      error: error.message
    }, 500);
  }
}

async function scanTrending(env) {
  try {
    const url =
      "https://api.jup.ag/tokens/v2/toptrending/1h";

    const response = await fetch(url, {
      headers: {
        "x-api-key": env.JUPITER_API_KEY
      }
    });

    const tokens = await response.json();

    if (!response.ok) {
      return json({
        bot: "Memebot",
        trading: "ENABLED",
        scanner: "ERROR",
        response: tokens
      }, 502);
    }

    const candidates = Array.isArray(tokens)
      ? tokens
          .filter(token => {
            const liquidity =
              Number(token.liquidity || 0);

            const organicScore =
              Number(token.organicScore || 0);

            const isSus =
              token.audit?.isSus === true;

            return (
              liquidity >= MIN_LIQUIDITY_USD &&
              organicScore >= MIN_ORGANIC_SCORE &&
              !isSus &&
              token.id !== SOL_MINT &&
              token.id !== USDC_MINT
            );
          })
          .slice(0, 10)
          .map(token => ({
            mint: token.id,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            liquidity_usd: token.liquidity,
            organic_score: token.organicScore,
            holders: token.holderCount,
            usd_price: token.usdPrice,
            audit: token.audit
          }))
      : [];

    return json({
      bot: "Memebot",
      trading: "ENABLED",
      scanner: "ACTIVE",
      interval: "1h",
      candidates_found: candidates.length,
      filters: {
        minimum_liquidity_usd:
          MIN_LIQUIDITY_USD,
        minimum_organic_score:
          MIN_ORGANIC_SCORE,
        suspicious_tokens_rejected: true
      },
      candidates
    });

  } catch (error) {
    return json({
      bot: "Memebot",
      trading: "ENABLED",
      scanner: "ERROR",
      error: error.message
    }, 500);
  }
}

async function runBot(env) {
  console.log("Memebot live cycle started");

  const candidates =
    await getCandidates(env);

  if (!candidates.length) {
    console.log("No qualifying candidates.");
    return;
  }

  const candidate = candidates[0];

  console.log(
    `Selected ${candidate.symbol} ${candidate.mint}`
  );

  const result =
    await executeTradeInternal(
      env,
      candidate.mint,
      candidate.symbol
    );

  console.log(
    "Trade result:",
    JSON.stringify(result)
  );
}

async function getCandidates(env) {
  const response = await fetch(
    "https://api.jup.ag/tokens/v2/toptrending/1h",
    {
      headers: {
        "x-api-key": env.JUPITER_API_KEY
      }
    }
  );

  const tokens = await response.json();

  if (!response.ok || !Array.isArray(tokens)) {
    throw new Error(
      `Scanner failed: ${JSON.stringify(tokens)}`
    );
  }

  return tokens
    .filter(token => {
      const liquidity =
        Number(token.liquidity || 0);

      const organicScore =
        Number(token.organicScore || 0);

      const isSus =
        token.audit?.isSus === true;

      return (
        liquidity >= MIN_LIQUIDITY_USD &&
        organicScore >= MIN_ORGANIC_SCORE &&
        !isSus &&
        token.id !== SOL_MINT &&
        token.id !== USDC_MINT
      );
    })
    .slice(0, 10);
}

async function executeTrade(env) {
  try {
    const candidates =
      await getCandidates(env);

    if (!candidates.length) {
      return json({
        bot: "Memebot",
        trading: "ENABLED",
        trade: "SKIPPED",
        reason: "No qualifying token found."
      });
    }

    const candidate = candidates[0];

    const result =
      await executeTradeInternal(
        env,
        candidate.id,
        candidate.symbol
      );

    return json(result);

  } catch (error) {
    return json({
      bot: "Memebot",
      trading: "ENABLED",
      trade: "ERROR",
      error: error.message
    }, 500);
  }
}

async function executeTradeInternal(
  env,
  outputMint,
  symbol
) {
  const rpcUrl =
    `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;

  const connection =
    new Connection(rpcUrl);

  const balanceLamports =
    await connection.getBalance(
      Keypair.fromSecretKey(
        decodeSecret(env.WALLET_PRIVATE_KEY)
      ).publicKey
    );

  const balanceSol =
    balanceLamports / 1000000000;

  if (balanceSol <= MIN_SOL_RESERVE) {
    return {
      bot: "Memebot",
      trading: "ENABLED",
      trade: "SKIPPED",
      reason: "SOL fee reserve would be too low.",
      balance_sol: balanceSol
    };
  }

  const priceQuote =
    await getQuote(
      env,
      SOL_MINT,
      USDC_MINT,
      "1000000"
    );

  const usdcPerSol =
    Number(priceQuote.outAmount) /
    1000000;

  const balanceUsd =
    balanceSol * usdcPerSol;

  let tradeUsd;

  if (balanceUsd <= 20) {
    tradeUsd =
      MAX_TRADE_UNDER_20_USD;
  } else {
    tradeUsd =
      balanceUsd * TRADE_PERCENT_OVER_20;
  }

  tradeUsd =
    Math.min(tradeUsd, balanceUsd);

  let tradeSol =
    tradeUsd / usdcPerSol;

  const reserveLamports =
    Math.floor(
      MIN_SOL_RESERVE * 1000000000
    );

  const maximumSpendableLamports =
    Math.max(
      0,
      balanceLamports -
      reserveLamports
    );

  const tradeLamports =
    Math.min(
      Math.floor(tradeSol * 1000000000),
      maximumSpendableLamports
    );

  if (tradeLamports <= 0) {
    return {
      bot: "Memebot",
      trading: "ENABLED",
      trade: "SKIPPED",
      reason: "Calculated trade amount is zero."
    };
  }

  const quote =
    await getQuote(
      env,
      SOL_MINT,
      outputMint,
      tradeLamports.toString()
    );

  const priceImpact =
    Number(quote.priceImpactPct || 999) * 100;

  if (
    !quote.routePlan?.length ||
    priceImpact > MAX_PRICE_IMPACT_PERCENT
  ) {
    return {
      bot: "Memebot",
      trading: "ENABLED",
      trade: "SKIPPED",
      symbol,
      reason: "Trade failed risk filters.",
      price_impact_percent: priceImpact,
      max_allowed_percent:
        MAX_PRICE_IMPACT_PERCENT
    };
  }

  const swapResponse =
    await buildSwap(
      env,
      quote
    );

  if (
    !swapResponse.swapTransaction
  ) {
    throw new Error(
      `Jupiter swap build failed: ${JSON.stringify(
        swapResponse
      )}`
    );
  }

  const wallet =
    Keypair.fromSecretKey(
      decodeSecret(
