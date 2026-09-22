const WALLET_ADDRESS = "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Memebot is running. Trading is DISABLED.");
    }

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

    return new Response("Not found", { status: 404 });
  },

  async scheduled() {
    console.log("Memebot scheduled test running");
  }
};
