const BOT_NAME = "memebott";

const WALLET_ADDRESS = "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const LIVE_TRADING = true;

/*
  PROFIT / LOSS SETTINGS

  Take profit:
  Sell when position reaches +1%.

  Stop loss:
  Sell when position reaches -1%.
*/
const TAKE_PROFIT = 0.01;
const STOP_LOSS = -0.01;

/*
  TRADE SIZE

  Under $100 wallet:
  Maximum $5 per buy.

  $100+ wallet:
  Maximum $20 per buy.
*/
const SMALL_TRADE_CAP_USD = 5;
const LARGE_TRADE_CAP_USD = 20;
const BALANCE_THRESHOLD_USD = 100;

const MIN_SOL_RESERVE = 0.01;

const MAX_POSITIONS = 10;

const IMMEDIATE_LOSS_FILTER = 0.005;

const SLIPPAGE_BPS = 50;

const POSITION_KEY = "POSITIONS";
const COOLDOWN_KEY = "TRADE_COOLDOWN";
const COOLDOWN_SECONDS = 30;

const JUPITER_API = "https://api.jup.ag";
const PRICE_API = `${JUPITER_API}/price/v3`;
const TOKENS_API = `${JUPITER_API}/tokens/v2`;
const SWAP_API = `${JUPITER_API}/swap/v2`;

const HELIUS_RPC_BASE = "https://mainnet.helius-rpc.com";

/*
  Keep candidate discovery deliberately small.
*/
const MAX_CANDIDATES = 3;


