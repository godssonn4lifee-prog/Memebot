const BOT_NAME = "memebott";

/*
  ============================================================
  MEMEBOTT — PAPER TRADING VERSION
  ============================================================

  IMPORTANT:
  - PAPER TRADING ONLY
  - NO PRIVATE KEY
  - NO WALLET SIGNING
  - NO TRANSACTION EXECUTION
  - NO REAL MONEY
  - NO REAL BUY/SELL ORDERS

  The bot scans Solana tokens, creates simulated positions,
  tracks their prices, and simulates exits.

  Default paper portfolio:
    $100 starting cash
    $2 trades below $20 portfolio value
    $5 trades at/above $20
    maximum 10 positions

  EXIT LOGIC:
    Hard stop: -1%
    Trailing activates after +1% profit
    Trailing distance: 3%
    Two consecutive qualifying declines confirm an exit

  ============================================================
*/


/* ============================================================
   BASIC SETTINGS
   ============================================================ */

const BOT_NAME = "memebott";

const PAPER_MODE = true;

// Starting simulated portfolio.
const PAPER_STARTING_CASH_USD = 100;

// Never use the user's real wallet balance for paper trading.
const PAPER_MIN_CASH_RESERVE_USD = 10;

// Position sizing.
const SMALL_TRADE_CAP_USD = 2;
const LARGE_TRADE_CAP_USD = 5;
const BALANCE_THRESHOLD_USD = 20;

// Maximum simultaneous simulated positions.
const MAX_POSITIONS = 10;

// Hard stop.
const STOP_LOSS = -0.01;

// Trailing stop distance from highest price.
const TRAILING_STOP = 0.03;

// Trailing stop does not activate until this profit.
const TRAILING_ACTIVATION = 0.01;

// Require two consecutive qualifying observations
// before selling on a trailing decline.
const REVERSAL_CONFIRMATIONS_REQUIRED = 2;

// Do not repeatedly buy/sell the same token immediately.
const COOLDOWN_SECONDS = 30;


/* ============================================================
   SCANNING SETTINGS
   ============================================================ */

// We scan more candidates than the old version.
const MAX_CANDIDATES = 20;

// Maximum number of new paper positions opened in one run.
const MAX_NEW_BUYS_PER_RUN = 1;

// Minimum usable price.
const MIN_TOKEN_PRICE_USD = 0.00000001;


/* ============================================================
   STORAGE KEYS
   ============================================================ */

const PORTFOLIO_KEY = "PAPER_PORTFOLIO";
const HISTORY_KEY = "PAPER_TRADE_HISTORY";
const COOLDOWN_KEY = "PAPER_TRADE_COOLDOWN";


/* ============================================================
   JUPITER
   ============================================================ */

const JUPITER_API = "https://api.jup.ag";

const PRICE_API =
  `${JUPITER_API}/price/v3`;

const TOKENS_API =
  `${JUPITER_API}/tokens/v2`;


/* ============================================================
   WELL-KNOWN SOLANA TOKENS
   ============================================================ */

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const USDT_MINT =
  "Es9vMFrzaCERmJfrF4H2FYD4WkYx8YhY6W3xG8sY5H";


/* ============================================================
   HTTP HELPERS
   ============================================================ */

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}


function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}


/* ============================================================
   MAIN WORKER
   ============================================================ */

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/") {
        return await handleHome(env);
      }

      if (path === "/status") {
        return await handleStatus(env);
      }

      if (path === "/test") {
        return await handleTest(env);
      }

      if (path === "/run") {
        const result = await runBot(env, "manual");

        return jsonResponse({
          ok: true,
          bot: BOT_NAME,
          mode: "PAPER",
          result
        });
      }

      if (path === "/trades") {
        return await handleTrades(env);
      }

      if (path === "/reset-paper") {
        return await handleResetPaper(env, url);
      }

      return jsonResponse(
        {
          ok: false,
          error: "Route not found",
          available_routes: [
            "/",
            "/status",
            "/test",
            "/run",
            "/trades",
            "/reset-paper?confirm=RESET"
          ]
        },
        404
      );

    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          bot: BOT_NAME,
          mode: "PAPER",
          error: error instanceof Error
            ? error.message
            : String(error)
        },
        500
      );
    }
  },


  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBot(env, "cron")
        .catch(error => {
          console.error(
            "Scheduled bot error:",
            error instanceof Error
              ? error.message
              : String(error)
          );
        })
    );
  }
};


