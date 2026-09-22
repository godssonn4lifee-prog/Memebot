import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction
} from "@solana/web3.js";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const LIVE_TRADING = true;

const PROFIT_TARGET = 0.05;
const STOP_LOSS = -0.02;

const MIN_SOL_RESERVE = 0.01;
const MAX_TRADE_USD = 20;

const MIN_LIQUIDITY_USD = 25000;

const SWAP_API =
  "https://api.jup.ag/swap/v2";

const TOKEN_API =
  "https://api.jup.ag/tokens/v2";

const PRICE_API =
  "https://api.jup.ag/price/v3";

/*
 * IMPORTANT:
 * Keep this fairly low because the bot runs every minute.
 */
const MAX_CANDIDATES = 5;

/*
 * If Jupiter returns 429, don't keep hammering it.
 */
const RATE_LIMIT_COOLDOWN_MS = 120000;

/*
 * Minimum time between full scans.
 */
const SCAN_COOLDOWN_MS = 60000;


/* =========================================================
   WORKER
   ========================================================= */

export default {

  async fetch(request, env) {

    try {

      const url =
        new URL(request.url);

      if (url.pathname === "/") {

        return json({
          bot: "Memebot",
          status: "online",
          trading:
            LIVE_TRADING
              ? "ENABLED"
              : "DISABLED",
          strategy:
            "SOL -> trending token -> SOL"
        });
      }


      if (url.pathname === "/status") {

        return json(
          await getStatus(env)
        );
      }


      if (url.pathname === "/run") {

        return json(
          await runBot(env)
        );
      }


      return json({

        bot: "Memebot",

        status: "online",

        endpoints: [
          "/",
          "/status",
          "/run"
        ]

      });

    } catch (error) {

      console.error(
        "FETCH ERROR:",
        error?.message ||
        String(error)
      );

      return json({

        bot: "Memebot",

        status: "error",

        error:
          error?.message ||
          String(error)

      }, 500);
    }
  },


  async scheduled(event, env) {

    try {

      console.log(
        "Memebot cron started:",
        event.cron
      );

      const result =
        await runBot(env);

      console.log(
        "Memebot cron result:",
        JSON.stringify(result)
      );

    } catch (error) {

      console.error(
        "MEMEBOT CRON ERROR:",
        error?.message ||
        String(error)
      );
    }
  }

};


/* =========================================================
   MAIN
   ========================================================= */

async function runBot(env) {

  validateSecrets(env);

  const wallet =
    getWallet(env);

  const connection =
    getConnection(env);

  const position =
    await loadPosition(env);


  /*
   * If already holding a token,
   * manage that position first.
   *
   * This avoids unnecessary scanning.
   */
  if (position) {

    const solBalance =
      await getSolBalance(
        connection,
        wallet.publicKey
      );

    const usdcBalance =
      await getUsdcBalance(
        connection,
        wallet.publicKey
      );

    return await managePosition(
      env,
      wallet,
      connection,
      position,
      solBalance,
      usdcBalance
    );
  }


  /*
   * Check Jupiter cooldown.
   */
  const cooldown =
    await getCooldown(env);

  if (
    cooldown >
    Date.now()
  ) {

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action: "WAITING",

      reason:
        "Jupiter API cooldown is active after rate limiting.",

      retry_after_seconds:
        Math.ceil(
          (
            cooldown -
            Date.now()
          ) / 1000
        )

    };
  }


  /*
   * Prevent duplicate scans within
   * the same minute.
   */
  const lastRun =
    await getLastRun(env);

  if (
    lastRun &&
    Date.now() -
    lastRun <
    SCAN_COOLDOWN_MS
  ) {

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action: "WAITING",

      reason:
        "Recent scan already completed.",

      seconds_since_last_scan:
        Math.floor(
          (
            Date.now() -
            lastRun
          ) / 1000
        )

    };
  }


  await saveLastRun(
    env,
    Date.now()
  );


  const solBalance =
    await getSolBalance(
      connection,
      wallet.publicKey
    );

  const usdcBalance =
    await getUsdcBalance(
      connection,
      wallet.publicKey
    );


  return await findAndBuy(
    env,
    wallet,
    connection,
    solBalance,
    usdcBalance
  );
}