/* =========================================================
   ROUTES
========================================================= */

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        return json({
          ok: true,
          bot: BOT_NAME,
          live_trading: LIVE_TRADING,
          take_profit_percent: TAKE_PROFIT * 100,
          stop_loss_percent: STOP_LOSS * 100,
          message: "memebott is running"
        });
      }

      if (url.pathname === "/status") {
        return json(await status(env));
      }

      if (url.pathname === "/test") {
        return json(await testBot(env));
      }

      if (url.pathname === "/run") {
        return json(await runBot(env, "manual"));
      }

      return json({
        ok: false,
        error: "Not found",
        routes: ["/", "/status", "/test", "/run"]
      }, 404);

    } catch (error) {
      return json({
        ok: false,
        bot: BOT_NAME,
        error: String(error?.message || error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBot(env, "cron").catch(error => {
        console.error("CRON ERROR:", error);
      })
    );
  }
};


/* =========================================================
   MAIN BOT
========================================================= */

async function runBot(env, source) {
  const result = {
    ok: true,
    bot: BOT_NAME,
    source,
    live_trading: LIVE_TRADING,
    wallet: WALLET_ADDRESS,

    sol_balance: null,
    sol_price_usd: null,
    wallet_value_usd: null,
    max_trade_usd: null,

    open_positions: 0,
    max_positions: MAX_POSITIONS,

    take_profit_percent:
      TAKE_PROFIT * 100,

    stop_loss_percent:
      STOP_LOSS * 100,

    actions: [],
    positions: []
  };

  try {
    validateEnv(env);

    const positions =
      await getPositions(env);

    result.open_positions =
      positions.length;

    result.positions =
      positions;

    /*
      Wallet balance.
    */
    const solBalance =
      await getSolBalance(env);

    /*
      SOL price.
    */
    const solPrice =
      await getSolPrice();

    const walletValueUsd =
      solBalance * solPrice;

    /*
      Trade size:
      Under $100 = $5 max.
      $100+ = $20 max.
    */
    const maxTradeUsd =
      walletValueUsd >=
      BALANCE_THRESHOLD_USD
        ? LARGE_TRADE_CAP_USD
        : SMALL_TRADE_CAP_USD;

    result.sol_balance =
      solBalance;

    result.sol_price_usd =
      solPrice;

    result.wallet_value_usd =
      Number(
        walletValueUsd.toFixed(4)
      );

    result.max_trade_usd =
      maxTradeUsd;

    /*
      Manage existing positions.
    */
    if (positions.length > 0) {
      const management =
        await managePositions(
          env,
          positions
        );

      if (management.length > 0) {
        result.actions.push(
          ...management
        );
      }
    }

    /*
      Reload positions after management.
    */
    const currentPositions =
      await getPositions(env);

    result.open_positions =
      currentPositions.length;

    result.positions =
      currentPositions;

    /*
      Maximum positions.
    */
    if (
      currentPositions.length >=
      MAX_POSITIONS
    ) {
      result.actions.push({
        action: "HOLD",
        reason:
          "Maximum positions reached"
      });

      return result;
    }

    /*
      Cooldown.
    */
    const cooldown =
      await getCooldown(env);

    if (cooldown.active) {
      result.actions.push({
        action: "HOLD",
        reason:
          "Trade cooldown active",
        seconds_remaining:
          cooldown.seconds_remaining
      });

      return result;
    }

    /*
      Available SOL after reserve.
    */
    const availableSol =
      solBalance -
      MIN_SOL_RESERVE;

    if (availableSol <= 0) {
      result.actions.push({
        action: "NO_TRADE",
        reason:
          "Insufficient SOL after reserve",
        min_sol_reserve:
          MIN_SOL_RESERVE
      });

      return result;
    }

    /*
      Find and buy.
    */
    const buyResult =
      await findAndBuy(
        env,
        solBalance,
        solPrice,
        walletValueUsd,
        maxTradeUsd,
        currentPositions
      );

    result.actions.push(
      buyResult.action
    );

    if (buyResult.position) {
      result.positions = [
        ...currentPositions,
        buyResult.position
      ];

      result.open_positions =
        result.positions.length;
    }

    return result;

  } catch (error) {
    result.ok = false;

    result.actions.push({
      action: "ERROR",
      error:
        String(
          error?.message ||
          error
        )
    });

    return result;
  }
}


/* =========================================================
   FIND AND BUY
========================================================= */

async function findAndBuy(
  env,
  solBalance,
  solPrice,
  walletValueUsd,
  maxTradeUsd,
  positions
) {
  try {
    /*
      ONE trending request.
    */
    const candidates =
      await getTrendingTokens();

    if (!candidates.length) {
      return {
        action: {
          action: "NO_TRADE",
          reason:
            "No trending candidates returned"
        }
      };
    }

    /*
      Never inspect more than 3 candidates.
    */
    const limitedCandidates =
      candidates.slice(
        0,
        MAX_CANDIDATES
      );

    /*
      Tokens already held.
    */
    const heldMints =
      new Set(
        positions.map(
          position => position.mint
        )
      );

    const filtered =
      limitedCandidates.filter(
        candidate =>
          candidate &&
          candidate.address &&
          candidate.address !== SOL_MINT &&
          !heldMints.has(
            candidate.address
          )
      );

    if (!filtered.length) {
      return {
        action: {
          action: "NO_TRADE",
          reason:
            "No eligible new candidates"
        }
      };
    }

    /*
      Try a maximum of 3 candidates.
    */
    for (const candidate of filtered) {
      const mint =
        candidate.address;

      try {
        /*
          Token decimals.
        */
        const decimals =
          await getTokenDecimals(
            env,
            mint
          );

        if (
          !Number.isInteger(decimals) ||
          decimals < 0 ||
          decimals > 18
        ) {
          continue;
        }

        /*
          Trade size.

          maxTradeUsd is:
          $5 under $100 wallet
          $20 at/above $100 wallet
        */
        const tradeUsd =
          Math.min(
            maxTradeUsd,
            walletValueUsd
          );

        if (tradeUsd <= 0) {
          continue;
        }

        /*
          USD -> SOL.
        */
        const tradeSol =
          tradeUsd / solPrice;

        /*
          Preserve reserve.
        */
        const maximumSpendableSol =
          Math.max(
            0,
            solBalance -
            MIN_SOL_RESERVE
          );

        const actualTradeSol =
          Math.min(
            tradeSol,
            maximumSpendableSol
          );

        if (actualTradeSol <= 0) {
          continue;
        }

        /*
          SOL -> lamports.
        */
        const lamports =
          Math.floor(
            actualTradeSol *
            1_000_000_000
          );

        if (lamports <= 0) {
          continue;
        }

        /*
          Jupiter buy order.
        */
        const order =
          await getOrder(
            mint,
            String(lamports)
          );

        if (
          !order ||
          !order.transaction ||
          !order.requestId
        ) {
          continue;
        }

        const expectedOutput =
          Number(
            order.outAmount || 0
          );

        if (
          !Number.isFinite(
            expectedOutput
          ) ||
          expectedOutput <= 0
        ) {
          continue;
        }

        /*
          Immediate loss filter.
        */
        const priceImpact =
          Number(
            order.priceImpactPct || 0
          );

        if (
          Number.isFinite(priceImpact) &&
          priceImpact >
            IMMEDIATE_LOSS_FILTER
        ) {
          continue;
        }

        /*
          TEST MODE.
        */
        if (!LIVE_TRADING) {
          return {
            action: {
              action: "TEST_BUY",
              token: mint,
              symbol:
                candidate.symbol ||
                null,
              trade_usd:
                Number(
                  tradeUsd.toFixed(2)
                ),
              trade_sol:
                actualTradeSol,
              expected_output:
                expectedOutput,
              message:
                "LIVE_TRADING is false; no transaction submitted"
            }
          };
        }

        /*
          ACTUAL JUPITER EXECUTION.
        */
        const execution =
          await executeOrder(
            env,
            order
          );

        if (!execution.success) {
          return {
            action: {
              action: "ERROR",
              error:
                `BUY EXECUTION FAILED: ${
                  execution.error ||
                  "Unknown Jupiter execution error"
                }`,
              token: mint,
              request_id:
                order.requestId ||
                null
            }
          };
        }

        /*
          Get entry price.
        */
        let entryPrice =
          await getTokenPrice(mint);

        /*
          If Jupiter price lookup is temporarily
          unavailable, calculate an approximate
          entry price from the actual trade size
          and expected token output.

          This prevents new successful buys
          from being saved with a null entry price.
        */
        if (
          !Number.isFinite(
            entryPrice
          ) ||
          entryPrice <= 0
        ) {
          const tokenAmount =
            expectedOutput /
            Math.pow(
              10,
              decimals
            );

          if (
            Number.isFinite(
              tokenAmount
            ) &&
            tokenAmount > 0
          ) {
            entryPrice =
              tradeUsd /
              tokenAmount;
          }
        }

        const position = {
          mint,

          symbol:
            candidate.symbol ||
            null,

          name:
            candidate.name ||
            null,

          decimals,

          entry_price_usd:
            Number.isFinite(
              entryPrice
            ) &&
            entryPrice > 0
              ? entryPrice
              : null,

          /*
            Profit tracking retained for
            position information.
          */
          highest_profit_percent: 0,

          amount_raw:
            String(
              expectedOutput
            ),

          amount:
            expectedOutput /
            Math.pow(
              10,
              decimals
            ),

          trade_usd:
            Number(
              tradeUsd.toFixed(2)
            ),

          trade_sol:
            actualTradeSol,

          opened_at:
            Date.now(),

          signature:
            execution.signature ||
            null
        };

        await savePosition(
          env,
          position
        );

        await setCooldown(env);

        return {
          action: {
            action: "BUY",
            token: mint,
            symbol:
              candidate.symbol ||
              null,
            trade_usd:
              Number(
                tradeUsd.toFixed(2)
              ),
            trade_sol:
              actualTradeSol,
            signature:
              execution.signature ||
              null,
            request_id:
              order.requestId ||
              null
          },
          position
        };

      } catch (candidateError) {
        console.error(
          "CANDIDATE ERROR:",
          mint,
          candidateError
        );
      }
    }

    return {
      action: {
        action: "NO_TRADE",
        reason:
          "No candidate produced a valid Jupiter trade route"
      }
    };

  } catch (error) {
    return {
      action: {
        action: "ERROR",
        error:
          `BUY ERROR: ${
            error?.message ||
            error
          }`
      }
    };
  }
}


/* =========================================================
   TRENDING TOKENS
========================================================= */

async function getTrendingTokens() {
  const response =
    await fetch(
      `${TOKENS_API}/toptrending/24h`,
      {
        method: "GET",
        headers: {
          "accept":
            "application/json"
        }
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Jupiter trending HTTP ${
        response.status
      }: ${text.slice(0, 300)}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      "Invalid Jupiter trending response"
    );
  }

  let list = [];

  if (Array.isArray(data)) {
    list = data;
  } else if (
    Array.isArray(data?.tokens)
  ) {
    list = data.tokens;
  } else if (
    Array.isArray(data?.data)
  ) {
    list = data.data;
  } else if (
    Array.isArray(data?.results)
  ) {
    list = data.results;
  }

  return list
    .map(item => ({
      address:
        item.address ||
        item.mint ||
        item.id ||
        null,

      symbol:
        item.symbol ||
        null,

      name:
        item.name ||
        null
    }))
    .filter(
      item => item.address
    );
}


/* =========================================================
   TOKEN PRICE
========================================================= */

async function getTokenPrice(mint) {
  try {
    const response =
      await fetch(
        `${PRICE_API}?ids=${encodeURIComponent(
          mint
        )}`,
        {
          method: "GET",
          headers: {
            "accept":
              "application/json"
          }
        }
      );

    if (!response.ok) {
      return null;
    }

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      return null;
    }

    const item =
      data?.data?.[mint] ||
      data?.[mint] ||
      null;

    if (!item) {
      return null;
    }

    const price =
      Number(
        item.usdPrice ??
        item.price ??
        null
      );

    return Number.isFinite(price) &&
      price > 0
      ? price
      : null;

  } catch {
    return null;
  }
}


