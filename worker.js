const WALLET_ADDRESS = "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // HOME
    if (url.pathname === "/") {
      return new Response(
        "Memebot is running. Trading is DISABLED."
      );
    }

    // WALLET / HELIUS STATUS
    if (url.pathname === "/status") {
      try {
        const rpcUrl =
          `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;

        const rpcResponse = await fetch(rpcUrl, {
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

        const data = await rpcResponse.json();

        return new Response(
          JSON.stringify({
            bot: "Memebot",
            trading: "DISABLED",
            helius_connected: rpcResponse.ok,
            wallet: WALLET_ADDRESS,
            helius_response: data
          }, null, 2),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            bot: "Memebot",
            trading: "DISABLED",
            error: error.message
          }, null, 2),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    // JUPITER QUOTE TEST
    if (url.pathname === "/quote") {
      try {
        // Test quote: 0.001 SOL -> USDC
        const amount = "1000000";

        const quoteUrl =
          "https://api.jup.ag/swap/v1/quote?" +
          new URLSearchParams({
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
            amount: amount,
            slippageBps: "50",
            instructionVersion: "V2"
          });

        const quoteResponse = await fetch(quoteUrl, {
          headers: {
            "x-api-key": env.JUPITER_API_KEY
          }
        });

        const quote = await quoteResponse.json();

        return new Response(
          JSON.stringify({
            bot: "Memebot",
            trading: "DISABLED",
            jupiter_connected: quoteResponse.ok,
            test: "0.001 SOL -> USDC",
            quote: quote
          }, null, 2),
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            bot: "Memebot",
            trading: "DISABLED",
            error: error.message
          }, null, 2),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled() {
    console.log("Memebot scheduled test running");
  }
};