/* ============================================================
   HOME
   ============================================================ */

async function handleHome(env) {
  const portfolio = await getPortfolio(env);

  return jsonResponse({
    bot: BOT_NAME,
    status: "ONLINE",
    mode: "PAPER TRADING",
    real_money: false,
    live_execution: false,
    wallet_signing: false,

    paper_cash_usd:
      round(portfolio.cash_usd, 2),

    open_positions:
      portfolio.positions.length,

    realized_pnl_usd:
      round(portfolio.realized_pnl_usd, 2),

    message:
      "Paper trading is active. No real trades are being executed."
  });
}


/* ============================================================
   STATUS
   ============================================================ */

async function handleStatus(env) {
  const portfolio = await getPortfolio(env);

  const valuation =
    await calculatePortfolioValue(portfolio);

  return jsonResponse({
    ok: true,

    bot: BOT_NAME,

    mode: {
      type: "PAPER",
      real_money: false,
      live_trading: false,
      transaction_execution: false,
      private_key_required: false
    },

    portfolio: {
      starting_cash_usd:
        round(portfolio.starting_cash_usd, 2),

      cash_usd:
        round(portfolio.cash_usd, 2),

      positions:
        portfolio.positions.length,

      position_limit:
        MAX_POSITIONS,

      market_value_usd:
        round(valuation.market_value_usd, 2),

      total_value_usd:
        round(valuation.total_value_usd, 2),

      realized_pnl_usd:
        round(portfolio.realized_pnl_usd, 2),

      unrealized_pnl_usd:
        round(valuation.unrealized_pnl_usd, 2),

      total_pnl_usd:
        round(
          valuation.total_value_usd -
          portfolio.starting_cash_usd,
          2
        ),

      return_percent:
        round(
          (
            (
              valuation.total_value_usd /
              portfolio.starting_cash_usd
            ) - 1
          ) * 100,
          2
        )
    },

    settings: {
      small_trade_cap_usd: SMALL_TRADE_CAP_USD,
      large_trade_cap_usd: LARGE_TRADE_CAP_USD,
      balance_threshold_usd: BALANCE_THRESHOLD_USD,
      minimum_cash_reserve_usd: PAPER_MIN_CASH_RESERVE_USD,

      hard_stop_percent:
        STOP_LOSS * 100,

      trailing_activation_percent:
        TRAILING_ACTIVATION * 100,

      trailing_stop_percent:
        TRAILING_STOP * 100,

      reversal_confirmations:
        REVERSAL_CONFIRMATIONS_REQUIRED,

      maximum_positions:
        MAX_POSITIONS
    },

    positions:
      await buildPositionStatus(portfolio)
  });
}


/* ============================================================
   TEST SCANNER
   ============================================================ */

async function handleTest(env) {
  const candidates =
    await getTrendingTokens(env);

  const results = [];

  for (const token of candidates) {
    try {
      const price =
        await getTokenPrice(env, token.mint);

      results.push({
        symbol: token.symbol,
        name: token.name,
        mint: token.mint,

        price_usd:
          price === null
            ? "UNAVAILABLE"
            : round(price, 10),

        eligible:
          price !== null &&
          price >= MIN_TOKEN_PRICE_USD,

        status:
          price === null
            ? "NO_PRICE"
            : "READY_FOR_PAPER_SCAN"
      });

    } catch (error) {
      results.push({
        symbol: token.symbol,
        name: token.name,
        mint: token.mint,
        price_usd: "UNAVAILABLE",
        eligible: false,
        status: "ERROR",
        error: error instanceof Error
          ? error.message
          : String(error)
      });
    }
  }

  return jsonResponse({
    ok: true,

    bot: BOT_NAME,

    mode: "PAPER",

    real_trade_execution: false,

    candidates_scanned:
      results.length,

    candidates: results
  });
}