/* =========================================================
   SOL PRICE
========================================================= */

async function getSolPrice() {
  const response =
    await fetch(
      `${PRICE_API}?ids=${SOL_MINT}`,
      {
        method: "GET",
        headers: {
          "accept":
            "application/json"
        }
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `SOL price HTTP ${
        response.status
      }: ${text.slice(0, 500)}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid SOL price JSON: ${
        text.slice(0, 500)
      }`
    );
  }

  const item =
    data?.data?.[SOL_MINT] ||
    data?.[SOL_MINT] ||
    null;

  if (!item) {
    throw new Error(
      `SOL price not found in Jupiter response: ${
        text.slice(0, 500)
      }`
    );
  }

  const price =
    Number(
      item.usdPrice ??
      item.price ??
      item.usd ??
      null
    );

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      `Invalid SOL price value from Jupiter: ${
        text.slice(0, 500)
      }`
    );
  }

  return price;
}


/* =========================================================
   JUPITER BUY ORDER
========================================================= */

async function getOrder(
  outputMint,
  amount
) {
  const url =
    new URL(
      `${SWAP_API}/order`
    );

  url.searchParams.set(
    "inputMint",
    SOL_MINT
  );

  url.searchParams.set(
    "outputMint",
    outputMint
  );

  url.searchParams.set(
    "amount",
    amount
  );

  url.searchParams.set(
    "taker",
    WALLET_ADDRESS
  );

  url.searchParams.set(
    "slippageBps",
    String(SLIPPAGE_BPS)
  );

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",
        headers: {
          "accept":
            "application/json"
        }
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    console.error(
      "JUPITER ORDER ERROR:",
      response.status,
      text
    );

    throw new Error(
      `Jupiter order HTTP ${
        response.status
      }`
    );
  }

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      "Invalid Jupiter order response"
    );
  }

  if (
    !data?.transaction ||
    !data?.requestId
  ) {
    return null;
  }

  return data;
}