/* =========================================================
   FIND TOKEN AND BUY
   ========================================================= */

async function findAndBuy(
  env,
  wallet,
  connection,
  solBalance,
  usdcBalance
) {

  const spendableLamports =
    getSpendableLamports(
      solBalance
    );


  if (
    spendableLamports <= 0
  ) {

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action: "WAITING",

      reason:
        "SOL balance is too low after the network reserve.",

      sol_balance:
        solBalance,

      usdc_balance:
        usdcBalance

    };
  }


  let solPrice;

  try {

    solPrice =
      await getUsdPrice(
        env,
        SOL_MINT
      );

  } catch (error) {

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action: "WAITING",

      reason:
        "Could not get current SOL price.",

      error:
        error?.message ||
        String(error)

    };
  }


  const maxTradeLamports =
    Math.floor(
      (
        MAX_TRADE_USD /
        solPrice
      ) *
      1_000_000_000
    );


  const tradeLamports =
    Math.min(
      spendableLamports,
      maxTradeLamports
    );


  if (
    tradeLamports <= 0
  ) {

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action: "WAITING",

      reason:
        "Calculated SOL trade amount is too small.",

      sol_balance:
        solBalance,

      sol_price:
        solPrice

    };
  }


  let candidate;

  try {

    candidate =
      await selectCandidate(
        env,
        tradeLamports,
        solPrice
      );

  } catch (error) {

    if (
      isRateLimitError(error)
    ) {

      await setCooldown(
        env,
        Date.now() +
        RATE_LIMIT_COOLDOWN_MS
      );

      return {

        bot: "Memebot",

        trading: "ENABLED",

        action: "WAITING",

        reason:
          "Jupiter rate-limited the scan. Bot entered cooldown.",

        retry_after_seconds:
          RATE_LIMIT_COOLDOWN_MS /
          1000

      };
    }


    return {

      bot: "Memebot",

      trading: "ENABLED",

      action: "WAITING",

      reason:
        "Token scan failed.",

      error:
        error?.message ||
        String(error)

    };
  }


  if (!candidate) {

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action: "WAITING",

      reason:
        "No trending token passed the safety and route checks.",

      sol_balance:
        solBalance,

      sol_price:
        solPrice

    };
  }


  /*
   * LIVE BUY
   */
  try {

    const buy =
      await executeOrder(

        env,

        wallet,

        SOL_MINT,

        candidate.mint,

        tradeLamports.toString()

      );


    if (
      buy.status !==
      "Success"
    ) {

      throw new Error(
        `Buy failed: ${JSON.stringify(buy)}`
      );
    }


    const tokenAmount =
      String(

        buy.totalOutputAmount ||

        buy.outputAmountResult ||

        candidate.buyQuote.outAmount

      );


    const entrySol =
      Number(

        buy.totalInputAmount ||

        tradeLamports

      ) /
      1_000_000_000;


    const newPosition = {

      tokenMint:
        candidate.mint,

      tokenSymbol:
        candidate.symbol,

      tokenName:
        candidate.name,

      tokenDecimals:
        candidate.decimals,

      tokenAmount:
        tokenAmount,

      entrySol:
        entrySol,

      openedAt:
        Date.now(),

      buySignature:
        buy.signature,

      selectionScore:
        candidate.score,

      selectionReason:
        "Trending token with liquidity, momentum and executable route"

    };


    await savePosition(
      env,
      newPosition
    );


    return {

      bot: "Memebot",

      trading: "ENABLED",

      action:
        "BOUGHT_TOKEN",

      token:
        candidate.symbol,

      token_name:
        candidate.name,

      token_mint:
        candidate.mint,

      spent_sol:
        entrySol,

      token_amount:
        tokenAmount,

      buy_signature:
        buy.signature,

      selection_score:
        candidate.score

    };

  } catch (error) {

    if (
      isRateLimitError(error)
    ) {

      await setCooldown(
        env,
        Date.now() +
        RATE_LIMIT_COOLDOWN_MS
      );
    }


    throw error;
  }
}