/* ============================================================
   TRADE HISTORY
   ============================================================ */

async function handleTrades(env) {
  const history =
    await getTradeHistory(env);

  return jsonResponse({
    ok: true,
    mode: "PAPER",
    trades: history
  });
}


/* ============================================================
   RESET PAPER ACCOUNT
   ============================================================ */

async function handleResetPaper(env, url) {
  const confirmation =
    url.searchParams.get("confirm");

  if (confirmation !== "RESET") {
    return jsonResponse(
      {
        ok: false,
        message:
          "Paper account was NOT reset.",
        instruction:
          "Use /reset-paper?confirm=RESET if you really want to reset the simulated portfolio."
      },
      400
    );
  }

  const portfolio =
    createFreshPortfolio();

  await savePortfolio(
    env,
    portfolio
  );

  await saveTradeHistory(
    env,
    []
  );

  await env.BOT_KV.delete(
    COOLDOWN_KEY
  );

  return jsonResponse({
    ok: true,
    mode: "PAPER",
    message:
      "Paper portfolio reset.",
    starting_cash_usd:
      PAPER_STARTING_CASH_USD
  });
}


/* ============================================================
   MAIN BOT LOOP
   ============================================================ */

async function runBot(env, source) {
  if (!env.BOT_KV) {
    throw new Error(
      "BOT_KV binding is missing."
    );
  }

  const portfolio =
    await getPortfolio(env);

  const before =
    await calculatePortfolioValue(
      portfolio
    );

  /*
    ------------------------------------------------------------
    STEP 1
    Manage positions that already exist.
    ------------------------------------------------------------
  */

  const positionResults =
    await managePositions(
      env,
      portfolio
    );

  /*
    Reload after possible simulated sells.
  */

  const updatedPortfolio =
    await getPortfolio(env);

  /*
    ------------------------------------------------------------
    STEP 2
    Check cooldown.
    ------------------------------------------------------------
  */

  if (await isOnCooldown(env)) {
    const afterCooldown =
      await calculatePortfolioValue(
        updatedPortfolio
      );

    return {
      source,

      action: "HOLD",

      reason:
        "Cooldown active.",

      mode: "PAPER",

      portfolio:
        summarizePortfolio(
          afterCooldown,
          updatedPortfolio
        ),

      position_actions:
        positionResults
    };
  }


  /*
    ------------------------------------------------------------
    STEP 3
    Don't exceed position limit.
    ------------------------------------------------------------
  */

  if (
    updatedPortfolio.positions.length >=
    MAX_POSITIONS
  ) {
    const fullPortfolio =
      await calculatePortfolioValue(
        updatedPortfolio
      );

    return {
      source,

      action: "HOLD",

      reason:
        "Maximum paper positions reached.",

      mode: "PAPER",

      portfolio:
        summarizePortfolio(
          fullPortfolio,
          updatedPortfolio
        ),

      position_actions:
        positionResults
    };
  }


  /*
    ------------------------------------------------------------
    STEP 4
    Look for a new paper trade.
    ------------------------------------------------------------
  */

  const buyResult =
    await findPaperBuy(
      env,
      updatedPortfolio
    );


  /*
    ------------------------------------------------------------
    STEP 5
    Save cooldown if a simulated buy happened.
    ------------------------------------------------------------
  */

  if (
    buyResult &&
    buyResult.action === "PAPER_BUY"
  ) {
    await setCooldown(
      env
    );
  }


  const finalPortfolio =
    await getPortfolio(env);

  const after =
    await calculatePortfolioValue(
      finalPortfolio
    );


  return {
    source,

    mode: "PAPER",

    action:
      buyResult?.action ||
      "HOLD",

    reason:
      buyResult?.reason ||
      "No new paper trade.",

    paper_trade:
      buyResult || null,

    position_actions:
      positionResults,

    portfolio:
      summarizePortfolio(
        after,
        finalPortfolio
      ),

    run_change_usd:
      round(
        after.total_value_usd -
        before.total_value_usd,
        4
      )
  };
}