/* =========================================================
   JUPITER EXECUTION
========================================================= */

async function executeOrder(
  env,
  order
) {
  try {
    if (!env.WALLET_PRIVATE_KEY) {
      throw new Error(
        "WALLET_PRIVATE_KEY secret is missing"
      );
    }

    const transaction =
      base64ToBytes(
        order.transaction
      );

    const signedTransaction =
      await signSolanaTransaction(
        transaction,
        env.WALLET_PRIVATE_KEY
      );

    const response =
      await fetch(
        `${SWAP_API}/execute`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json",
            "accept":
              "application/json"
          },
          body:
            JSON.stringify({
              signedTransaction:
                bytesToBase64(
                  signedTransaction
                ),
              requestId:
                order.requestId
            })
        }
      );

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      data = {
        raw: text
      };
    }

    if (!response.ok) {
      console.error(
        "JUPITER EXECUTE HTTP ERROR:",
        response.status,
        data
      );

      return {
        success: false,
        error:
          data?.error ||
          data?.message ||
          `HTTP ${response.status}`
      };
    }

    const status =
      String(
        data?.status || ""
      ).toLowerCase();

    const success =
      status === "success" ||
      Boolean(
        data?.signature &&
        !data?.error
      );

    if (!success) {
      return {
        success: false,
        error:
          data?.error ||
          data?.message ||
          data?.status ||
          "Jupiter execution was not successful"
      };
    }

    return {
      success: true,

      signature:
        data?.signature ||
        data?.txid ||
        data?.transactionSignature ||
        null,

      raw: data
    };

  } catch (error) {
    console.error(
      "EXECUTE ERROR:",
      error
    );

    return {
      success: false,
      error:
        String(
          error?.message ||
          error
        )
    };
  }
}


/* =========================================================
   POSITION MANAGEMENT
========================================================= */