/* =========================================================
   MANAGE POSITION
   ========================================================= */

async function managePosition(
  env,
  wallet,
  connection,
  position,
  solBalance,
  usdcBalance
) {

  const tokenBalance =
    await getTokenBalance(

      connection,

      wallet.publicKey,

      position.tokenMint

    );


  if (
    !tokenBalance ||
    tokenBalance.amount === "0"
  ) {

    await clearPosition(env);

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action:
        "POSITION_CLEARED",

      reason:
        "Tracked token balance is zero.",

      token:
        position.tokenSymbol

    };
  }


  let sellQuote;


  try {

    sellQuote =
      await getOrder(

        env,

        position.tokenMint,

        SOL_MINT,

        tokenBalance.amount

      );

  } catch (error) {

    if (
      isRateLimitError(error)
    ) {

      await setCooldown(
        env,
        Date.now() +
        RATE_LIMIT_COOLDOWN_MS
      );
    }


    return {

      bot: "Memebot",

      trading: "ENABLED",

      action:
        "HOLDING_TOKEN",

      token:
        position.tokenSymbol,

      reason:
        "Current token-to-SOL quote unavailable.",

      error:
        error?.message ||
        String(error)

    };
  }


  const expectedSol =
    Number(
      sellQuote.outAmount ||
      0
    ) /
    1_000_000_000;


  const entrySol =
    Number(
      position.entrySol ||
      0
    );


  if (
    expectedSol <= 0 ||
    entrySol <= 0
  ) {

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action:
        "HOLDING_TOKEN",

      token:
        position.tokenSymbol,

      reason:
        "Invalid position or quote."

    };
  }


  const change =
    (
      expectedSol -
      entrySol
    ) /
    entrySol;


  const changePercent =
    change * 100;


  /*
   * PROFIT
   */
  if (
    change >=
    PROFIT_TARGET
  ) {

    return await sellPosition(

      env,

      wallet,

      position,

      tokenBalance.amount,

      "PROFIT_TARGET",

      changePercent

    );
  }


  /*
   * STOP LOSS
   */
  if (
    change <=
    STOP_LOSS
  ) {

    return await sellPosition(

      env,

      wallet,

      position,

      tokenBalance.amount,

      "STOP_LOSS",

      changePercent

    );
  }


  return {

    bot: "Memebot",

    trading: "ENABLED",

    action:
      "HOLDING_TOKEN",

    token:
      position.tokenSymbol,

    token_name:
      position.tokenName,

    token_mint:
      position.tokenMint,

    entry_sol:
      entrySol,

    current_sell_value_sol:
      expectedSol,

    change_percent:
      changePercent,

    profit_target_percent:
      5,

    stop_loss_percent:
      -2,

    buy_signature:
      position.buySignature,

    sol_balance:
      solBalance,

    usdc_balance:
      usdcBalance

  };
}


/* =========================================================
   SELL TOKEN -> SOL
   ========================================================= */

async function sellPosition(
  env,
  wallet,
  position,
  tokenAmount,
  reason,
  changePercent
) {

  try {

    const sell =
      await executeOrder(

        env,

        wallet,

        position.tokenMint,

        SOL_MINT,

        tokenAmount

      );


    if (
      sell.status !==
      "Success"
    ) {

      throw new Error(
        `Sell failed: ${JSON.stringify(sell)}`
      );
    }


    const solReceived =
      Number(

        sell.totalOutputAmount ||

        sell.outputAmountResult ||

        0

      ) /
      1_000_000_000;


    const entrySol =
      Number(
        position.entrySol ||
        0
      );


    const realizedChange =
      entrySol > 0

        ? (

            (
              solReceived -
              entrySol
            ) /
            entrySol

          ) * 100

        : 0;


    await clearPosition(env);


    return {

      bot: "Memebot",

      trading: "ENABLED",

      action:

        reason ===
        "PROFIT_TARGET"

          ? "SOLD_PROFIT"

          : "SOLD_STOP_LOSS",

      token:
        position.tokenSymbol,

      token_mint:
        position.tokenMint,

      reason:

        reason,

      entry_sol:
        entrySol,

      sol_received:
        solReceived,

      realized_change_percent:
        realizedChange,

      sell_signature:
        sell.signature,

      next_action:
        "WAITING_FOR_NEXT_TRENDING_TOKEN"

    };

  } catch (error) {

    if (
      isRateLimitError(error)
    ) {

      await setCooldown(

        env,

        Date.now() +
        RATE_LIMIT_COOLDOWN_MS

      );
    }


    throw error;
  }
}