/* ============================================================
   FIND PAPER BUY
   ============================================================ */

async function findPaperBuy(
  env,
  portfolio
) {
  const availableCash =
    portfolio.cash_usd -
    PAPER_MIN_CASH_RESERVE_USD;

  if (availableCash <= 0) {
    return {
      action: "HOLD",
      reason:
        "Paper cash reserve reached."
    };
  }


  /*
    Determine position size from paper
    portfolio value, NOT the real wallet.
  */

  const valuation =
    await calculatePortfolioValue(
      portfolio
    );

  const tradeCap =
    valuation.total_value_usd <
    BALANCE_THRESHOLD_USD
      ? SMALL_TRADE_CAP_USD
      : LARGE_TRADE_CAP_USD;


  if (availableCash < tradeCap) {
    return {
      action: "HOLD",
      reason:
        "Not enough paper cash for the configured trade size."
    };
  }


  /*
    Get a broad candidate list.
  */

  const candidates =
    await getTrendingTokens(env);


  if (!candidates.length) {
    return {
      action: "HOLD",
      reason:
        "No candidates returned by the scanner."
    };
  }


  /*
    Filter tokens.
  */

  const heldMints =
    new Set(
      portfolio.positions.map(
        position => position.mint
      )
    );


  const eligible = [];

  for (
    const token of candidates
  ) {
    if (!token.mint) {
      continue;
    }

    if (
      token.mint === SOL_MINT ||
      token.mint === USDC_MINT ||
      token.mint === USDT_MINT
    ) {
      continue;
    }

    if (
      heldMints.has(token.mint)
    ) {
      continue;
    }

    const price =
      await getTokenPrice(
        env,
        token.mint
      );

    if (
      price === null ||
      !Number.isFinite(price) ||
      price < MIN_TOKEN_PRICE_USD
    ) {
      continue;
    }

    eligible.push({
      ...token,
      price
    });

    /*
      Avoid hammering the API unnecessarily.
    */

    if (
      eligible.length >= MAX_CANDIDATES
    ) {
      break;
    }
  }


  if (!eligible.length) {
    return {
      action: "HOLD",
      reason:
        "No eligible token with a usable price was found."
    };
  }


  /*
    ----------------------------------------------------------
    SIMPLE PAPER SCORING
    ----------------------------------------------------------

    This is deliberately transparent.

    We are NOT pretending this is an AI model.

    Candidate ranking currently uses:
      - scanner order
      - valid price
      - not already held
      - not a stablecoin
      - usable market data

    AI/social/security scoring can be added later
    as separate modules without putting real money at risk.
    ----------------------------------------------------------
  */

  const scored =
    eligible.map(
      (token, index) => ({
        ...token,

        score:
          100 - index
      })
    );


  scored.sort(
    (a, b) =>
      b.score -
      a.score
  );


  const selected =
    scored[0];


  /*
    ----------------------------------------------------------
    SIMULATED BUY
    ----------------------------------------------------------
  */

  const quantity =
    tradeCap /
    selected.price;


  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return {
      action: "HOLD",
      reason:
        "Could not calculate simulated quantity."
    };
  }


  const now =
    new Date().toISOString();


  const position = {
    id:
      createId(),

    mint:
      selected.mint,

    symbol:
      selected.symbol ||
      "UNKNOWN",

    name:
      selected.name ||
      "Unknown Token",

    entry_price_usd:
      selected.price,

    current_price_usd:
      selected.price,

    highest_price_usd:
      selected.price,

    quantity,

    cost_usd:
      tradeCap,

    current_value_usd:
      tradeCap,

    unrealized_pnl_usd:
      0,

    profit_percent:
      0,

    highest_profit_percent:
      0,

    trailing_active:
      false,

    reversal_confirmations:
      0,

    opened_at:
      now,

    last_checked_at:
      now,

    execution:
      "PAPER",

    transaction:
      "NONE — simulated trade",

    entry_reason:
      "Scanner candidate"
  };


  portfolio.cash_usd =
    round(
      portfolio.cash_usd -
      tradeCap,
      10
    );


  portfolio.positions.push(
    position
  );


  await savePortfolio(
    env,
    portfolio
  );


  /*
    Record simulated trade.
  */

  await appendTradeHistory(
    env,
    {
      id:
        createId(),

      time:
        now,

      action:
        "BUY",

      execution:
        "PAPER",

      symbol:
        position.symbol,

      mint:
        position.mint,

      price_usd:
        selected.price,

      quantity,

      amount_usd:
        tradeCap,

      pnl_usd:
        0,

      reason:
        position.entry_reason,

      transaction:
        "NONE — simulated trade"
    }
  );


  return {
    action:
      "PAPER_BUY",

    symbol:
      position.symbol,

    mint:
      position.mint,

    price_usd:
      round(
        selected.price,
        10
      ),

    quantity:
      round(
        quantity,
        10
      ),

    amount_usd:
      tradeCap,

    execution:
      "PAPER",

    transaction:
      "NONE — simulated trade",

    message:
      "Simulated position opened. No real money was used."
  };
}


