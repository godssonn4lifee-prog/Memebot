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
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.pathname === "/status") {
      const lastRun = await env.BOT_KV.get("last_run");
      const lastSignal = await env.BOT_KV.get("last_signal");

      return new Response(
        JSON.stringify({
          bot: "Memebot",
          trading: "DISABLED",
          last_run: lastRun,
          last_signal: lastSignal
        }, null, 2),
        {
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    const now = new Date().toISOString();

    await env.BOT_KV.put("last_run", now);

    // Safe mode:
    // No trades are executed.
    // No wallet keys are used.
    // This is where the trading strategy will eventually run.

    await env.BOT_KV.put(
      "last_signal",
      JSON.stringify({
        time: now,
        action: "HOLD",
        reason: "Trading is disabled while the bot is being tested."
      })
    );

    console.log("Memebot scheduled run:", now);
  }
};
