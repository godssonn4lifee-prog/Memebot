const WALLET_ADDRESS = "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const MAX_SLIPPAGE_BPS = 50;
const TEST_AMOUNT_LAMPORTS = 1000000; // 0.001 SOL

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --------------------------------------------------
    // HOME
    // --------------------------------------------------
    if (url.pathname === "/") {
      return new Response(
        "Memebot is running. Trading is DISABLED."
      );
    }

    // --------------------------------------------------
    // STATUS
    // --------------------------------------------------
    if (url.pathname === "/status") {
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

        return json({
          bot: "Memebot",
          trading: "DISABLED",
          wallet: WALLET_ADDRESS,
          helius_connected: response.ok,
          balance_lamports: data?.result?.value ?? null,
          balance_sol:
            data?.result?.value != null
              ? data.result.value / 1000000000
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

    // --------------------------------------------------
    // JUPITER QUOTE
    // --------------------------------------------------
    if (url.pathname === "/quote") {
      try {
        const quoteUrl =
          "https://api.jup.ag/swap/v1/quote?" +
          new URLSearchParams({
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
            amount: TEST_AMOUNT_LAMPORTS.toString(),
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
          test: "0.001 SOL -> USDC",
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

    // --------------------------------------------------
    // SIGNAL ENGINE TEST
    // --------------------------------------------------
    if (url.pathname === "/signal") {
      try {
        const quoteUrl =
          "https://api.jup.ag/swap/v1/quote?" +
          new URLSearchParams({
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
            amount: TEST_AMOUNT_LAMPORTS.toString(),
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

        const priceImpact =
          Number(quote.priceImpactPct || 999);

        let signal = "HOLD";
        let reason = "Waiting for a valid trading opportunity.";

        if (
          quote.outAmount &&
          quote.routePlan &&
          quote.routePlan.length > 0 &&
          priceImpact <= 0.5
        ) {
          signal = "WATCH";
          reason =
            "Jupiter route is available and price impact is within the test limit.";
        }

        return json({
          bot: "Memebot",
          trading: "DISABLED",

          signal,
          reason,

          strategy: {
            cooldown: "NONE",
            max_slippage_bps: MAX_SLIPPAGE_BPS,
            max_test_price_impact_percent: 0.5
          },

          market_test: {
            input: "0.001 SOL",
            output_raw: quote.outAmount,
            price_impact_percent: priceImpact,
            route_count: quote.routePlan?.length || 0
          },

          note:
            "This endpoint ONLY generates a signal. It does NOT buy, sell, sign, or submit transactions."
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

    return new Response("Not found", { status: 404 });
  },

  async scheduled() {
    console.log("Memebot scheduled signal check running");
  }
};

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