async function managePositions(
  env,
  positions
) {
  const actions = [];

  /*
    Check every open position.
  */
  for (const position of positions) {
    try {
      if (!position?.mint) {
        continue;
      }

      const currentPrice =
        await getTokenPrice(
          position.mint
        );

      /*
        Entry price is required to calculate
        profit/loss.

        Existing positions that already have
        a null entry price will remain protected
        from automatic selling rather than using
        an invented entry price.
      */
      if (
        !Number.isFinite(
          currentPrice
        ) ||
        !Number.isFinite(
          position.entry_price_usd
        ) ||
        position.entry_price_usd <= 0
      ) {
        actions.push({
          action: "HOLD",
          token:
            position.mint,
          symbol:
            position.symbol ||
            null,
          reason:
            "Entry price unavailable; position not automatically sold"
        });

        continue;
      }

      const change =
        (
          currentPrice -
          position.entry_price_usd
        ) /
        position.entry_price_usd;

      /*
        Highest profit tracking.
      */
      const previousHighest =
        Number.isFinite(
          Number(
            position.highest_profit_percent
          )
        )
          ? Number(
              position.highest_profit_percent
            ) / 100
          : 0;

      const highestProfit =
        Math.max(
          previousHighest,
          change
        );

      /*
        Save a new highest profit.
      */
      if (
        highestProfit >
        previousHighest
      ) {
        position.highest_profit_percent =
          Number(
            (
              highestProfit * 100
            ).toFixed(3)
          );

        await savePosition(
          env,
          position
        );
      }

      /*
        HARD STOP LOSS
        Sell at -1% or worse.
      */
      if (
        change <=
        STOP_LOSS
      ) {
        actions.push(
          await sellPosition(
            env,
            position,
            "STOP_LOSS"
          )
        );

        continue;
      }

      /*
        TAKE PROFIT
        Sell at +1% or better.

        This replaces the old 3%
        trailing-stop behavior.
      */
      if (
        change >=
        TAKE_PROFIT
      ) {
        actions.push(
          await sellPosition(
            env,
            position,
            "TAKE_PROFIT"
          )
        );

        continue;
      }

      /*
        Still holding.
      */
      actions.push({
        action: "HOLD",

        token:
          position.mint,

        symbol:
          position.symbol ||
          null,

        current_price_usd:
          currentPrice,

        entry_price_usd:
          position.entry_price_usd,

        change_percent:
          Number(
            (
              change * 100
            ).toFixed(3)
          ),

        highest_profit_percent:
          Number(
            (
              highestProfit * 100
            ).toFixed(3)
          ),

        take_profit_percent:
          TAKE_PROFIT * 100,

        stop_loss_percent:
          STOP_LOSS * 100
      });

    } catch (error) {
      actions.push({
        action: "ERROR",
        token:
          position?.mint ||
          null,
        error:
          `POSITION ERROR: ${
            error?.message ||
            error
          }`
      });
    }
  }

  return actions;
}


/* =========================================================
   SELL
========================================================= */

async function sellPosition(
  env,
  position,
  reason
) {
  try {
    const balance =
      await getTokenBalance(
        env,
        position.mint
      );

    if (
      !balance ||
      balance <= 0
    ) {
      await removePosition(
        env,
        position.mint
      );

      return {
        action:
          "SELL_CLEANUP",

        token:
          position.mint,

        reason:
          "No token balance found"
      };
    }

    const order =
      await getSellOrder(
        position.mint,
        String(balance)
      );

    if (!order) {
      return {
        action: "ERROR",

        token:
          position.mint,

        error:
          "No Jupiter sell route"
      };
    }

    if (!LIVE_TRADING) {
      return {
        action:
          "TEST_SELL",

        token:
          position.mint,

        reason
      };
    }

    const execution =
      await executeOrder(
        env,
        order
      );

    if (!execution.success) {
      return {
        action: "ERROR",

        token:
          position.mint,

        error:
          `SELL EXECUTION FAILED: ${
            execution.error ||
            "Unknown error"
          }`
      };
    }

    /*
      Only remove the position after
      successful execution.
    */
    await removePosition(
      env,
      position.mint
    );

    await setCooldown(env);

    return {
      action: "SELL",

      token:
        position.mint,

      symbol:
        position.symbol ||
        null,

      reason,

      signature:
        execution.signature ||
        null
    };

  } catch (error) {
    return {
      action: "ERROR",

      token:
        position?.mint ||
        null,

      error:
        `SELL ERROR: ${
          error?.message ||
          error
        }`
    };
  }
}


