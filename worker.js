import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction
} from "@solana/web3.js";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGkGZwyTDt1v";

const SOL_PUBLIC_KEY = new PublicKey(SOL_MINT);
const USDC_PUBLIC_KEY = new PublicKey(USDC_MINT);

const PROFIT_TARGET = 0.05;
const STOP_LOSS = -0.02;

const MIN_SOL_RESERVE = 0.01;
const MAX_TRADE_USD = 20;

const SLIPPAGE_BPS = 100;
const MAX_PRICE_IMPACT_PERCENT = 1;

const LIVE_TRADING = true;

const API_BASE =
  "https://api.jup.ag/swap/v1";


// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(request, env) {

    try {

      const url = new URL(request.url);

      if (url.pathname === "/") {

        return json({
          bot: "Memebot",
          status: "online",
          trading: LIVE_TRADING
            ? "ENABLED"
            : "DISABLED"
        });

      }

      if (url.pathname === "/status") {
        return await status(env);
      }

      if (url.pathname === "/run") {
        return await runBot(env);
      }

      return json({
        bot: "Memebot",
        status: "online"
      });

    } catch (error) {

      console.error(error);

      return json({
        bot: "Memebot",
        error: error.message || String(error)
      }, 500);

    }

  },


  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      runBot(env).catch(error => {
        console.error(
          "Scheduled bot error:",
          error
        );
      })
    );

  }

};


// ============================================================
// MAIN BOT
// ============================================================

async function runBot(env) {

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

  const solPrice =
    await getSolPrice(env);

  let position =
    await loadPosition(env);


  // ----------------------------------------------------------
  // NO POSITION = BUY SOL
  // ----------------------------------------------------------

  if (!position) {

    if (usdcBalance < 1) {

      return {
        bot: "Memebot",
        trading: LIVE_TRADING
          ? "ENABLED"
          : "DISABLED",
        action: "WAITING",
        reason: "USDC balance is too low.",
        sol_balance: solBalance,
        usdc_balance: usdcBalance
      };

    }


    const tradeUsd =
      Math.min(
        MAX_TRADE_USD,
        usdcBalance
      );


    if (!LIVE_TRADING) {

      return {
        bot: "Memebot",
        trading: "DISABLED",
        action: "BUY_WOULD_EXECUTE",
        amount_usdc: tradeUsd,
        sol_price: solPrice
      };

    }


    const usdcAmount =
      Math.floor(
        tradeUsd * 1_000_000
      );


    const result =
      await swap(
        env,
        wallet,
        connection,
        USDC_MINT,
        SOL_MINT,
        usdcAmount.toString()
      );


    const solReceived =
      Number(result.outputAmount) /
      1_000_000_000;


    if (solReceived <= 0) {

      throw new Error(
        "Buy completed without receiving SOL."
      );

    }


    const entryPrice =
      tradeUsd / solReceived;


    position = {

      entryPrice,

      solAmount:
        solReceived,

      investedUsd:
        tradeUsd,

      openedAt:
        Date.now(),

      buySignature:
        result.signature

    };


    await savePosition(
      env,
      position
    );


    return {

      bot: "Memebot",

      trading: "ENABLED",

      action: "BOUGHT_SOL",

      invested_usdc:
        tradeUsd,

      sol_received:
        solReceived,

      entry_price:
        entryPrice,

      signature:
        result.signature

    };

  }


  // ----------------------------------------------------------
  // POSITION EXISTS
  // ----------------------------------------------------------

  const change =
    (
      solPrice -
      position.entryPrice
    ) /
    position.entryPrice;


  const changePercent =
    change * 100;


  // ----------------------------------------------------------
  // TAKE PROFIT
  // ----------------------------------------------------------

  if (change >= PROFIT_TARGET) {

    return await sellAndRebuy(
      env,
      wallet,
      connection,
      position,
      solPrice,
      "PROFIT_TARGET",
      changePercent
    );

  }


  // ----------------------------------------------------------
  // STOP LOSS
  // ----------------------------------------------------------

  if (change <= STOP_LOSS) {

    return await sellAndRebuy(
      env,
      wallet,
      connection,
      position,
      solPrice,
      "STOP_LOSS",
      changePercent
    );

  }


  // ----------------------------------------------------------
  // HOLD
  // ----------------------------------------------------------

  return {

    bot: "Memebot",

    trading: "ENABLED",

    action: "HOLDING_SOL",

    entry_price:
      position.entryPrice,

    current_price:
      solPrice,

    change_percent:
      changePercent,

    profit_target_percent:
      5,

    stop_loss_percent:
      -2

  };

}