/* =========================================================
   TOKEN SELECTION
   ========================================================= */

async function selectCandidate(
  env,
  tradeLamports,
  solPrice
) {

  const tokens =
    await getTrendingTokens(env);


  const unique =
    new Map();


  for (
    const token of tokens
  ) {

    const mint =
      token?.id ||
      token?.mint ||
      token?.address;


    if (!mint) {
      continue;
    }


    if (
      mint === SOL_MINT ||
      mint === USDC_MINT
    ) {
      continue;
    }


    if (
      token?.audit?.isSus === true
    ) {
      continue;
    }


    if (
      !unique.has(mint)
    ) {

      unique.set(

        mint,

        {
          ...token,
          mint
        }

      );
    }
  }


  const list =
    Array.from(
      unique.values()
    ).slice(
      0,
      MAX_CANDIDATES
    );


  if (
    list.length === 0
  ) {

    return null;
  }


  /*
   * ONE price request for the entire batch.
   */
  const priceMap =
    await getPrices(

      env,

      list.map(
        x => x.mint
      )

    );


  const candidates = [];


  /*
   * Only the strongest candidates
   * get Jupiter order requests.
   *
   * This dramatically reduces API usage.
   */
  for (
    const token of list
  ) {

    const price =
      priceMap[
        token.mint
      ];


    if (!price) {
      continue;
    }


    const usdPrice =
      Number(
        price.usdPrice ||
        0
      );


    const liquidity =
      Number(
        price.liquidity ||
        0
      );


    const priceChange24h =
      Number(
        price.priceChange24h ||
        0
      );


    const decimals =
      Number(

        price.decimals ??
        token.decimals ??
        0

      );


    if (
      !Number.isFinite(
        usdPrice
      ) ||
      usdPrice <= 0
    ) {

      continue;
    }


    if (
      !Number.isFinite(
        liquidity
      ) ||
      liquidity <
      MIN_LIQUIDITY_USD
    ) {

      continue;
    }


    const organicScore =
      Number(
        token.organicScore ||
        0
      );


    const score =

      organicScore *

      0.50

      +

      Math.min(
        liquidity /
        1_000_000,
        10
      ) *

      3

      +

      Math.max(
        Math.min(
          priceChange24h,
          50
        ),
        -50
      ) *

      0.25;


    candidates.push({

      mint:
        token.mint,

      symbol:
        token.symbol ||
        "UNKNOWN",

      name:
        token.name ||
        token.symbol ||
        "Unknown Token",

      decimals,

      liquidity,

      priceChange24h,

      score

    });
  }


  /*
   * Sort before asking Jupiter for routes.
   */
  candidates.sort(

    (a, b) =>
      b.score -
      a.score

  );


  /*
   * Only test the best 2 candidates.
   *
   * Each candidate requires a buy quote
   * and a round-trip sell quote.
   */
  const routeCandidates =
    candidates.slice(0, 2);


  for (
    const candidate
    of routeCandidates
  ) {

    let buyQuote;

    try {

      buyQuote =
        await getOrder(

          env,

          SOL_MINT,

          candidate.mint,

          tradeLamports.toString()

        );

    } catch (error) {

      if (
        isRateLimitError(error)
      ) {

        throw error;
      }

      continue;
    }


    const tokenOut =
      Number(
        buyQuote.outAmount ||
        0
      );


    if (
      !Number.isFinite(
        tokenOut
      ) ||
      tokenOut <= 0
    ) {

      continue;
    }


    /*
     * Round-trip test.
     */
    let sellQuote;

    try {

      sellQuote =
        await getOrder(

          env,

          candidate.mint,

          SOL_MINT,

          buyQuote.outAmount

        );

    } catch (error) {

      if (
        isRateLimitError(error)
      ) {

        throw error;
      }

      continue;
    }


    const roundTripSol =
      Number(
        sellQuote.outAmount ||
        0
      ) /
      1_000_000_000;


    const originalSol =
      tradeLamports /
      1_000_000_000;


    const roundTripPercent =
      originalSol > 0

        ? (

            (
              roundTripSol -
              originalSol
            ) /
            originalSol

          ) * 100

        : -100;


    /*
     * Do not buy a token whose immediate
     * round-trip is already worse than 1.5%.
     */
    if (
      roundTripPercent <
      -1.5
    ) {

      continue;
    }


    candidate.buyQuote =
      buyQuote;


    candidate.roundTripPercent =
      roundTripPercent;


    candidate.score +=
      roundTripPercent * 2;


    return candidate;
  }


  return null;
}