/* =========================================================
   SELL ORDER
========================================================= */

async function getSellOrder(
  tokenMint,
  amount
) {
  const url =
    new URL(
      `${SWAP_API}/order`
    );

  url.searchParams.set(
    "inputMint",
    tokenMint
  );

  url.searchParams.set(
    "outputMint",
    SOL_MINT
  );

  url.searchParams.set(
    "amount",
    amount
  );

  url.searchParams.set(
    "taker",
    WALLET_ADDRESS
  );

  url.searchParams.set(
    "slippageBps",
    String(SLIPPAGE_BPS)
  );

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",
        headers: {
          "accept":
            "application/json"
        }
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    console.error(
      "SELL ORDER ERROR:",
      response.status,
      text
    );

    throw new Error(
      `Jupiter sell order HTTP ${
        response.status
      }`
    );
  }

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      "Invalid Jupiter sell response"
    );
  }

  if (
    !data?.transaction ||
    !data?.requestId
  ) {
    return null;
  }

  return data;
}


/* =========================================================
   TEST
========================================================= */

async function testBot(env) {
  try {
    validateEnv(env);

    const solBalance =
      await getSolBalance(env);

    const solPrice =
      await getSolPrice();

    const walletValueUsd =
      solBalance *
      solPrice;

    const maxTradeUsd =
      walletValueUsd >=
      BALANCE_THRESHOLD_USD
        ? LARGE_TRADE_CAP_USD
        : SMALL_TRADE_CAP_USD;

    const positions =
      await getPositions(env);

    const cooldown =
      await getCooldown(env);

    let candidates = [];
    let trendingError = null;

    try {
      candidates =
        await getTrendingTokens();
    } catch (error) {
      trendingError =
        String(
          error?.message ||
          error
        );
    }

    return {
      ok: true,

      bot: BOT_NAME,

      live_trading:
        LIVE_TRADING,

      wallet:
        WALLET_ADDRESS,

      sol_balance:
        solBalance,

      sol_price_usd:
        solPrice,

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

      max_positions:
        MAX_POSITIONS,

      open_positions:
        positions.length,

      take_profit_percent:
        TAKE_PROFIT * 100,

      stop_loss_percent:
        STOP_LOSS * 100,

      cooldown_active:
        cooldown.active,

      positions,

      candidate_limit:
        MAX_CANDIDATES,

      trending_candidates:
        candidates.slice(
          0,
          MAX_CANDIDATES
        ),

      trending_error:
        trendingError,

      message:
        "TEST NEVER BUYS OR SELLS"
    };

  } catch (error) {
    return {
      ok: false,

      bot: BOT_NAME,

      error:
        String(
          error?.message ||
          error
        )
    };
  }
}


/* =========================================================
   STATUS
========================================================= */

async function status(env) {
  try {
    validateEnv(env);

    const solBalance =
      await getSolBalance(env);

    const solPrice =
      await getSolPrice();

    const walletValueUsd =
      solBalance *
      solPrice;

    const maxTradeUsd =
      walletValueUsd >=
      BALANCE_THRESHOLD_USD
        ? LARGE_TRADE_CAP_USD
        : SMALL_TRADE_CAP_USD;

    const positions =
      await getPositions(env);

    const cooldown =
      await getCooldown(env);

    return {
      ok: true,

      bot: BOT_NAME,

      live_trading:
        LIVE_TRADING,

      wallet:
        WALLET_ADDRESS,

      sol_balance:
        solBalance,

      sol_price_usd:
        solPrice,

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

      max_positions:
        MAX_POSITIONS,

      open_positions:
        positions.length,

      take_profit_percent:
        TAKE_PROFIT * 100,

      stop_loss_percent:
        STOP_LOSS * 100,

      cooldown_active:
        cooldown.active,

      positions
    };

  } catch (error) {
    return {
      ok: false,

      bot: BOT_NAME,

      error:
        String(
          error?.message ||
          error
        )
    };
  }
}


/* =========================================================
   SOL BALANCE
========================================================= */

async function getSolBalance(env) {
  const result =
    await heliusRpc(
      env,
      "getBalance",
      [WALLET_ADDRESS]
    );

  const lamports =
    Number(
      result?.value || 0
    );

  return (
    lamports /
    1_000_000_000
  );
}


/* =========================================================
   TOKEN BALANCE
========================================================= */

