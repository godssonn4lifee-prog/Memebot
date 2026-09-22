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
const MAX_ROUND_TRIP_LOSS = 0.015;

const MAX_CANDIDATES = 12;

const SWAP_API =
  "https://api.jup.ag/swap/v2";

const TOKEN_API =
  "https://api.jup.ag/tokens/v2";

const PRICE_API =
  "https://api.jup.ag/price/v3";


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
        error
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
   MAIN BOT
   ========================================================= */

async function runBot(env) {

  validateSecrets(env);

  const wallet =
    getWallet(env);

  const connection =
    getConnection(env);

  const position =
    await loadPosition(env);

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


  if (position) {

    return await managePosition(
      env,
      wallet,
      connection,
      position,
      solBalance,
      usdcBalance
    );
  }


  return await findAndBuy(
    env,
    wallet,
    connection,
    solBalance,
    usdcBalance
  );
}


/* =========================================================
   FIND AND BUY
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


  const solPrice =
    await getUsdPrice(
      env,
      SOL_MINT
    );


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


  const candidate =
    await selectCandidate(
      env,
      tradeLamports,
      solPrice
    );


  if (!candidate) {

    return {
      bot: "Memebot",
      trading: "ENABLED",
      action: "WAITING",
      reason:
        "No trending token passed the liquidity, risk, route, and round-trip checks.",
      sol_balance:
        solBalance,
      sol_price:
        solPrice
    };
  }


  if (!LIVE_TRADING) {

    return {
      bot: "Memebot",
      trading: "DISABLED",
      action:
        "BUY_WOULD_EXECUTE",
      token:
        candidate.symbol,
      mint:
        candidate.mint,
      trade_sol:
        tradeLamports /
        1_000_000_000,
      score:
        candidate.score
    };
  }


  console.log(
    "BUYING:",
    candidate.symbol,
    candidate.mint
  );


  const buy =
    await executeOrder(
      env,
      wallet,
      SOL_MINT,
      candidate.mint,
      tradeLamports.toString()
    );


  if (
    buy.status !== "Success"
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

      "Trending + liquidity + momentum + executable round-trip check"
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
      candidate.score,

    round_trip_estimate_percent:
      candidate.roundTripPercent
  };
}


/* =========================================================
   MANAGE EXISTING TOKEN
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

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action:
        "HOLDING_TOKEN",

      token:
        position.tokenSymbol,

      reason:
        "Could not obtain a current token-to-SOL quote.",

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
        "Invalid position or sell quote."
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

  if (!LIVE_TRADING) {

    return {

      bot: "Memebot",

      trading: "DISABLED",

      action:
        "SELL_WOULD_EXECUTE",

      token:
        position.tokenSymbol,

      reason,

      change_percent:
        changePercent
    };
  }


  console.log(
    "SELLING:",
    position.tokenSymbol
  );


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
    await getTrendingTokens(
      env
    );


  if (
    tokens.length === 0
  ) {
    return null;
  }


  const unique =
    new Map();


  for (
    const token of tokens
  ) {

    const mint =
      token?.id ||
      token?.mint ||
      token?.address;


    if (
      !mint ||
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


  const priceMap =
    await getPrices(
      env,
      list.map(
        x => x.mint
      )
    );


  const candidates = [];


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


    if (
      token?.audit?.isSus === true
    ) {
      continue;
    }


    let buyQuote;


    try {

      buyQuote =
        await getOrder(

          env,

          SOL_MINT,

          token.mint,

          tradeLamports.toString()
        );

    } catch (_) {

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


    const tokenUnits =
      tokenOut /
      Math.pow(
        10,
        decimals
      );


    if (
      !Number.isFinite(
        tokenUnits
      ) ||
      tokenUnits <= 0
    ) {
      continue;
    }


    const inputUsd =
      (
        tradeLamports /
        1_000_000_000
      ) *
      solPrice;


    const outputMarketUsd =
      tokenUnits *
      usdPrice;


    const estimatedBuyImpact =
      inputUsd > 0

        ? (
            (
              inputUsd -
              outputMarketUsd
            ) /
            inputUsd
          ) * 100

        : 999;


    if (
      estimatedBuyImpact >
      1.5
    ) {
      continue;
    }


    /*
     * Round-trip check:
     *
     * SOL -> token -> SOL
     *
     * before we actually buy.
     */

    let sellQuote;


    try {

      sellQuote =
        await getOrder(

          env,

          token.mint,

          SOL_MINT,

          buyQuote.outAmount
        );

    } catch (_) {

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


    if (
      roundTripPercent <
      -(
        MAX_ROUND_TRIP_LOSS *
        100
      )
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
      0.25

      +

      Math.max(
        roundTripPercent,
        -5
      ) *
      2;


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

      score,

      roundTripPercent,

      buyQuote
    });
  }


  candidates.sort(
    (a, b) =>
      b.score -
      a.score
  );


  return (
    candidates[0] ||
    null
  );
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

    try {

      const response =
        await fetch(

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


    } catch (error) {

      console.log(
        "Token list error:",
        error?.message ||
        String(error)
      );
    }
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
      await fetch(

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
      of Object.entries(
        items
      )
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
      "Jupiter returned an invalid USD price."
    );
  }


  return usdPrice;
}


/* =========================================================
   JUPITER ORDER / QUOTE
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


  /*
   * No taker = quote only.
   *
   * This lets the bot inspect
   * the route before buying.
   */

  const response =
    await fetch(
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
   EXECUTE LIVE JUPITER ORDER
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
    await fetch(
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
      `Jupiter order failed: ${orderText}`
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
    await fetch(

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
   USDC BALANCE
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

function getWallet(env) {

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
   HELIUS CONNECTION
   ========================================================= */

function getConnection(env) {

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
   KV POSITION STORAGE
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
      position
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
   JSON
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