// ============================================================
// SELL THEN IMMEDIATELY BUY AGAIN
// ============================================================

async function sellAndRebuy(
  env,
  wallet,
  connection,
  position,
  currentPrice,
  reason,
  changePercent
) {

  // ----------------------------------------------------------
  // SELL
  // ----------------------------------------------------------

  const sellAmount =
    await getSellableSol(
      connection,
      wallet.publicKey
    );


  if (sellAmount <= 0) {

    throw new Error(
      "No sellable SOL available."
    );

  }


  const sellResult =
    await swap(
      env,
      wallet,
      connection,
      SOL_MINT,
      USDC_MINT,
      sellAmount.toString()
    );


  await clearPosition(env);


  // ----------------------------------------------------------
  // GET NEW USDC BALANCE
  // ----------------------------------------------------------

  const usdcBalance =
    await getUsdcBalance(
      connection,
      wallet.publicKey
    );


  if (usdcBalance < 1) {

    return {

      bot: "Memebot",

      trading: "ENABLED",

      action:
        reason === "PROFIT_TARGET"
          ? "SOLD_PROFIT"
          : "SOLD_STOP_LOSS",

      change_percent:
        changePercent,

      sell_signature:
        sellResult.signature,

      next_action:
        "WAITING_FOR_USDC"

    };

  }


  // ----------------------------------------------------------
  // BUY AGAIN IMMEDIATELY
  // ----------------------------------------------------------

  const tradeUsd =
    Math.min(
      MAX_TRADE_USD,
      usdcBalance
    );


  const usdcAmount =
    Math.floor(
      tradeUsd * 1_000_000
    );


  const buyResult =
    await swap(
      env,
      wallet,
      connection,
      USDC_MINT,
      SOL_MINT,
      usdcAmount.toString()
    );


  const newSol =
    Number(
      buyResult.outputAmount
    ) / 1_000_000_000;


  if (newSol <= 0) {

    throw new Error(
      "Rebuy completed without receiving SOL."
    );

  }


  const newEntryPrice =
    tradeUsd / newSol;


  const newPosition = {

    entryPrice:
      newEntryPrice,

    solAmount:
      newSol,

    investedUsd:
      tradeUsd,

    openedAt:
      Date.now(),

    buySignature:
      buyResult.signature,

    previousSellSignature:
      sellResult.signature

  };


  await savePosition(
    env,
    newPosition
  );


  return {

    bot: "Memebot",

    trading: "ENABLED",

    action:
      reason === "PROFIT_TARGET"
        ? "SOLD_PROFIT_AND_REBUY"
        : "SOLD_STOP_LOSS_AND_REBUY",

    previous_entry_price:
      position.entryPrice,

    sell_price:
      currentPrice,

    change_percent:
      changePercent,

    sell_signature:
      sellResult.signature,

    new_entry_price:
      newEntryPrice,

    new_sol:
      newSol,

    buy_signature:
      buyResult.signature

  };

}


// ============================================================
// JUPITER SWAP
// ============================================================

