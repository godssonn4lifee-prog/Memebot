import {
  Connection,
  Keypair,
  VersionedTransaction
} from "@solana/web3.js";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

// Trading settings
const PROFIT_TARGET = 0.05;   // +5%
const STOP_LOSS = -0.02;      // -2%

// Keep this much SOL available for fees.
const MIN_SOL_RESERVE = 0.01;

// Maximum amount used for a single trade.
const MAX_TRADE_USD = 20;

// Set to true only after deployment is working.
const LIVE_TRADING = true;


// ----------------------------------------------------
// MAIN WORKER
// ----------------------------------------------------

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        return json({
          bot: "Memebot",
          status: "online",
          trading: LIVE_TRADING ? "ENABLED" : "DISABLED"
        });
      }

      if (url.pathname === "/status") {
        return await getStatus(env);
      }

      if (url.pathname === "/run") {
        const result = await runBot(env);
        return json(result);
      }

      return new Response("Memebot is running.", {
        status: 200
      });

    } catch (error) {
      return json({
        bot: "Memebot",
        error: error.message || String(error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBot(env).catch(error => {
        console.error("Scheduled bot error:", error);
      })
    );
  }
};


// ----------------------------------------------------
// BOT LOGIC
// ----------------------------------------------------

async function runBot(env) {
  const wallet = getWallet(env);

  const rpcUrl =
    `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;

  const connection = new Connection(rpcUrl);

  const solBalanceLamports =
    await connection.getBalance(wallet.publicKey);

  const solBalance =
    solBalanceLamports / 1_000_000_000;

  const solPrice =
    await getSolPrice(env);

  const usdcBalance =
    await getUsdcBalance(connection, wallet.publicKey);

  const position =
    await loadPosition(env);

  // --------------------------------------------
  // NO POSITION
  // Buy SOL.
  // --------------------------------------------

  if (!position) {

    if (usdcBalance <= 0) {
      return {
        bot: "Memebot",
        trading: LIVE_TRADING ? "ENABLED" : "DISABLED",
        action: "WAITING",
        reason: "No USDC available.",
        sol_balance: solBalance,
        usdc_balance: usdcBalance
      };
    }

    const tradeUsd =
      Math.min(MAX_TRADE_USD, usdcBalance);

    if (tradeUsd <= 0) {
      return {
        bot: "Memebot",
        action: "WAITING",
        reason: "Trade amount is zero."
      };
    }

    const usdcAmount =
      Math.floor(tradeUsd * 1_000_000);

    if (!LIVE_TRADING) {
      return {
        bot: "Memebot",
        trading: "DISABLED",
        action: "BUY_WOULD_EXECUTE",
        amount_usdc: tradeUsd,
        sol_price: solPrice
      };
    }

    const swap =
      await executeSwap(
        env,
        wallet,
        connection,
        USDC_MINT,
        SOL_MINT,
        usdcAmount
      );

    const solReceived =
      Number(swap.outputAmount) / 1_000_000_000;

    const entryPrice =
      tradeUsd / solReceived;

    await savePosition(env, {
      entryPrice,
      solAmount: solReceived,
      investedUsd: tradeUsd,
      openedAt: Date.now()
    });

    return {
      bot: "Memebot",
      trading: "ENABLED",
      action: "BOUGHT_SOL",
      invested_usdc: tradeUsd,
      sol_received: solReceived,
      entry_price: entryPrice,
      signature: swap.signature
    };
  }


  // --------------------------------------------
  // EXISTING POSITION
  // Check profit/loss.
  // --------------------------------------------

  const currentPrice = solPrice;

  const change =
    (currentPrice - position.entryPrice) /
    position.entryPrice;

  const changePercent =
    change * 100;


  // --------------------------------------------
  // TAKE PROFIT
  // --------------------------------------------

  if (change >= PROFIT_TARGET) {

    if (!LIVE_TRADING) {
      return {
        bot: "Memebot",
        trading: "DISABLED",
        action: "SELL_WOULD_EXECUTE",
        reason: "Profit target reached.",
        entry_price: position.entryPrice,
        current_price: currentPrice,
        profit_percent: changePercent
      };
    }

    const result =
      await sellPosition(
        env,
        wallet,
        connection,
        position
      );

    await clearPosition(env);

    return {
      bot: "Memebot",
      trading: "ENABLED",
      action: "SOLD_PROFIT",
      entry_price: position.entryPrice,
      sell_price: currentPrice,
      profit_percent: changePercent,
      signature: result.signature
    };
  }


  // --------------------------------------------
  // STOP LOSS
  // --------------------------------------------

  if (change <= STOP_LOSS) {

    if (!LIVE_TRADING) {
      return {
        bot: "Memebot",
        trading: "DISABLED",
        action: "SELL_WOULD_EXECUTE",
        reason: "Stop loss reached.",
        entry_price: position.entryPrice,
        current_price: currentPrice,
        loss_percent: changePercent
      };
    }

    const result =
      await sellPosition(
        env,
        wallet,
        connection,
        position
      );

    await clearPosition(env);

    return {
      bot: "Memebot",
      trading: "ENABLED",
      action: "SOLD_STOP_LOSS",
      entry_price: position.entryPrice,
      sell_price: currentPrice,
      loss_percent: changePercent,
      signature: result.signature
    };
  }


  // --------------------------------------------
  // HOLD
  // --------------------------------------------

  return {
    bot: "Memebot",
    trading: LIVE_TRADING ? "ENABLED" : "DISABLED",
    action: "HOLDING_SOL",
    entry_price: position.entryPrice,
    current_price: currentPrice,
    change_percent: changePercent,
    target_profit_percent: 5,
    stop_loss_percent: -2
  };
}


// ----------------------------------------------------
// SELL POSITION
// ----------------------------------------------------

async function sellPosition(
  env,
  wallet,
  connection,
  position
) {
  const actualBalance =
    await connection.getBalance(wallet.publicKey);

  const reserveLamports =
    Math.floor(
      MIN_SOL_RESERVE * 1_000_000_000
    );

  const spendableLamports =
    Math.max(
      0,
      actualBalance - reserveLamports
    );

  if (spendableLamports <= 0) {
    throw new Error(
      "Not enough SOL available for the sell transaction while preserving the fee reserve."
    );
  }

  const tokenAccounts =
    await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      {
        mint: SOL_MINT
      }
    );

  let tokenAmount = 0;

  for (const account of tokenAccounts.value) {
    const amount =
      account.account.data.parsed.info.tokenAmount.amount;

    tokenAmount += Number(amount);
  }

  if (tokenAmount <= 0) {
    throw new Error("No wrapped SOL balance available to sell.");
  }

  return await executeSwap(
    env,
    wallet,
    connection,
    SOL_MINT,
    USDC_MINT,
    tokenAmount.toString()
  );
}


// ----------------------------------------------------
// EXECUTE JUPITER SWAP
// ----------------------------------------------------

async function executeSwap(
  env,
  wallet,
  connection,
  inputMint,
  outputMint,
  amount
) {
  const quoteUrl =
    new URL("https://api.jup.ag/swap/v1/quote");

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
    amount.toString()
  );

  quoteUrl.searchParams.set(
    "slippageBps",
    "100"
  );


  const quoteResponse =
    await fetch(
      quoteUrl.toString(),
      {
        headers: {
          "x-api-key": env.JUPITER_API_KEY
        }
      }
    );

  if (!quoteResponse.ok) {
    throw new Error(
      `Jupiter quote failed: ${await quoteResponse.text()}`
    );
  }

  const quote =
    await quoteResponse.json();


  if (!quote.outAmount) {
    throw new Error(
      `Jupiter returned no route: ${JSON.stringify(quote)}`
    );
  }


  const swapResponse =
    await fetch(
      "https://api.jup.ag/swap/v1/swap",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.JUPITER_API_KEY
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toBase58(),
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: "auto"
        })
      }
    );


  if (!swapResponse.ok) {
    throw new Error(
      `Jupiter swap failed: ${await swapResponse.text()}`
    );
  }


  const swap =
    await swapResponse.json();


  if (!swap.swapTransaction) {
    throw new Error(
      `No swap transaction returned: ${JSON.stringify(swap)}`
    );
  }


  const transactionBytes =
    Uint8Array.from(
      atob(swap.swapTransaction),
      character => character.charCodeAt(0)
    );


  const transaction =
    VersionedTransaction.deserialize(
      transactionBytes
    );


  transaction.sign([wallet]);


  const signature =
    await connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        maxRetries: 3
      }
    );


  await connection.confirmTransaction(
    signature,
    "confirmed"
  );


  return {
    signature,
    outputAmount: quote.outAmount
  };
}


// ----------------------------------------------------
// SOL PRICE
// ----------------------------------------------------

async function getSolPrice(env) {
  const quote =
    await getJupiterQuote(
      env,
      SOL_MINT,
      USDC_MINT,
      "1000000000"
    );

  return (
    Number(quote.outAmount) /
    1_000_000
  );
}


// ----------------------------------------------------
// JUPITER QUOTE
// ----------------------------------------------------

async function getJupiterQuote(
  env,
  inputMint,
  outputMint,
  amount
) {
  const url =
    new URL(
      "https://api.jup.ag/swap/v1/quote"
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
    "100"
  );


  const response =
    await fetch(
      url.toString(),
      {
        headers: {
          "x-api-key": env.JUPITER_API_KEY
        }
      }
    );


  if (!response.ok) {
    throw new Error(
      `Jupiter price request failed: ${await response.text()}`
    );
  }


  return await response.json();
}


// ----------------------------------------------------
// USDC BALANCE
// ----------------------------------------------------

async function getUsdcBalance(
  connection,
  publicKey
) {
  const result =
    await connection.getParsedTokenAccountsByOwner(
      publicKey,
      {
        mint: USDC_MINT
      }
    );


  let total = 0;


  for (const account of result.value) {
    const info =
      account.account.data.parsed.info.tokenAmount;

    total += Number(info.uiAmount || 0);
  }


  return total;
}


// ----------------------------------------------------
// WALLET
// ----------------------------------------------------

function getWallet(env) {
  if (!env.WALLET_PRIVATE_KEY) {
    throw new Error(
      "WALLET_PRIVATE_KEY secret is missing."
    );
  }

  const secret =
    decodeSecret(env.WALLET_PRIVATE_KEY);

  return Keypair.fromSecretKey(secret);
}


// ----------------------------------------------------
// PRIVATE KEY DECODER
// Supports:
// - JSON array
// - comma separated numbers
// - base64
// - base58
// ----------------------------------------------------

function decodeSecret(value) {
  const trimmed =
    value.trim();


  // JSON array
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(
      JSON.parse(trimmed)
    );
  }


  // comma separated
  if (trimmed.includes(",")) {
    return Uint8Array.from(
      trimmed
        .split(",")
        .map(Number)
    );
  }


  // Try base64
  try {
    const decoded =
      Uint8Array.from(
        atob(trimmed),
        c => c.charCodeAt(0)
      );

    if (
      decoded.length === 32 ||
      decoded.length === 64
    ) {
      return decoded;
    }
  } catch (_) {
    // Continue to base58.
  }


  // Base58
  return base58Decode(trimmed);
}


// ----------------------------------------------------
// BASE58
// ----------------------------------------------------

function base58Decode(value) {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let bytes = [0];

  for (const char of value) {
    const index =
      alphabet.indexOf(char);

    if (index < 0) {
      throw new Error(
        "Invalid WALLET_PRIVATE_KEY format."
      );
    }

    let carry = index;

    for (
      let i = 0;
      i < bytes.length;
      i++
    ) {
      const number =
        bytes[i] * 58 + carry;

      bytes[i] =
        number & 255;

      carry =
        Math.floor(number / 256);
    }

    while (carry > 0) {
      bytes.push(
        carry & 255
      );

      carry =
        Math.floor(carry / 256);
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


// ----------------------------------------------------
// KV POSITION STORAGE
// ----------------------------------------------------

async function loadPosition(env) {
  if (!env.BOT_KV) {
    throw new Error(
      "BOT_KV binding is missing."
    );
  }

  const data =
    await env.BOT_KV.get(
      "position",
      "json"
    );

  return data || null;
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


// ----------------------------------------------------
// STATUS
// ----------------------------------------------------

async function getStatus(env) {
  const wallet =
    getWallet(env);

  const rpcUrl =
    `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;

  const connection =
    new Connection(rpcUrl);

  const lamports =
    await connection.getBalance(
      wallet.publicKey
    );

  const sol =
    lamports / 1_000_000_000;

  const usdc =
    await getUsdcBalance(
      connection,
      wallet.publicKey
    );

  const position =
    await loadPosition(env);

  return json({
    bot: "Memebot",
    trading: LIVE_TRADING
      ? "ENABLED"
      : "DISABLED",
    wallet: wallet.publicKey.toBase58(),
    sol_balance: sol,
    usdc_balance: usdc,
    position: position
  });
}


// ----------------------------------------------------
// JSON RESPONSE
// ----------------------------------------------------

function json(data, status = 200) {
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
