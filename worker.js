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
  - Activates at +3%
  - Tracks the highest price reached
  - Sells when price falls 1.25%
    from that highest price
*/
const STOP_LOSS = -0.02;

const TRAILING_ACTIVATION = 0.03;
const TRAILING_DISTANCE = 0.0125;

/*
  TRADE SIZE

  Under $100 wallet: $5 maximum
  $100+ wallet:      $20 maximum
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

/*
  Trending-token cache.
*/
const TRENDING_CACHE_KEY =
  "JUPITER_TRENDING_CACHE";

const TRENDING_CACHE_SECONDS = 120;

const TRENDING_BACKOFF_KEY =
  "JUPITER_TRENDING_BACKOFF";

const TRENDING_BACKOFF_SECONDS = 120;

const JUPITER_API =
  "https://api.jup.ag";

const PRICE_API =
  `${JUPITER_API}/price/v3`;

const TOKENS_API =
  `${JUPITER_API}/tokens/v2`;

const SWAP_API =
  `${JUPITER_API}/swap/v2`;

const HELIUS_RPC_BASE =
  "https://mainnet.helius-rpc.com";

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
          trailing_activation_percent:
            TRAILING_ACTIVATION * 100,
          trailing_distance_percent:
            TRAILING_DISTANCE * 100,
          stop_loss_percent:
            STOP_LOSS * 100,
          message: "memebott is running"
        });
      }

      if (url.pathname === "/status") {
        return json(await status(env));
      }

      if (url.pathname === "/test") {
        return json(await testBot(env));
      }

      /*
        SAFE REPAIR ROUTE.

        This repairs missing entry prices in KV.
        It NEVER buys and NEVER sells.
      */
      if (url.pathname === "/repair") {
        return json(await repairPositions(env));
      }

      if (url.pathname === "/run") {
        return json(await runBot(env, "manual"));
      }

      return json(
        {
          ok: false,
          error: "Not found",
          routes: [
            "/",
            "/status",
            "/test",
            "/repair",
            "/run"
          ]
        },
        404
      );

    } catch (error) {
      return json(
        {
          ok: false,
          bot: BOT_NAME,
          error: String(
            error?.message || error
          )
        },
        500
      );
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

    trailing_activation_percent:
      TRAILING_ACTIVATION * 100,

    trailing_distance_percent:
      TRAILING_DISTANCE * 100,

    stop_loss_percent:
      STOP_LOSS * 100,

    actions: [],
    positions: []
  };

  try {
    validateEnv(env);

    /*
      Repair missing entry prices BEFORE
      management evaluates positions.
    */
    const repair =
      await repairMissingEntryPrices(env);

    if (repair.repaired.length > 0) {
      result.actions.push({
        action: "POSITION_REPAIR",
        repaired: repair.repaired
      });
    }

    let positions =
      await getPositions(env);

    result.open_positions =
      positions.length;

    result.positions =
      positions;

    const solBalance =
      await getSolBalance(env);

    const solPrice =
      await getSolPrice();

    const walletValueUsd =
      solBalance * solPrice;

    const maxTradeUsd =
      walletValueUsd >= BALANCE_THRESHOLD_USD
        ? LARGE_TRADE_CAP_USD
        : SMALL_TRADE_CAP_USD;

    result.sol_balance =
      solBalance;

    result.sol_price_usd =
      solPrice;

    result.wallet_value_usd =
      Number(walletValueUsd.toFixed(4));

    result.max_trade_usd =
      maxTradeUsd;

    /*
      Manage existing positions FIRST.
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
      Reload after management.
    */
    const currentPositions =
      await getPositions(env);

    result.open_positions =
      currentPositions.length;

    result.positions =
      currentPositions;

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

    const buyResult =
      await findAndBuy(
        env,
        solBalance,
        solPrice,
        walletValueUsd,
        maxTradeUsd,
        currentPositions
      );

    if (buyResult.action) {
      result.actions.push(
        buyResult.action
      );
    }

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
      error: String(
        error?.message || error
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
    const candidates =
      await getTrendingTokens(env);

    if (!candidates.length) {
      return {
        action: {
          action: "NO_TRADE",
          reason:
            "No trending candidates available"
        }
      };
    }

    const limitedCandidates =
      candidates.slice(
        0,
        MAX_CANDIDATES
      );

    const heldMints =
      new Set(
        positions.map(
          position =>
            position.mint
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

    for (const candidate of filtered) {
      const mint =
        candidate.address;

      try {
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

        const tradeUsd =
          Math.min(
            maxTradeUsd,
            walletValueUsd
          );

        if (tradeUsd <= 0) {
          continue;
        }

        const tradeSol =
          tradeUsd / solPrice;

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

        const lamports =
          Math.floor(
            actualTradeSol *
              1_000_000_000
          );

        if (lamports <= 0) {
          continue;
        }

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

        if (!LIVE_TRADING) {
          return {
            action: {
              action: "TEST_BUY",
              token: mint,
              symbol:
                candidate.symbol || null,
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
                order.requestId || null
            }
          };
        }

        let entryPrice =
          await getTokenPrice(mint);

        if (
          !Number.isFinite(entryPrice) ||
          entryPrice <= 0
        ) {
          const tokenAmount =
            expectedOutput /
            Math.pow(
              10,
              decimals
            );

          if (
            Number.isFinite(tokenAmount) &&
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
            candidate.symbol || null,

          name:
            candidate.name || null,

          decimals,

          entry_price_usd:
            Number.isFinite(entryPrice) &&
            entryPrice > 0
              ? entryPrice
              : null,

          /*
            Highest price begins at entry.
            Trailing is NOT active until +3%.
          */
          highest_price_usd:
            Number.isFinite(entryPrice) &&
            entryPrice > 0
              ? entryPrice
              : null,

          highest_profit_percent: 0,

          trailing_active: false,

          amount_raw:
            String(expectedOutput),

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
            execution.signature || null
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
              candidate.symbol || null,
            trade_usd:
              Number(
                tradeUsd.toFixed(2)
              ),
            trade_sol:
              actualTradeSol,
            signature:
              execution.signature || null,
            request_id:
              order.requestId || null
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
        action: "NO_TRADE",
        reason:
          String(
            error?.message || error
          )
      }
    };
  }
}


/* =========================================================
   TRENDING TOKENS
========================================================= */

async function getTrendingTokens(env) {
  const backoff =
    await getTrendingBackoff(env);

  if (backoff.active) {
    const cached =
      await getTrendingCache(env);

    if (cached.length > 0) {
      return cached;
    }

    return [];
  }

  const cached =
    await getTrendingCache(env);

  if (cached.length > 0) {
    return cached;
  }

  const response =
    await fetch(
      `${TOKENS_API}/toptrending/24h`,
      {
        method: "GET",
        headers: {
          accept:
            "application/json"
        }
      }
    );

  const text =
    await response.text();

  if (response.status === 429) {
    console.error(
      "JUPITER TRENDING 429:",
      text
    );

    await setTrendingBackoff(env);

    return await getTrendingCache(
      env,
      true
    );
  }

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

  const normalized =
    list
      .map(item => ({
        address:
          item.address ||
          item.mint ||
          item.id ||
          null,

        symbol:
          item.symbol || null,

        name:
          item.name || null
      }))
      .filter(
        item => item.address
      );

  if (normalized.length > 0) {
    await saveTrendingCache(
      env,
      normalized
    );
  }

  return normalized;
}


/* =========================================================
   TRENDING CACHE
========================================================= */

async function getTrendingCache(
  env,
  allowStale = false
) {
  try {
    if (!env.BOT_KV) {
      return [];
    }

    const value =
      await env.BOT_KV.get(
        TRENDING_CACHE_KEY
      );

    if (!value) {
      return [];
    }

    const data =
      JSON.parse(value);

    if (
      !Array.isArray(data?.tokens)
    ) {
      return [];
    }

    const timestamp =
      Number(data.timestamp);

    if (
      !Number.isFinite(timestamp)
    ) {
      return [];
    }

    const ageSeconds =
      (Date.now() - timestamp) /
      1000;

    if (
      !allowStale &&
      ageSeconds >
        TRENDING_CACHE_SECONDS
    ) {
      return [];
    }

    return data.tokens;

  } catch {
    return [];
  }
}


async function saveTrendingCache(
  env,
  tokens
) {
  try {
    await env.BOT_KV.put(
      TRENDING_CACHE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        tokens
      })
    );
  } catch (error) {
    console.error(
      "TRENDING CACHE SAVE ERROR:",
      error
    );
  }
}


async function getTrendingBackoff(env) {
  try {
    const value =
      await env.BOT_KV.get(
        TRENDING_BACKOFF_KEY
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
      !Number.isFinite(timestamp)
    ) {
      return {
        active: false,
        seconds_remaining: 0
      };
    }

    const elapsed =
      (Date.now() - timestamp) /
      1000;

    const remaining =
      TRENDING_BACKOFF_SECONDS -
      elapsed;

    if (remaining <= 0) {
      await env.BOT_KV.delete(
        TRENDING_BACKOFF_KEY
      );

      return {
        active: false,
        seconds_remaining: 0
      };
    }

    return {
      active: true,
      seconds_remaining:
        Math.ceil(remaining)
    };

  } catch {
    return {
      active: false,
      seconds_remaining: 0
    };
  }
}


async function setTrendingBackoff(env) {
  await env.BOT_KV.put(
    TRENDING_BACKOFF_KEY,
    String(Date.now())
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
            accept:
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
          accept:
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
          accept:
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

  for (
    const originalPosition of positions
  ) {
    try {
      if (!originalPosition?.mint) {
        continue;
      }

      const position = {
        ...originalPosition
      };

      /*
        Recover missing entry price.
      */
      if (
        !Number.isFinite(
          Number(
            position.entry_price_usd
          )
        ) ||
        Number(
          position.entry_price_usd
        ) <= 0
      ) {
        const storedTradeUsd =
          Number(
            position.trade_usd
          );

        const storedAmount =
          Number(
            position.amount
          );

        if (
          Number.isFinite(
            storedTradeUsd
          ) &&
          storedTradeUsd > 0 &&
          Number.isFinite(
            storedAmount
          ) &&
          storedAmount > 0
        ) {
          const recoveredEntryPrice =
            storedTradeUsd /
            storedAmount;

          if (
            Number.isFinite(
              recoveredEntryPrice
            ) &&
            recoveredEntryPrice > 0
          ) {
            position.entry_price_usd =
              recoveredEntryPrice;

            await savePosition(
              env,
              position
            );
          }
        }
      }

      const entryPrice =
        Number(
          position.entry_price_usd
        );

      const currentPrice =
        await getTokenPrice(
          position.mint
        );

      if (
        !Number.isFinite(
          currentPrice
        ) ||
        currentPrice <= 0 ||
        !Number.isFinite(
          entryPrice
        ) ||
        entryPrice <= 0
      ) {
        actions.push({
          action: "HOLD",
          token:
            position.mint,
          symbol:
            position.symbol || null,
          reason:
            "Entry or current price unavailable; position not automatically sold"
        });

        continue;
      }

      /*
        Current profit/loss relative to entry.
      */
      const change =
        (
          currentPrice -
          entryPrice
        ) /
        entryPrice;

      /*
        Recover or initialize highest price.
      */
      let highestPrice =
        Number(
          position.highest_price_usd
        );

      if (
        !Number.isFinite(
          highestPrice
        ) ||
        highestPrice <= 0
      ) {
        highestPrice =
          entryPrice;
      }

      /*
        Update highest price whenever
        the token makes a new high.
      */
      if (
        currentPrice >
        highestPrice
      ) {
        highestPrice =
          currentPrice;
      }

      /*
        Highest profit is retained for
        status/debugging.
      */
      const highestProfit =
        (
          highestPrice -
          entryPrice
        ) /
        entryPrice;

      position.highest_price_usd =
        highestPrice;

      position.highest_profit_percent =
        Number(
          (
            highestProfit *
            100
          ).toFixed(3)
        );

      /*
        Trailing activates once the position
        has reached +3%.
      */
      let trailingActive =
        Boolean(
          position.trailing_active
        );

      if (
        highestProfit >=
        TRAILING_ACTIVATION
      ) {
        trailingActive = true;
      }

      position.trailing_active =
        trailingActive;

      /*
        Save the updated high/trailing state.
      */
      await savePosition(
        env,
        position
      );

      /*
        HARD STOP: -2%

        This is checked regardless of
        whether trailing has activated.
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
        TRAILING STOP

        Once +3% has been reached, the bot
        sells only if the current price has
        fallen 1.25% from the highest price.
      */
      if (
        trailingActive
      ) {
        const trailingSellPrice =
          highestPrice *
          (
            1 -
            TRAILING_DISTANCE
          );

        if (
          currentPrice <=
          trailingSellPrice
        ) {
          actions.push(
            await sellPosition(
              env,
              position,
              "TRAILING_STOP"
            )
          );

          continue;
        }
      }

      actions.push({
        action: "HOLD",

        token:
          position.mint,

        symbol:
          position.symbol || null,

        current_price_usd:
          currentPrice,

        entry_price_usd:
          entryPrice,

        change_percent:
          Number(
            (
              change *
              100
            ).toFixed(3)
          ),

        highest_price_usd:
          highestPrice,

        highest_profit_percent:
          Number(
            (
              highestProfit *
              100
            ).toFixed(3)
          ),

        trailing_active:
          trailingActive,

        trailing_activation_percent:
          TRAILING_ACTIVATION *
          100,

        trailing_distance_percent:
          TRAILING_DISTANCE *
          100,

        trailing_sell_price_usd:
          trailingActive
            ? Number(
                (
                  highestPrice *
                  (
                    1 -
                    TRAILING_DISTANCE
                  )
                ).toFixed(10)
              )
            : null,

        stop_loss_percent:
          STOP_LOSS * 100
      });

    } catch (error) {
      actions.push({
        action: "ERROR",

        token:
          originalPosition?.mint ||
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
   SAFE POSITION REPAIR
========================================================= */

async function repairMissingEntryPrices(
  env
) {
  const positions =
    await getPositions(env);

  const repaired = [];

  let changed = false;

  for (
    const originalPosition of positions
  ) {
    const position = {
      ...originalPosition
    };

    if (!position?.mint) {
      continue;
    }

    const existingEntry =
      Number(
        position.entry_price_usd
      );

    if (
      Number.isFinite(existingEntry) &&
      existingEntry > 0
    ) {
      continue;
    }

    const tradeUsd =
      Number(
        position.trade_usd
      );

    const amount =
      Number(
        position.amount
      );

    if (
      !Number.isFinite(tradeUsd) ||
      tradeUsd <= 0 ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      continue;
    }

    const recovered =
      tradeUsd / amount;

    if (
      !Number.isFinite(recovered) ||
      recovered <= 0
    ) {
      continue;
    }

    position.entry_price_usd =
      recovered;

    /*
      Initialize the highest price
      from the recovered entry.
    */
    position.highest_price_usd =
      recovered;

    position.highest_profit_percent =
      0;

    position.trailing_active =
      false;

    changed = true;

    repaired.push({
      mint:
        position.mint,

      symbol:
        position.symbol || null,

      entry_price_usd:
        recovered,

      method:
        "trade_usd divided by stored token amount",

      note:
        "Approximate recovery from stored position data"
    });

    const index =
      positions.findIndex(
        p =>
          p.mint ===
          position.mint
      );

    if (index >= 0) {
      positions[index] =
        position;
    }
  }

  if (changed) {
    await env.BOT_KV.put(
      POSITION_KEY,
      JSON.stringify(
        positions
      )
    );
  }

  return {
    repaired
  };
}


async function repairPositions(env) {
  try {
    validateEnv(env);

    const repair =
      await repairMissingEntryPrices(
        env
      );

    const positions =
      await getPositions(env);

    return {
      ok: true,

      bot:
        BOT_NAME,

      live_trading:
        LIVE_TRADING,

      trades_executed:
        0,

      sells_executed:
        0,

      repaired_count:
        repair.repaired.length,

      repaired:
        repair.repaired,

      positions,

      message:
        "Repair completed. This route never buys or sells."
    };

  } catch (error) {
    return {
      ok: false,

      bot:
        BOT_NAME,

      error:
        String(
          error?.message ||
          error
        )
    };
  }
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
        action: "TEST_SELL",

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
        position.symbol || null,

      reason,

      signature:
        execution.signature || null
    };

  } catch (error) {
    return {
      action: "ERROR",

      token:
        position?.mint || null,

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
          accept:
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
      solBalance * solPrice;

    const maxTradeUsd =
      walletValueUsd >=
      BALANCE_THRESHOLD_USD
        ? LARGE_TRADE_CAP_USD
        : SMALL_TRADE_CAP_USD;

    const positions =
      await getPositions(env);

    const cooldown =
      await getCooldown(env);

    const trendingBackoff =
      await getTrendingBackoff(env);

    const cachedCandidates =
      await getTrendingCache(env);

    return {
      ok: true,

      bot:
        BOT_NAME,

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

      trailing_activation_percent:
        TRAILING_ACTIVATION * 100,

      trailing_distance_percent:
        TRAILING_DISTANCE * 100,

      stop_loss_percent:
        STOP_LOSS * 100,

      cooldown_active:
        cooldown.active,

      trending_backoff_active:
        trendingBackoff.active,

      trending_backoff_seconds:
        trendingBackoff.seconds_remaining,

      cached_candidates:
        cachedCandidates.slice(
          0,
          MAX_CANDIDATES
        ),

      positions,

      message:
        "TEST NEVER BUYS OR SELLS and does not request Jupiter trending data"
    };

  } catch (error) {
    return {
      ok: false,

      bot:
        BOT_NAME,

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
      solBalance * solPrice;

    const maxTradeUsd =
      walletValueUsd >=
      BALANCE_THRESHOLD_USD
        ? LARGE_TRADE_CAP_USD
        : SMALL_TRADE_CAP_USD;

    const positions =
      await getPositions(env);

    const cooldown =
      await getCooldown(env);

    const trendingBackoff =
      await getTrendingBackoff(env);

    return {
      ok: true,

      bot:
        BOT_NAME,

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

      trailing_activation_percent:
        TRAILING_ACTIVATION * 100,

      trailing_distance_percent:
        TRAILING_DISTANCE * 100,

      stop_loss_percent:
        STOP_LOSS * 100,

      cooldown_active:
        cooldown.active,

      trending_backoff_active:
        trendingBackoff.active,

      trending_backoff_seconds:
        trendingBackoff.seconds_remaining,

      positions
    };

  } catch (error) {
    return {
      ok: false,

      bot:
        BOT_NAME,

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
      [
        WALLET_ADDRESS
      ]
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
    !Number.isInteger(decimals)
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
            jsonrpc:
              "2.0",

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

    return Array.isArray(positions)
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
    positions.push(position);
  }

  await env.BOT_KV.put(
    POSITION_KEY,
    JSON.stringify(positions)
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
        p.mint !==
        mint
    );

  await env.BOT_KV.put(
    POSITION_KEY,
    JSON.stringify(remaining)
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

  if (!Number.isFinite(timestamp)) {
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

  if (signatureCount <= 0) {
    throw new Error(
      "Transaction has no signature slots"
    );
  }

  const signaturesStart =
    offset;

  const messageStart =
    signaturesStart +
    signatureCount *
      64;

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
          name: "Ed25519"
        },
        privateKey,
        message
      )
    );

  if (signature.length !== 64) {
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

async function importPrivateKey(value) {
  let bytes;

  const trimmed =
    String(value).trim();

  if (trimmed.startsWith("[")) {
    let array;

    try {
      array =
        JSON.parse(trimmed);
    } catch {
      throw new Error(
        "WALLET_PRIVATE_KEY JSON is invalid"
      );
    }

    if (!Array.isArray(array)) {
      throw new Error(
        "WALLET_PRIVATE_KEY must be an array"
      );
    }

    bytes =
      new Uint8Array(array);

  } else {
    bytes =
      base58ToBytes(trimmed);
  }

  if (bytes.length === 64) {
    bytes =
      bytes.slice(0, 32);
  }

  if (bytes.length !== 32) {
    throw new Error(
      `WALLET_PRIVATE_KEY must decode to 32 or 64 bytes; got ${bytes.length}`
    );
  }

  const pkcs8Prefix =
    new Uint8Array([
      0x30, 0x2e,
      0x02, 0x01,
      0x00,
      0x30, 0x05,
      0x06, 0x03,
      0x2b, 0x65,
      0x70,
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
      name: "Ed25519"
    },
    false,
    ["sign"]
  );
}


/* =========================================================
   BASE58
========================================================= */

function base58ToBytes(value) {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let num = 0n;

  for (const char of value) {
    const index =
      alphabet.indexOf(char);

    if (index < 0) {
      throw new Error(
        "Invalid base58 private key"
      );
    }

    num =
      num *
      58n +
      BigInt(index);
  }

  const bytes = [];

  while (num > 0n) {
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

function base64ToBytes(base64) {
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


function bytesToBase64(bytes) {
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

  return btoa(binary);
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
      (byte & 0x80) ===
      0
    ) {
      break;
    }

    shift += 7;

    if (shift > 28) {
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
