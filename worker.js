const WALLET_ADDRESS = "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const MAX_SLIPPAGE_BPS = 50;
const MAX_PRICE_IMPACT_PERCENT = 0.5;
const MIN_LIQUIDITY_USD = 10000;
const MIN_ORGANIC_SCORE = 50;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        "Memebot is running. Trading is DISABLED."
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

    return new Response("Not found", { status: 404 });
  },

  async scheduled() {
    console.log("Memebot scheduled scan running");
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
      trading: "DISABLED",
      wallet: WALLET_ADDRESS,
      helius_connected: response.ok,
      balance_lamports: lamports,
      balance_sol: lamports !== null
        ? lamports / 1000000000
        : null
    });

  } catch (error) {
    return json({
      bot: "Memebot",
      trading: "DISABLED",
      error: error.message
    }, 500);
  }
}

async function solQuote(env) {
  try {
    const quoteUrl =
      "https://api.jup.ag/swap/v1/quote?" +
      new URLSearchParams({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amount: "1000000",
        slippageBps: MAX_SLIPPAGE_BPS.toString(),
        instructionVersion: "V2"
      });

    const response = await fetch(quoteUrl, {
      headers: {
        "x-api-key": env.JUPITER_API_KEY
      }
    });

    const quote = await response.json();

    return json({
      bot: "Memebot",
      trading: "DISABLED",
      jupiter_connected: response.ok,
      quote
    }, response.ok ? 200 : 502);

  } catch (error) {
    return json({
      bot: "Memebot",
      trading: "DISABLED",
      error: error.message
    }, 500);
  }
}

async function signalTest(env) {
  try {
    const quoteUrl =
      "https://api.jup.ag/swap/v1/quote?" +
      new URLSearchParams({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amount: "1000000",
        slippageBps: MAX_SLIPPAGE_BPS.toString(),
        instructionVersion: "V2"
      });

    const response = await fetch(quoteUrl, {
      headers: {
        "x-api-key": env.JUPITER_API_KEY
      }
    });

    const quote = await response.json();

    if (!response.ok) {
      return json({
        bot: "Memebot",
        trading: "DISABLED",
        signal: "HOLD",
        reason: "Jupiter quote unavailable",
        quote
      }, 502);
    }

    const priceImpact = Number(quote.priceImpactPct || 999);

    const signal =
      quote.routePlan?.length > 0 &&
      priceImpact <= MAX_PRICE_IMPACT_PERCENT
        ? "WATCH"
        : "HOLD";

    return json({
      bot: "Memebot",
      trading: "DISABLED",
      signal,
      reason: signal === "WATCH"
        ? "Jupiter route is available and price impact is within limits."
        : "Conditions did not pass the test.",
      strategy: {
        cooldown: "NONE",
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        max_price_impact_percent: MAX_PRICE_IMPACT_PERCENT
      },
      quote: {
        output_raw: quote.outAmount,
        price_impact_percent: priceImpact,
        routes: quote.routePlan?.length || 0
      },
      note:
        "Signal only. No transaction is created, signed, or submitted."
    });

  } catch (error) {
    return json({
      bot: "Memebot",
      trading: "DISABLED",
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
        trading: "DISABLED",
        scanner: "ERROR",
        jupiter_connected: false,
        response: tokens
      }, 502);
    }

    const candidates = Array.isArray(tokens)
      ? tokens
          .filter(token => {
            const liquidity = Number(token.liquidity || 0);
            const organicScore = Number(token.organicScore || 0);

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
      trading: "DISABLED",
      scanner: "ACTIVE",
      interval: "1h",
      candidates_found: candidates.length,
      filters: {
        minimum_liquidity_usd: MIN_LIQUIDITY_USD,
        minimum_organic_score: MIN_ORGANIC_SCORE,
        suspicious_tokens_rejected: true
      },
      candidates,
      note:
        "Scanner only. No buying, selling, signing, or transaction submission."
    });

  } catch (error) {
    return json({
      bot: "Memebot",
      trading: "DISABLED",
      scanner: "ERROR",
      error: error.message
    }, 500);
  }
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}