/* =========================================================
   TRENDING TOKENS
   ========================================================= */

async function getTrendingTokens(
  env
) {

  const headers = {

    "x-api-key":
      env.JUPITER_API_KEY

  };


  const paths = [

    "/toptrending/5m",

    "/toptrending/1h",

    "/toptraded/1h"

  ];


  const results = [];


  for (
    const path of paths
  ) {

    const response =
      await jupiterFetch(

        `${TOKEN_API}${path}`,

        {
          headers
        }

      );


    if (
      !response.ok
    ) {

      continue;
    }


    const data =
      await response.json();


    const list =

      Array.isArray(data)

        ? data

        : Array.isArray(
            data.data
          )

          ? data.data

          : [];


    results.push(
      ...list
    );
  }


  return results;
}


/* =========================================================
   PRICE API
   ========================================================= */

async function getPrices(
  env,
  mints
) {

  const map = {};


  for (
    let i = 0;
    i < mints.length;
    i += 50
  ) {

    const batch =
      mints.slice(
        i,
        i + 50
      );


    const response =
      await jupiterFetch(

        `${PRICE_API}?ids=${encodeURIComponent(
          batch.join(",")
        )}`,

        {

          headers: {

            "x-api-key":
              env.JUPITER_API_KEY

          }

        }

      );


    if (
      !response.ok
    ) {

      continue;
    }


    const data =
      await response.json();


    const items =
      data?.data ||
      data ||
      {};


    for (
      const [
        mint,
        value
      ]
      of Object.entries(items)
    ) {

      if (value) {

        map[mint] =
          value;

      }
    }
  }


  return map;
}


async function getUsdPrice(
  env,
  mint
) {

  const prices =
    await getPrices(

      env,

      [mint]

    );


  const price =
    prices[mint];


  const usdPrice =
    Number(
      price?.usdPrice ||
      0
    );


  if (
    !Number.isFinite(
      usdPrice
    ) ||
    usdPrice <= 0
  ) {

    throw new Error(
      "Jupiter returned an invalid SOL price."
    );
  }


  return usdPrice;
}


/* =========================================================
   JUPITER ORDER
   ========================================================= */

async function getOrder(
  env,
  inputMint,
  outputMint,
  amount
) {

  const url =
    new URL(
      `${SWAP_API}/order`
    );


  url.searchParams.set(
    "inputMint",
    inputMint
  );


  url.searchParams.set(
    "outputMint",
    outputMint
  );


  url.searchParams.set(
    "amount",
    amount
  );


  const response =
    await jupiterFetch(

      url.toString(),

      {

        headers: {

          "x-api-key":
            env.JUPITER_API_KEY

        }

      }

    );


  const text =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(

      `Jupiter order failed: ${text}`

    );
  }


  const order =
    JSON.parse(text);


  if (
    order.errorCode ||
    order.errorMessage
  ) {

    throw new Error(

      `Jupiter order rejected: ${
        order.errorMessage ||
        JSON.stringify(order)
      }`

    );
  }


  if (
    !order.outAmount
  ) {

    throw new Error(
      "Jupiter returned no output amount."
    );
  }


  return order;
}