/* ============================================================
   MANAGE OPEN POSITIONS
   ============================================================ */

async function managePositions(
  env,
  portfolio
) {
  const actions = [];

  /*
    Copy the array because positions may
    be removed while we process them.
  */

  const positions =
    [...portfolio.positions];


  for (
    const position of positions
  ) {
    try {
      const currentPrice =
        await getTokenPrice(
          env,
          position.mint
        );


      if (
        currentPrice === null ||
        !Number.isFinite(currentPrice)
      ) {
        actions.push({
          action:
            "HOLD",

          symbol:
            position.symbol,

          reason:
            "Current price unavailable."
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
        Update highest price.
      */

      if (
        currentPrice >
        position.highest_price_usd
      ) {
        position.highest_price_usd =
          currentPrice;
      }


      /*
        Current profit relative to entry.
      */

      position.current_price_usd =
        currentPrice;

      position.current_value_usd =
        position.quantity *
        currentPrice;

      position.unrealized_pnl_usd =
        position.current_value_usd -
        position.cost_usd;

      position.profit_percent =
        change;


      /*
        Highest profit since entry.
      */

      const highestProfit =
        (
          position.highest_price_usd -
          position.entry_price_usd
        ) /
        position.entry_price_usd;


      if (
        highestProfit >
        position.highest_profit_percent
      ) {
        position.highest_profit_percent =
          highestProfit;
      }


      /*
        ------------------------------------------------------
        HARD STOP
        ------------------------------------------------------
      */

      if (
        change <= STOP_LOSS
      ) {
        const result =
          await sellPaperPosition(
            env,
            portfolio,
            position,
            currentPrice,
            "HARD_STOP"
          );

        actions.push(result);

        continue;
      }


      /*
        ------------------------------------------------------
        TRAILING STOP
        ------------------------------------------------------
      */

      if (
        highestProfit >=
        TRAILING_ACTIVATION
      ) {
        position.trailing_active =
          true;

        const trailingFloor =
          position.highest_price_usd *
          (
            1 -
            TRAILING_STOP
          );


        if (
          currentPrice <=
          trailingFloor
        ) {
          position.reversal_confirmations =
            (
              position.reversal_confirmations ||
              0
            ) + 1;


          if (
            position.reversal_confirmations >=
            REVERSAL_CONFIRMATIONS_REQUIRED
          ) {
            const result =
              await sellPaperPosition(
                env,
                portfolio,
                position,
                currentPrice,
                "TRAILING_REVERSAL"
              );

            actions.push(result);

            continue;
          }


          actions.push({
            action:
              "WATCH",

            symbol:
              position.symbol,

            price_usd:
              round(
                currentPrice,
                10
              ),

            profit_percent:
              round(
                change * 100,
                2
              ),

            reason:
              "Trailing threshold crossed; waiting for confirmation.",

            confirmation:
              `${position.reversal_confirmations}/${REVERSAL_CONFIRMATIONS_REQUIRED}`
          });

        } else {
          /*
            Price recovered above trailing floor.
          */

          position.reversal_confirmations =
            0;

          actions.push({
            action:
              "HOLD",

            symbol:
              position.symbol,

            price_usd:
              round(
                currentPrice,
                10
              ),

            profit_percent:
              round(
                change * 100,
                2
              ),

            highest_profit_percent:
              round(
                highestProfit * 100,
                2
              ),

            reason:
              "Position remains above trailing floor."
          });
        }

      } else {
        /*
          Not profitable enough to activate
          the trailing exit yet.
        */

        position.reversal_confirmations =
          0;

        actions.push({
          action:
            "HOLD",

          symbol:
            position.symbol,

          price_usd:
            round(
              currentPrice,
              10
            ),

          profit_percent:
            round(
              change * 100,
              2
            ),

          reason:
            "Trailing stop not activated yet."
        });
      }


      position.last_checked_at =
        new Date().toISOString();

    } catch (error) {
      actions.push({
        action:
          "ERROR",

        symbol:
          position.symbol,

        reason:
          error instanceof Error
            ? error.message
            : String(error)
      });
    }
  }


  await savePortfolio(
    env,
    portfolio
  );


  return actions;
}


/* ============================================================
   PAPER SELL
   ============================================================ */

async function sellPaperPosition(
  env,
  portfolio,
  position,
  currentPrice,
  reason
) {
  const proceeds =
    position.quantity *
    currentPrice;


  const pnl =
    proceeds -
    position.cost_usd;


  const pnlPercent =
    position.cost_usd > 0
      ? pnl /
        position.cost_usd
      : 0;


  /*
    Return simulated proceeds to paper cash.
  */

  portfolio.cash_usd =
    round(
      portfolio.cash_usd +
      proceeds,
      10
    );


  /*
    Remove position.
  */

  portfolio.positions =
    portfolio.positions.filter(
      item =>
        item.id !== position.id
    );


  portfolio.realized_pnl_usd =
    round(
      portfolio.realized_pnl_usd +
      pnl,
      10
    );


  const now =
    new Date().toISOString();


  await appendTradeHistory(
    env,
    {
      id:
        createId(),

      time:
        now,

      action:
        "SELL",

      execution:
        "PAPER",

      symbol:
        position.symbol,

      mint:
        position.mint,

      entry_price_usd:
        position.entry_price_usd,

      exit_price_usd:
        currentPrice,

      quantity:
        position.quantity,

      amount_usd:
        proceeds,

      pnl_usd:
        pnl,

      pnl_percent:
        pnlPercent * 100,

      reason,

      transaction:
        "NONE — simulated trade"
    }
  );


  await savePortfolio(
    env,
    portfolio
  );


  return {
    action:
      "PAPER_SELL",

    symbol:
      position.symbol,

    mint:
      position.mint,

    entry_price_usd:
      round(
        position.entry_price_usd,
        10
      ),

    exit_price_usd:
      round(
        currentPrice,
        10
      ),

    amount_usd:
      round(
        proceeds,
        4
      ),

    pnl_usd:
      round(
        pnl,
        4
      ),

    pnl_percent:
      round(
        pnlPercent * 100,
        2
      ),

    reason,

    execution:
      "PAPER",

    transaction:
      "NONE — simulated trade",

    message:
      "Simulated position closed. No real transaction occurred."
  };
}


/* ============================================================
   TOKEN SCANNER
   ============================================================ */

async function getTrendingTokens(env) {
  const url =
    `${TOKENS_API}/toptrending/24h`;


  const headers = {
    "accept":
      "application/json"
  };


  /*
    If a Jupiter API key exists, use it.
    If it doesn't, the request is still attempted.
  */

  if (env.JUPITER_API_KEY) {
    headers["x-api-key"] =
      env.JUPITER_API_KEY;
  }


  const response =
    await fetch(
      url,
      {
        method: "GET",
        headers
      }
    );


  if (!response.ok) {
    throw new Error(
      `Jupiter token scanner returned HTTP ${response.status}.`
    );
  }


  const data =
    await response.json();


  const raw =
    Array.isArray(data)
      ? data
      : (
        data.tokens ||
        data.data ||
        data.results ||
        []
      );


  const output = [];
  const seen = new Set();


  for (
    const item of raw
  ) {
    const mint =
      item.address ||
      item.mint ||
      item.id;


    if (!mint) {
      continue;
    }


    if (
      seen.has(mint)
    ) {
      continue;
    }


    seen.add(mint);


    output.push({
      mint,

      symbol:
        item.symbol ||
        item.tokenSymbol ||
        "UNKNOWN",

      name:
        item.name ||
        item.tokenName ||
        "Unknown Token",

      rank:
        output.length + 1
    });


    if (
      output.length >=
      MAX_CANDIDATES
    ) {
      break;
    }
  }


  return output;
}


/* ============================================================
   TOKEN PRICE
   ============================================================ */

async function getTokenPrice(
  env,
  mint
) {
  const url =
    `${PRICE_API}?ids=${encodeURIComponent(mint)}`;


  const headers = {
    "accept":
      "application/json"
  };


  if (env.JUPITER_API_KEY) {
    headers["x-api-key"] =
      env.JUPITER_API_KEY;
  }


  const response =
    await fetch(
      url,
      {
        method: "GET",
        headers
      }
    );


  if (!response.ok) {
    return null;
  }


  const data =
    await response.json();


  const item =
    data?.data?.[mint] ||
    data?.[mint];


  if (!item) {
    return null;
  }


  const rawPrice =
    item.usdPrice ??
    item.price;


  const price =
    Number(rawPrice);


  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return null;
  }


  return price;
}


/* ============================================================
   PORTFOLIO
   ============================================================ */

function createFreshPortfolio() {
  return {
    version: 1,

    mode:
      "PAPER",

    starting_cash_usd:
      PAPER_STARTING_CASH_USD,

    cash_usd:
      PAPER_STARTING_CASH_USD,

    positions: [],

    realized_pnl_usd:
      0,

    created_at:
      new Date().toISOString(),

    updated_at:
      new Date().toISOString()
  };
}


async function getPortfolio(env) {
  const raw =
    await env.BOT_KV.get(
      PORTFOLIO_KEY
    );


  if (!raw) {
    const portfolio =
      createFreshPortfolio();

    await savePortfolio(
      env,
      portfolio
    );

    return portfolio;
  }


  try {
    const portfolio =
      JSON.parse(raw);


    /*
      Safety normalization.
    */

    portfolio.cash_usd =
      Number(
        portfolio.cash_usd ??
        PAPER_STARTING_CASH_USD
      );


    portfolio.starting_cash_usd =
      Number(
        portfolio.starting_cash_usd ??
        PAPER_STARTING_CASH_USD
      );


    portfolio.realized_pnl_usd =
      Number(
        portfolio.realized_pnl_usd ??
        0
      );


    if (
      !Array.isArray(
        portfolio.positions
      )
    ) {
      portfolio.positions = [];
    }


    portfolio.mode =
      "PAPER";


    return portfolio;

  } catch {
    /*
      If stored state is corrupted,
      start a clean paper portfolio.
    */

    const portfolio =
      createFreshPortfolio();

    await savePortfolio(
      env,
      portfolio
    );

    return portfolio;
  }
}


async function savePortfolio(
  env,
  portfolio
) {
  portfolio.updated_at =
    new Date().toISOString();


  await env.BOT_KV.put(
    PORTFOLIO_KEY,
    JSON.stringify(
      portfolio
    )
  );
}


/* ============================================================
   PORTFOLIO VALUE
   ============================================================ */

async function calculatePortfolioValue(
  portfolio
) {
  let marketValue = 0;
  let unrealizedPnl = 0;


  for (
    const position of
    portfolio.positions
  ) {
    /*
      Use the last known current price
      as the fallback for status calculations.

      The position manager refreshes prices
      during normal bot runs.
    */

    const current =
      Number(
        position.current_price_usd ??
        position.entry_price_usd
      );


    const value =
      position.quantity *
      current;


    marketValue +=
      value;


    unrealizedPnl +=
      value -
      position.cost_usd;
  }


  return {
    cash_usd:
      portfolio.cash_usd,

    market_value_usd:
      marketValue,

    total_value_usd:
      portfolio.cash_usd +
      marketValue,

    unrealized_pnl_usd:
      unrealizedPnl
  };
}


/* ============================================================
   POSITION STATUS
   ============================================================ */

async function buildPositionStatus(
  portfolio
) {
  return portfolio.positions.map(
    position => ({
      id:
        position.id,

      symbol:
        position.symbol,

      name:
        position.name,

      mint:
        position.mint,

      entry_price_usd:
        round(
          position.entry_price_usd,
          10
        ),

      current_price_usd:
        round(
          position.current_price_usd,
          10
        ),

      highest_price_usd:
        round(
          position.highest_price_usd,
          10
        ),

      quantity:
        round(
          position.quantity,
          10
        ),

      cost_usd:
        round(
          position.cost_usd,
          4
        ),

      current_value_usd:
        round(
          position.current_value_usd,
          4
        ),

      unrealized_pnl_usd:
        round(
          position.unrealized_pnl_usd,
          4
        ),

      profit_percent:
        round(
          position.profit_percent * 100,
          2
        ),

      highest_profit_percent:
        round(
          position.highest_profit_percent * 100,
          2
        ),

      trailing_active:
        position.trailing_active,

      reversal_confirmations:
        position.reversal_confirmations,

      execution:
        "PAPER",

      transaction:
        "NONE — simulated trade",

      opened_at:
        position.opened_at,

      last_checked_at:
        position.last_checked_at
    })
  );
}


/* ============================================================
   HISTORY
   ============================================================ */

async function getTradeHistory(env) {
  const raw =
    await env.BOT_KV.get(
      HISTORY_KEY
    );


  if (!raw) {
    return [];
  }


  try {
    const history =
      JSON.parse(raw);

    return Array.isArray(history)
      ? history
      : [];

  } catch {
    return [];
  }
}


async function saveTradeHistory(
  env,
  history
) {
  /*
    Keep the most recent 100 trades.
  */

  const trimmed =
    history.slice(-100);


  await env.BOT_KV.put(
    HISTORY_KEY,
    JSON.stringify(
      trimmed
    )
  );
}


async function appendTradeHistory(
  env,
  trade
) {
  const history =
    await getTradeHistory(env);


  history.push(
    trade
  );


  await saveTradeHistory(
    env,
    history
  );
}


/* ============================================================
   COOLDOWN
   ============================================================ */

async function isOnCooldown(env) {
  const raw =
    await env.BOT_KV.get(
      COOLDOWN_KEY
    );


  if (!raw) {
    return false;
  }


  const timestamp =
    Number(raw);


  if (
    !Number.isFinite(timestamp)
  ) {
    return false;
  }


  const ageSeconds =
    (
      Date.now() -
      timestamp
    ) / 1000;


  if (
    ageSeconds >=
    COOLDOWN_SECONDS
  ) {
    await env.BOT_KV.delete(
      COOLDOWN_KEY
    );

    return false;
  }


  return true;
}


async function setCooldown(env) {
  await env.BOT_KV.put(
    COOLDOWN_KEY,
    String(Date.now())
  );
}


/* ============================================================
   SUMMARY
   ============================================================ */

function summarizePortfolio(
  valuation,
  portfolio
) {
  return {
    cash_usd:
      round(
        valuation.cash_usd,
        2
      ),

    market_value_usd:
      round(
        valuation.market_value_usd,
        2
      ),

    total_value_usd:
      round(
        valuation.total_value_usd,
        2
      ),

    realized_pnl_usd:
      round(
        portfolio.realized_pnl_usd,
        2
      ),

    unrealized_pnl_usd:
      round(
        valuation.unrealized_pnl_usd,
        2
      ),

    open_positions:
      portfolio.positions.length
  };
}


/* ============================================================
   UTILITIES
   ============================================================ */

function round(
  value,
  decimals = 4
) {
  const number =
    Number(value);


  if (
    !Number.isFinite(number)
  ) {
    return 0;
  }


  const factor =
    10 ** decimals;


  return (
    Math.round(
      number * factor
    ) / factor
  );
}


function createId() {
  return (
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`
  );
    }