async function getTokenBalance(
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
          encoding:
            "jsonParsed"
        }
      ]
    );

  const accounts =
    result?.value || [];

  let total = 0;

  for (
    const account of accounts
  ) {
    const amount =
      account
        ?.account
        ?.data
        ?.parsed
        ?.info
        ?.tokenAmount
        ?.amount;

    if (amount) {
      total += Number(amount);
    }
  }

  return total;
}


/* =========================================================
   TOKEN DECIMALS
========================================================= */

async function getTokenDecimals(
  env,
  mint
) {
  const result =
    await heliusRpc(
      env,
      "getTokenSupply",
      [mint]
    );

  const decimals =
    result?.value?.decimals;

  if (
    !Number.isInteger(
      decimals
    )
  ) {
    throw new Error(
      `Could not determine token decimals for ${mint}`
    );
  }

  return decimals;
}


/* =========================================================
   HELIUS RPC
========================================================= */

async function heliusRpc(
  env,
  method,
  params
) {
  if (!env.HELIUS_API_KEY) {
    throw new Error(
      "HELIUS_API_KEY secret is missing"
    );
  }

  const url =
    `${HELIUS_RPC_BASE}/?api-key=${encodeURIComponent(
      env.HELIUS_API_KEY
    )}`;

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params
          })
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Helius HTTP ${
        response.status
      }: ${text}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      "Invalid Helius response"
    );
  }

  if (data.error) {
    throw new Error(
      data.error.message ||
      "Helius RPC error"
    );
  }

  return data.result;
}


/* =========================================================
   KV POSITIONS
========================================================= */

async function getPositions(env) {
  if (!env.BOT_KV) {
    throw new Error(
      "BOT_KV binding is missing"
    );
  }

  const value =
    await env.BOT_KV.get(
      POSITION_KEY
    );

  if (!value) {
    return [];
  }

  try {
    const positions =
      JSON.parse(value);

    return Array.isArray(
      positions
    )
      ? positions
      : [];

  } catch {
    return [];
  }
}


async function savePosition(
  env,
  position
) {
  const positions =
    await getPositions(env);

  const existingIndex =
    positions.findIndex(
      p =>
        p.mint ===
        position.mint
    );

  if (existingIndex >= 0) {
    positions[
      existingIndex
    ] = position;
  } else {
    positions.push(
      position
    );
  }

  await env.BOT_KV.put(
    POSITION_KEY,
    JSON.stringify(
      positions
    )
  );
}


async function removePosition(
  env,
  mint
) {
  const positions =
    await getPositions(env);

  const remaining =
    positions.filter(
      p =>
        p.mint !== mint
    );

  await env.BOT_KV.put(
    POSITION_KEY,
    JSON.stringify(
      remaining
    )
  );
}


/* =========================================================
   COOLDOWN
========================================================= */

async function getCooldown(env) {
  const value =
    await env.BOT_KV.get(
      COOLDOWN_KEY
    );

  if (!value) {
    return {
      active: false,
      seconds_remaining: 0
    };
  }

  const timestamp =
    Number(value);

  if (
    !Number.isFinite(
      timestamp
    )
  ) {
    return {
      active: false,
      seconds_remaining: 0
    };
  }

  const elapsed =
    Math.floor(
      (
        Date.now() -
        timestamp
      ) / 1000
    );

  const remaining =
    COOLDOWN_SECONDS -
    elapsed;

  if (remaining <= 0) {
    return {
      active: false,
      seconds_remaining: 0
    };
  }

  return {
    active: true,
    seconds_remaining:
      remaining
  };
}


async function setCooldown(env) {
  await env.BOT_KV.put(
    COOLDOWN_KEY,
    String(Date.now())
  );
}


/* =========================================================
   PRIVATE KEY / SOLANA SIGNING
========================================================= */

async function signSolanaTransaction(
  transaction,
  privateKeyValue
) {
  let offset = 0;

  const decoded =
    decodeShortVec(
      transaction,
      offset
    );

  const signatureCount =
    decoded.value;

  offset =
    decoded.offset;

  if (
    signatureCount <= 0
  ) {
    throw new Error(
      "Transaction has no signature slots"
    );
  }

  const signaturesStart =
    offset;

  const messageStart =
    signaturesStart +
    signatureCount * 64;

  if (
    messageStart >=
    transaction.length
  ) {
    throw new Error(
      "Invalid Solana transaction"
    );
  }

  const message =
    transaction.slice(
      messageStart
    );

  const privateKey =
    await importPrivateKey(
      privateKeyValue
    );

  const signature =
    new Uint8Array(
      await crypto.subtle.sign(
        {
          name:
            "Ed25519"
        },
        privateKey,
        message
      )
    );

  if (
    signature.length !== 64
  ) {
    throw new Error(
      "Invalid Ed25519 signature length"
    );
  }

  const signed =
    new Uint8Array(
      transaction
    );

  signed.set(
    signature,
    signaturesStart
  );

  return signed;
}