/* =========================================================
   LIVE EXECUTION
   ========================================================= */

async function executeOrder(
  env,
  wallet,
  inputMint,
  outputMint,
  amount
) {

  const url =
    new URL(
      `${SWAP_API}/order`
    );


  url.searchParams.set(
    "inputMint",
    inputMint
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
    wallet.publicKey.toBase58()
  );


  const orderResponse =
    await jupiterFetch(

      url.toString(),

      {

        headers: {

          "x-api-key":
            env.JUPITER_API_KEY

        }

      }

    );


  const orderText =
    await orderResponse.text();


  if (
    !orderResponse.ok
  ) {

    throw new Error(

      `Jupiter order failed: ${
        orderText
      }`

    );
  }


  const order =
    JSON.parse(
      orderText
    );


  if (
    order.errorCode ||
    order.errorMessage
  ) {

    throw new Error(

      `Jupiter order rejected: ${
        order.errorMessage ||
        JSON.stringify(order)
      }`

    );
  }


  if (
    !order.transaction
  ) {

    throw new Error(

      `Jupiter returned no executable transaction: ${
        JSON.stringify(order)
      }`

    );
  }


  const transaction =
    VersionedTransaction.deserialize(

      base64ToBytes(
        order.transaction
      )

    );


  transaction.sign([
    wallet
  ]);


  const signedTransaction =
    bytesToBase64(
      transaction.serialize()
    );


  const executeResponse =
    await jupiterFetch(

      `${SWAP_API}/execute`,

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          "x-api-key":
            env.JUPITER_API_KEY

        },

        body:
          JSON.stringify({

            signedTransaction,

            requestId:
              order.requestId

          })

      }

    );


  const executeText =
    await executeResponse.text();


  if (
    !executeResponse.ok
  ) {

    throw new Error(

      `Jupiter execute failed: ${
        executeText
      }`

    );
  }


  const result =
    JSON.parse(
      executeText
    );


  if (
    result.status !==
    "Success"
  ) {

    throw new Error(

      `Jupiter execution failed: ${
        JSON.stringify(result)
      }`

    );
  }


  return result;
}


/* =========================================================
   JUPITER FETCH WITH RATE LIMIT PROTECTION
   ========================================================= */

async function jupiterFetch(
  url,
  options = {}
) {

  let lastError;


  for (
    let attempt = 0;
    attempt < 3;
    attempt++
  ) {

    try {

      const response =
        await fetch(
          url,
          options
        );


      if (
        response.status !==
        429
      ) {

        return response;
      }


      /*
       * Jupiter says slow down.
       */
      const retryAfter =
        response.headers.get(
          "Retry-After"
        );


      let waitMs =
        retryAfter
          ? Number(retryAfter) * 1000
          : 3000 * (
              attempt + 1
            );


      /*
       * Never wait an extreme amount
       * inside one Worker request.
       */
      waitMs =
        Math.min(
          waitMs,
          10000
        );


      console.log(
        "Jupiter 429. Waiting:",
        waitMs,
        "ms"
      );


      await sleep(
        waitMs
      );


      lastError =
        new Error(
          "Jupiter API returned HTTP 429 Too Many Requests."
        );

    } catch (error) {

      lastError =
        error;

      break;
    }
  }


  throw (

    lastError ||

    new Error(
      "Jupiter request failed."
    )

  );
}


function isRateLimitError(
  error
) {

  return String(
    error?.message ||
    error ||
    ""
  ).includes("429");

}