async function swap(
  env,
  wallet,
  connection,
  inputMint,
  outputMint,
  amount
) {

  const quoteUrl =
    new URL(
      `${API_BASE}/quote`
    );


  quoteUrl.searchParams.set(
    "inputMint",
    inputMint
  );

  quoteUrl.searchParams.set(
    "outputMint",
    outputMint
  );

  quoteUrl.searchParams.set(
    "amount",
    amount
  );

  quoteUrl.searchParams.set(
    "slippageBps",
    SLIPPAGE_BPS.toString()
  );

  quoteUrl.searchParams.set(
    "instructionVersion",
    "V2"
  );


  const quoteResponse =
    await fetch(
      quoteUrl.toString(),
      {
        method: "GET",

        headers: {
          "x-api-key":
            env.JUPITER_API_KEY
        }
      }
    );


  const quoteText =
    await quoteResponse.text();


  if (!quoteResponse.ok) {

    throw new Error(
      `Jupiter quote failed: ${quoteText}`
    );

  }


  const quote =
    JSON.parse(quoteText);


  if (
    quote.error ||
    !quote.outAmount
  ) {

    throw new Error(
      `Jupiter returned no valid route: ${JSON.stringify(quote)}`
    );

  }


  // ----------------------------------------------------------
  // PRICE IMPACT CHECK
  // ----------------------------------------------------------

  const priceImpact =
    Number(
      quote.priceImpactPct || 0
    ) * 100;


  if (
    priceImpact >
    MAX_PRICE_IMPACT_PERCENT
  ) {

    throw new Error(
      `Trade rejected: price impact ${priceImpact.toFixed(4)}% is above ${MAX_PRICE_IMPACT_PERCENT}%.`
    );

  }


  // ----------------------------------------------------------
  // BUILD TRANSACTION
  // ----------------------------------------------------------

  const swapResponse =
    await fetch(
      `${API_BASE}/swap`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-api-key":
            env.JUPITER_API_KEY
        },

        body: JSON.stringify({

          quoteResponse:
            quote,

          userPublicKey:
            wallet.publicKey.toBase58(),

          wrapAndUnwrapSol:
            true,

          dynamicComputeUnitLimit:
            true,

          dynamicSlippage:
            true,

          prioritizationFeeLamports: {

            priorityLevelWithMaxLamports: {

              priorityLevel:
                "veryHigh",

              maxLamports:
                1_000_000

            }

          }

        })

      }
    );


  const swapText =
    await swapResponse.text();


  if (!swapResponse.ok) {

    throw new Error(
      `Jupiter swap build failed: ${swapText}`
    );

  }


  const swapResponseJson =
    JSON.parse(swapText);


  if (
    swapResponseJson.error ||
    !swapResponseJson.swapTransaction
  ) {

    throw new Error(
      `Jupiter did not return a transaction: ${JSON.stringify(swapResponseJson)}`
    );

  }


  // ----------------------------------------------------------
  // DECODE TRANSACTION
  // ----------------------------------------------------------

  const transactionBytes =
    base64ToUint8Array(
      swapResponseJson.swapTransaction
    );


  const transaction =
    VersionedTransaction.deserialize(
      transactionBytes
    );


  transaction.sign([
    wallet
  ]);


  // ----------------------------------------------------------
  // SEND
  // ----------------------------------------------------------

  const signature =
    await connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        maxRetries: 3
      }
    );


  // ----------------------------------------------------------
  // CONFIRM
  // ----------------------------------------------------------

  const latest =
    await connection.getLatestBlockhash(
      "confirmed"
    );


  const confirmation =
    await connection.confirmTransaction(
      {
        signature,

        blockhash:
          latest.blockhash,

        lastValidBlockHeight:
          latest.lastValidBlockHeight

      },

      "confirmed"
    );


  if (
    confirmation.value &&
    confirmation.value.err
  ) {

    throw new Error(
      `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
    );

  }


  return {

    signature,

    outputAmount:
      quote.outAmount

  };

}


// ============================================================
// SOL PRICE
// ============================================================

async function getSolPrice(env) {

  const quote =
    await getQuote(
      env,
      SOL_MINT,
      USDC_MINT,
      "100000000"
    );


  return (
    Number(quote.outAmount) /
    1_000_000
  ) * 10;

}


// ============================================================
// GENERIC QUOTE
// ============================================================

async function getQuote(
  env,
  inputMint,
  outputMint,
  amount
) {

  const url =
    new URL(
      `${API_BASE}/quote`
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
    "slippageBps",
    SLIPPAGE_BPS.toString()
  );

  url.searchParams.set(
    "instructionVersion",
    "V2"
  );


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


  if (!response.ok) {

    throw new Error(
      `Jupiter price quote failed: ${text}`
    );

  }


  const data =
    JSON.parse(text);


  if (
    data.error ||
    !data.outAmount
  ) {

    throw new Error(
      `Invalid Jupiter price quote: ${JSON.stringify(data)}`
    );

  }


  return data;

}


// ============================================================
// BALANCES
// ============================================================

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


async function getUsdcBalance(
  connection,
  publicKey
) {

  const result =
    await connection.getParsedTokenAccountsByOwner(
      publicKey,
      {
        mint:
          USDC_PUBLIC_KEY
      },
      "confirmed"
    );


  let total = 0;


  for (
    const account of result.value
  ) {

    const amount =
      account.account.data.parsed.info
        .tokenAmount.uiAmount;


    total +=
      Number(amount || 0);

  }


  return total;

}


// ============================================================
// SELLABLE NATIVE SOL
// ============================================================

async function getSellableSol(
  connection,
  publicKey
) {

  const lamports =
    await connection.getBalance(
      publicKey,
      "confirmed"
    );


  const reserve =
    Math.floor(
      MIN_SOL_RESERVE *
      1_000_000_000
    );


  const safetyBuffer =
    5_000_000;


  const sellable =
    lamports -
    reserve -
    safetyBuffer;


  if (sellable <= 0) {
    return 0;
  }


  return sellable;

}


// ============================================================
// WALLET
// ============================================================

function getWallet(env) {

  if (
    !env.WALLET_PRIVATE_KEY
  ) {

    throw new Error(
      "WALLET_PRIVATE_KEY secret is missing."
    );

  }


  return Keypair.fromSecretKey(
    decodePrivateKey(
      env.WALLET_PRIVATE_KEY
    )
  );

}


// ============================================================
// PRIVATE KEY DECODER
// ============================================================

function decodePrivateKey(value) {

  const text =
    value.trim();


  // JSON array
  if (
    text.startsWith("[")
  ) {

    const array =
      JSON.parse(text);


    return Uint8Array.from(
      array
    );

  }


  // Comma-separated numbers
  if (
    text.includes(",")
  ) {

    return Uint8Array.from(
      text
        .split(",")
        .map(x =>
          Number(x.trim())
        )
    );

  }


  // Base64
  try {

    const bytes =
      base64ToUint8Array(text);


    if (
      bytes.length === 32 ||
      bytes.length === 64
    ) {

      return bytes;

    }

  } catch (_) {}



  // Base58
  return base58Decode(text);

}


// ============================================================
// BASE64
// ============================================================

function base64ToUint8Array(
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


// ============================================================
// BASE58
// ============================================================

function base58Decode(value) {

  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";


  let digits = [0];


  for (
    const character of value
  ) {

    const carryStart =
      alphabet.indexOf(
        character
      );


    if (
      carryStart < 0
    ) {

      throw new Error(
        "Invalid WALLET_PRIVATE_KEY."
      );

    }


    let carry =
      carryStart;


    for (
      let j = 0;
      j < digits.length;
      j++
    ) {

      const number =
        digits[j] * 58 +
        carry;


      digits[j] =
        number & 255;


      carry =
        number >> 8;

    }


    while (
      carry > 0
    ) {

      digits.push(
        carry & 255
      );


      carry =
        carry >> 8;

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


// ============================================================
// KV POSITION
// ============================================================

async function loadPosition(
  env
) {

  if (!env.BOT_KV) {

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

  if (!env.BOT_KV) {

    throw new Error(
      "BOT_KV binding is missing."
    );

  }


  await env.BOT_KV.put(
    "position",
    JSON.stringify(position)
  );

}


async function clearPosition(
  env
) {

  if (!env.BOT_KV) {

    throw new Error(
      "BOT_KV binding is missing."
    );

  }


  await env.BOT_KV.delete(
    "position"
  );

}


// ============================================================
// STATUS
// ============================================================

async function status(env) {

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


  return json({

    bot: "Memebot",

    status: "online",

    trading:
      LIVE_TRADING
        ? "ENABLED"
        : "DISABLED",

    wallet:
      wallet.publicKey.toBase58(),

    sol_balance:
      solBalance,

    usdc_balance:
      usdcBalance,

    position:
      position

  });

}


// ============================================================
// CONNECTION
// ============================================================

function getConnection(env) {

  if (
    !env.HELIUS_API_KEY
  ) {

    throw new Error(
      "HELIUS_API_KEY secret is missing."
    );

  }


  return new Connection(
    `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
    "confirmed"
  );

}


// ============================================================
// SECRET CHECK
// ============================================================

function validateSecrets(env) {

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


// ============================================================
// JSON RESPONSE
// ============================================================

function json(
  data,
  statusCode = 200
) {

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {

      status:
        statusCode,

      headers: {
        "Content-Type":
          "application/json"
      }

    }
  );

}