/* =========================================================
   PRIVATE KEY IMPORT
========================================================= */

async function importPrivateKey(
  value
) {
  let bytes;

  const trimmed =
    String(value).trim();

  if (
    trimmed.startsWith("[")
  ) {
    let array;

    try {
      array =
        JSON.parse(
          trimmed
        );
    } catch {
      throw new Error(
        "WALLET_PRIVATE_KEY JSON is invalid"
      );
    }

    if (
      !Array.isArray(array)
    ) {
      throw new Error(
        "WALLET_PRIVATE_KEY must be an array"
      );
    }

    bytes =
      new Uint8Array(
        array
      );

  } else {
    bytes =
      base58ToBytes(
        trimmed
      );
  }

  if (
    bytes.length === 64
  ) {
    bytes =
      bytes.slice(
        0,
        32
      );
  }

  if (
    bytes.length !== 32
  ) {
    throw new Error(
      `WALLET_PRIVATE_KEY must decode to 32 or 64 bytes; got ${bytes.length}`
    );
  }

  const pkcs8Prefix =
    new Uint8Array([
      0x30, 0x2e,
      0x02, 0x01, 0x00,
      0x30, 0x05,
      0x06, 0x03,
      0x2b, 0x65, 0x70,
      0x04, 0x22,
      0x04, 0x20
    ]);

  const keyBytes =
    new Uint8Array(
      pkcs8Prefix.length +
      bytes.length
    );

  keyBytes.set(
    pkcs8Prefix,
    0
  );

  keyBytes.set(
    bytes,
    pkcs8Prefix.length
  );

  return crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    {
      name:
        "Ed25519"
    },
    false,
    ["sign"]
  );
}


/* =========================================================
   BASE58
========================================================= */

function base58ToBytes(
  value
) {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let num = 0n;

  for (
    const char of value
  ) {
    const index =
      alphabet.indexOf(
        char
      );

    if (
      index < 0
    ) {
      throw new Error(
        "Invalid base58 private key"
      );
    }

    num =
      num * 58n +
      BigInt(index);
  }

  const bytes = [];

  while (
    num > 0n
  ) {
    bytes.push(
      Number(
        num & 255n
      )
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
    ...new Array(
      leadingZeros
    ).fill(0),
    ...bytes
  ]);
}


/* =========================================================
   BASE64
========================================================= */

function base64ToBytes(
  base64
) {
  const binary =
    atob(base64);

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


function bytesToBase64(
  bytes
) {
  let binary = "";

  const chunkSize =
    0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    binary +=
      String.fromCharCode(
        ...bytes.slice(
          i,
          i + chunkSize
        )
      );
  }

  return btoa(
    binary
  );
}


/* =========================================================
   SHORTVEC
========================================================= */

function decodeShortVec(
  bytes,
  offset
) {
  let value = 0;
  let shift = 0;

  while (true) {
    if (
      offset >=
      bytes.length
    ) {
      throw new Error(
        "Invalid shortvec encoding"
      );
    }

    const byte =
      bytes[offset++];

    value |=
      (byte & 0x7f) <<
      shift;

    if (
      (byte & 0x80) === 0
    ) {
      break;
    }

    shift += 7;

    if (
      shift > 28
    ) {
      throw new Error(
        "Shortvec value too large"
      );
    }
  }

  return {
    value,
    offset
  };
}


/* =========================================================
   VALIDATION
========================================================= */

function validateEnv(env) {
  if (!env.BOT_KV) {
    throw new Error(
      "BOT_KV binding is missing"
    );
  }

  if (!env.HELIUS_API_KEY) {
    throw new Error(
      "HELIUS_API_KEY secret is missing"
    );
  }

  if (!env.WALLET_PRIVATE_KEY) {
    throw new Error(
      "WALLET_PRIVATE_KEY secret is missing"
    );
  }
}


/* =========================================================
   JSON RESPONSE
========================================================= */

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );
    }
