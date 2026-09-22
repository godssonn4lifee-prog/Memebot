const WALLET_ADDRESS = "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          bot: "Memebot",
          status: "running",
          trading: "DISABLED",
          message: "Memebot is online."
        }, null, 2),
        {
          headers: { "content-type": "application/json" }
        }
      );
    }

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

        if (data.error) {
          throw new Error(data.error.message);
        }

        const lamports = data.result.value;
        const sol = lamports / 1_000_000_000;

        return new Response(
          JSON.stringify({
            bot: "Memebot",
            trading: "DISABLED",
            wallet: WALLET_ADDRESS,
            sol_balance: sol,
            message: "Wallet connection test successful."
          }, null, 2),
          {
            headers: { "content-type": "application/json" }
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
            headers: { "content-type": "application/json" }
          }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    console.log("Memebot scheduled test running");
  
  }
};