function sleep(
  ms
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


/* =========================================================
   SOL BALANCE
   ========================================================= */

async function getSolBalance(
  connection,
  publicKey
) {

  const lamports =
    await connection.getBalance(

      publicKey,

      "confirmed"

    );


  return (
    lamports /
    1_000_000_000
  );
}


function getSpendableLamports(
  solBalance
) {

  const total =
    Math.floor(

      solBalance *
      1_000_000_000

    );


  const reserve =
    Math.floor(

      MIN_SOL_RESERVE *
      1_000_000_000

    );


  const safetyBuffer =
    5_000_000;


  return Math.max(

    0,

    total -
    reserve -
    safetyBuffer

  );
}


/* =========================================================
   TOKEN BALANCE
   ========================================================= */

async function getTokenBalance(
  connection,
  owner,
  mint
) {

  const result =
    await connection.getParsedTokenAccountsByOwner(

      owner,

      {
        mint:
          new PublicKey(mint)
      },

      "confirmed"

    );


  let amount =
    0n;


  let decimals =
    0;


  for (
    const item
    of result.value
  ) {

    const tokenAmount =
      item.account.data.parsed.info.tokenAmount;


    amount +=
      BigInt(
        tokenAmount.amount
      );


    decimals =
      Number(
        tokenAmount.decimals
      );
  }


  return {

    amount:
      amount.toString(),

    decimals,

    uiAmount:

      decimals > 0

        ? Number(amount) /
          Math.pow(
            10,
            decimals
          )

        : Number(amount)

  };
}


/* =========================================================
   USDC
   ========================================================= */

async function getUsdcBalance(
  connection,
  owner
) {

  try {

    const balance =
      await getTokenBalance(

        connection,

        owner,

        USDC_MINT

      );


    return balance.uiAmount;

  } catch (_) {

    return 0;
  }
}


/* =========================================================
   WALLET
   ========================================================= */

function getWallet(
  env
) {

  if (
    !env.WALLET_PRIVATE_KEY
  ) {

    throw new Error(
      "WALLET_PRIVATE_KEY secret is missing."
    );
  }


  const secret =
    decodePrivateKey(
      env.WALLET_PRIVATE_KEY
    );


  if (
    secret.length !== 32 &&
    secret.length !== 64
  ) {

    throw new Error(

      `WALLET_PRIVATE_KEY decoded to ${
        secret.length
      } bytes. Expected 32 or 64 bytes.`

    );
  }


  return (

    secret.length === 32

      ? Keypair.fromSeed(
          secret
        )

      : Keypair.fromSecretKey(
          secret
        )

  );
}


/* =========================================================
   HELIUS
   ========================================================= */

function getConnection(
  env
) {

  if (
    !env.HELIUS_API_KEY
  ) {

    throw new Error(
      "HELIUS_API_KEY secret is missing."
    );
  }


  return new Connection(

    `https://mainnet.helius-rpc.com/?api-key=${
      env.HELIUS_API_KEY
    }`,

    "confirmed"

  );
}


/* =========================================================
   PRIVATE KEY DECODER
   ========================================================= */

function decodePrivateKey(
  value
) {

  const text =
    value.trim();


  if (
    text.startsWith("[")
  ) {

    return Uint8Array.from(

      JSON.parse(text)

    );
  }


  if (
    text.includes(",")
  ) {

    return Uint8Array.from(

      text
        .split(",")
        .map(
          x =>
            Number(
              x.trim()
            )
        )

    );
  }


  try {

    const bytes =
      base64ToBytes(
        text
      );


    if (
      bytes.length === 32 ||
      bytes.length === 64
    ) {

      return bytes;
    }

  } catch (_) {}


  return base58Decode(
    text
  );
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

  let binary =
    "";


  const chunk =
    0x8000;


  for (
    let i = 0;
    i < bytes.length;
    i += chunk
  ) {

    binary +=
      String.fromCharCode(

        ...bytes.subarray(

          i,

          Math.min(
            i + chunk,
            bytes.length
          )

        )

      );
  }


  return btoa(
    binary
  );
}


/* =========================================================
   BASE58
   ========================================================= */

function base58Decode(
  value
) {

  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";


  let digits =
    [0];


  for (
    const character
    of value
  ) {

    const index =
      alphabet.indexOf(
        character
      );


    if (
      index < 0
    ) {

      throw new Error(
        "Invalid WALLET_PRIVATE_KEY."
      );
    }


    let carry =
      index;


    for (
      let j = 0;
      j < digits.length;
      j++
    ) {

      const number =
        digits[j] *
        58 +
        carry;


      digits[j] =
        number &
        255;


      carry =
        Math.floor(
          number /
          256
        );
    }


    while (
      carry > 0
    ) {

      digits.push(
        carry &
        255
      );


      carry =
        Math.floor(
          carry /
          256
        );
    }
  }


  for (
    let i = 0;

    i < value.length &&
    value[i] === "1";

    i++
  ) {

    digits.push(0);
  }


  return Uint8Array.from(
    digits.reverse()
  );
}


/* =========================================================
   KV POSITION
   ========================================================= */

async function loadPosition(
  env
) {

  if (
    !env.BOT_KV
  ) {

    throw new Error(
      "BOT_KV binding is missing."
    );
  }


  return await env.BOT_KV.get(

    "position",

    "json"

  );
}


async function savePosition(
  env,
  position
) {

  if (
    !env.BOT_KV
  ) {

    throw new Error(
      "BOT_KV binding is missing."
    );
  }


  await env.BOT_KV.put(

    "position",

    JSON.stringify(
      position
    )

  );
}


async function clearPosition(
  env
) {

  if (
    !env.BOT_KV
  ) {

    throw new Error(
      "BOT_KV binding is missing."
    );
  }


  await env.BOT_KV.delete(
    "position"
  );
}


/* =========================================================
   RATE-LIMIT COOLDOWN
   ========================================================= */

async function getCooldown(
  env
) {

  const value =
    await env.BOT_KV.get(
      "jupiter_cooldown"
    );


  return Number(
    value || 0
  );
}


async function setCooldown(
  env,
  timestamp
) {

  await env.BOT_KV.put(

    "jupiter_cooldown",

    String(timestamp),

    {
      expirationTtl:
        Math.ceil(
          RATE_LIMIT_COOLDOWN_MS /
          1000
        ) + 30
    }

  );
}


/* =========================================================
   LAST SCAN
   ========================================================= */

async function getLastRun(
  env
) {

  const value =
    await env.BOT_KV.get(
      "last_scan"
    );


  return Number(
    value || 0
  );
}


async function saveLastRun(
  env,
  timestamp
) {

  await env.BOT_KV.put(

    "last_scan",

    String(timestamp),

    {
      expirationTtl:
        300
    }

  );
}


/* =========================================================
   STATUS
   ========================================================= */

async function getStatus(
  env
) {

  validateSecrets(env);


  const wallet =
    getWallet(env);


  const connection =
    getConnection(env);


  const solBalance =
    await getSolBalance(

      connection,

      wallet.publicKey

    );


  const usdcBalance =
    await getUsdcBalance(

      connection,

      wallet.publicKey

    );


  const position =
    await loadPosition(env);


  const cooldown =
    await getCooldown(env);


  return {

    bot:
      "Memebot",

    status:
      "online",

    trading:

      LIVE_TRADING
        ? "ENABLED"
        : "DISABLED",

    strategy:
      "SOL -> trending token -> SOL",

    wallet:
      wallet.publicKey.toBase58(),

    sol_balance:
      solBalance,

    usdc_balance:
      usdcBalance,

    position:
      position,

    jupiter_cooldown:

      cooldown > Date.now(),

    cooldown_seconds:

      cooldown > Date.now()

        ? Math.ceil(
            (
              cooldown -
              Date.now()
            ) / 1000
          )

        : 0

  };
}


/* =========================================================
   VALIDATION
   ========================================================= */

function validateSecrets(
  env
) {

  if (
    !env.HELIUS_API_KEY
  ) {

    throw new Error(
      "HELIUS_API_KEY secret is missing."
    );
  }


  if (
    !env.JUPITER_API_KEY
  ) {

    throw new Error(
      "JUPITER_API_KEY secret is missing."
    );
  }


  if (
    !env.WALLET_PRIVATE_KEY
  ) {

    throw new Error(
      "WALLET_PRIVATE_KEY secret is missing."
    );
  }


  if (
    !env.BOT_KV
  ) {

    throw new Error(
      "BOT_KV binding is missing."
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

        "Content-Type":
          "application/json"

      }

    }

  );
    }
