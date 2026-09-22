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

const TOKEN_PROGRAM =
  new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  );

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

      const url =
        new URL(request.url);

      if (url.pathname === "/") {

        return json({
          bot: "Memebot",
          status: "online",
          trading:
            LIVE_TRADING
              ? "ENABLED"
              : "DISABLED"
        });

      }

      if (url.pathname === "/status") {
        return await getStatus(env);
      }

      if (url.pathname === "/run") {
        return json(
          await runBot(env)
        );
      }

      return json({
        bot: "Memebot",
        status: "online"
      });

    } catch (error) {

      console.error(error);

      return json({
        bot: "Memebot",
        error:
          error.message ||
          String(error)
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

        trading: "ENABLED",

        action: "WAITING",

        reason:
          "USDC balance is too low.",

        sol_balance:
          solBalance,

        usdc_balance:
          usdcBalance,

        sol_price:
          solPrice

      };

    }


    const tradeUsd =
      Math.min(
        MAX_TRADE_USD,
        usdcBalance
      );


    const usdcAmount =
      Math.floor(
        tradeUsd * 1_000_000
      );


    const result =
      await executeSwap(
        env,
        wallet,
        connection,
        USDC_MINT,
        SOL_MINT,
        usdcAmount.toString()
      );


    const solReceived =
      Number(
        result.outputAmount
      ) / 1_000_000_000;


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

      action:
        "BOUGHT_SOL",

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
  // EXISTING POSITION
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
  // PROFIT
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

    action:
      "HOLDING_SOL",

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
// SELL THEN BUY AGAIN
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


  // SELL SOL -> USDC

  const sellResult =
    await executeSwap(
      env,
      wallet,
      connection,
      SOL_MINT,
      USDC_MINT,
      sellAmount.toString()
    );


  await clearPosition(env);


  // Get resulting USDC

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


  // BUY SOL AGAIN

  const tradeUsd =
    Math.min(
      MAX_TRADE_USD,
      usdcBalance
    );


  const buyAmount =
    Math.floor(
      tradeUsd * 1_000_000
    );


  const buyResult =
    await executeSwap(
      env,
      wallet,
      connection,
      USDC_MINT,
      SOL_MINT,
      buyAmount.toString()
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

async function executeSwap(
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
      `No valid Jupiter route: ${JSON.stringify(quote)}`
    );

  }


  const priceImpact =
    Number(
      quote.priceImpactPct || 0
    ) * 100;


  if (
    priceImpact >
    MAX_PRICE_IMPACT_PERCENT
  ) {

    throw new Error(
      `Trade rejected because price impact is ${priceImpact.toFixed(4)}%.`
    );

  }


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


  const swapData =
    JSON.parse(swapText);


  if (
    swapData.error ||
    !swapData.swapTransaction
  ) {

    throw new Error(
      `No swap transaction returned: ${JSON.stringify(swapData)}`
    );

  }


  const transactionBytes =
    base64ToBytes(
      swapData.swapTransaction
    );


  const transaction =
    VersionedTransaction.deserialize(
      transactionBytes
    );


  transaction.sign([
    wallet
  ]);


  const signature =
    await connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        maxRetries: 3
      }
    );


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
      "1000000000"
    );


  return (
    Number(
      quote.outAmount
    ) / 1_000_000
  );

}


// ============================================================
// QUOTE
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
      `Jupiter price request failed: ${text}`
    );

  }


  const data =
    JSON.parse(text);


  if (
    data.error ||
    !data.outAmount
  ) {

    throw new Error(
      `Invalid Jupiter price response: ${JSON.stringify(data)}`
    );

  }


  return data;

}


// ============================================================
// SOL BALANCE
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


// ============================================================
// USDC BALANCE
//
// IMPORTANT:
// We DO NOT ask the RPC node to filter by mint.
// We retrieve the wallet's token accounts using the
// Token Program, then inspect the mint ourselves.
// This avoids the "could not find mint" error.
// ============================================================

async function getUsdcBalance(
  connection,
  publicKey
) {

  const result =
    await connection.getParsedTokenAccountsByOwner(
      publicKey,
      {
        programId:
          TOKEN_PROGRAM
      },
      "confirmed"
    );


  let total = 0;


  for (
    const account of result.value
  ) {

    try {

      const info =
        account.account.data.parsed.info;


      const mint =
        info.mint;


      if (
        mint !== USDC_MINT
      ) {
        continue;
      }


      const amount =
        info.tokenAmount
          .uiAmountString;


      total +=
        Number(amount || 0);

    } catch (_) {

      continue;

    }

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


  return Math.max(
    0,
    sellable
  );

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
// PRIVATE KEY DECODER
// ============================================================

function decodePrivateKey(value) {

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
          x => Number(x.trim())
        )
    );

  }


  try {

    const bytes =
      base64ToBytes(text);


    if (
      bytes.length === 32 ||
      bytes.length === 64
    ) {

      return bytes;

    }

  } catch (_) {}


  return base58Decode(text);

}


// ============================================================
// BASE64
// ============================================================

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


// ============================================================
// BASE58
// ============================================================

function base58Decode(value) {

  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";


  let bytes = [0];


  for (
    const character of value
  ) {

    const index =
      alphabet.indexOf(
        character
      );


    if (
      index < 0
    ) {

      throw new Error(
        "Invalid WALLET_PRIVATE_KEY format."
      );

    }


    let carry =
      index;


    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {

      const number =
        bytes[i] * 58 +
        carry;


      bytes[i] =
        number & 255;


      carry =
        Math.floor(
          number / 256
        );

    }


    while (
      carry > 0
    ) {

      bytes.push(
        carry & 255
      );


      carry =
        Math.floor(
          carry / 256
        );

    }

  }


  for (
    let i = 0;
    i < value.length &&
    value[i] === "1";
    i++
  ) {

    bytes.push(0);

  }


  return Uint8Array.from(
    bytes.reverse()
  );

}


// ============================================================
// POSITION STORAGE
// ============================================================

async function loadPosition(env) {

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


async function clearPosition(env) {

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

async function getStatus(env) {

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
// JSON
// ============================================================

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
