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

// Trading rules
const PROFIT_TARGET = 0.05;       // +5%
const STOP_LOSS = -0.02;          // -2%
const MIN_SOL_RESERVE = 0.01;     // keep SOL for fees
const MAX_TRADE_USD = 20;

// Safety filters for candidate tokens
const MIN_LIQUIDITY_USD = 25000;
const MIN_VOLUME_24H_USD = 10000;
const MAX_PRICE_IMPACT_PERCENT = 1;

// Jupiter API
const JUPITER_BASE =
  "https://api.jup.ag";

const SWAP_BASE =
  `${JUPITER_BASE}/swap/v2`;

const TOKEN_BASE =
  `${JUPITER_BASE}/tokens/v2`;

const PRICE_BASE =
  `${JUPITER_BASE}/price/v3`;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        return json({
          bot: "Memebot",
          status: "online",
          trading: LIVE_TRADING ? "ENABLED" : "DISABLED",
          strategy:
            "SOL -> trending token -> SOL"
        });
      }

      if (url.pathname === "/status") {
        return json(
          await getStatus(env)
        );
      }

      if (url.pathname === "/scan") {
        return json(
          await scanCandidates(env)
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
          "/scan",
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

  async scheduled(event, env, ctx) {
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

  let position =
    await loadPosition(env);

  /*
   * =======================================================
   * NO CURRENT POSITION
   * =======================================================
   */

  if (!position) {
    const availableLamports =
      getSpendableSolLamports(
        solBalance
      );

    if (availableLamports <= 0) {
      return {
        bot: "Memebot",
        trading: "ENABLED",
        action: "WAITING",
        reason:
          "Not enough SOL after reserve.",
        sol_balance:
          solBalance,
        usdc_balance:
          usdcBalance
      };
    }

    const solPrice =
      await getSolUsdPrice(env);

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
        availableLamports,
        maxTradeLamports
      );

    if (tradeLamports <= 0) {
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

    /*
     * Find the strongest currently trending
     * candidate and verify that Jupiter can
     * actually quote the trade.
     */

    const candidate =
      await selectBestCandidate(
        env,
        tradeLamports
      );

    if (!candidate) {
      return {
        bot: "Memebot",
        trading: "ENABLED",
        action: "WAITING",
        reason:
          "No eligible trending token passed the safety filters.",
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
        action: "BUY_WOULD_EXECUTE",
        token:
          candidate.symbol,
        mint:
          candidate.mint,
        trade_sol:
          tradeLamports /
          1_000_000_000,
        estimated_token_amount:
          candidate.quote.outAmount
      };
    }

    console.log(
      "BUYING TOKEN:",
      candidate.symbol,
      candidate.mint
    );

    const buyResult =
      await executeJupiterOrder(
        env,
        wallet,
        SOL_MINT,
        candidate.mint,
        tradeLamports.toString()
      );

    if (
      buyResult.status !==
      "Success"
    ) {
      throw new Error(
        `Buy failed: ${JSON.stringify(buyResult)}`
      );
    }

    const actualTokenAmount =
      buyResult.totalOutputAmount ||
      buyResult.outputAmountResult ||
      candidate.quote.outAmount;

    position = {
      tokenMint:
        candidate.mint,

      tokenSymbol:
        candidate.symbol,

      tokenName:
        candidate.name,

      tokenDecimals:
        candidate.decimals,

      entrySol:
        Number(
          buyResult.totalInputAmount ||
          tradeLamports
        ) /
        1_000_000_000,

      tokenAmount:
        actualTokenAmount,

      openedAt:
        Date.now(),

      buySignature:
        buyResult.signature,

      selectionScore:
        candidate.score,

      selectionReason:
        candidate.reason
    };

    await savePosition(
      env,
      position
    );

    return {
      bot: "Memebot",
      trading: "ENABLED",
      action: "BOUGHT_TOKEN",

      token:
        candidate.symbol,

      token_name:
        candidate.name,

      token_mint:
        candidate.mint,

      spent_sol:
        position.entrySol,

      token_amount:
        actualTokenAmount,

      buy_signature:
        buyResult.signature,

      selection_score:
        candidate.score,

      selection_reason:
        candidate.reason
    };
  }


  /*
   * =======================================================
   * CURRENT POSITION
   * =======================================================
   */

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
      action: "POSITION_CLEARED",
      reason:
        "Tracked token balance is zero."
    };
  }

  /*
   * Get an actual executable sell quote.
   * This is much safer than relying only on
   * a stale displayed token price.
   */

  let sellQuote;

  try {
    sellQuote =
      await getJupiterOrder(
        env,
        position.tokenMint,
        SOL_MINT,
        tokenBalance.amount,
        wallet.publicKey.toBase58()
      );
  } catch (error) {
    return {
      bot: "Memebot",
      trading: "ENABLED",
      action: "HOLDING_TOKEN",
      token:
        position.tokenSymbol,
      reason:
        "Could not obtain current sell quote.",
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
      position.entrySol
    );

  if (
    entrySol <= 0 ||
    expectedSol <= 0
  ) {
    return {
      bot: "Memebot",
      trading: "ENABLED",
      action: "HOLDING_TOKEN",
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


  /*
   * =======================================================
   * PROFIT TARGET
   * =======================================================
   */

  if (
    change >= PROFIT_TARGET
  ) {
    return await sellPosition(
      env,
      wallet,
      connection,
      position,
      tokenBalance.amount,
      sellQuote,
      "PROFIT_TARGET",
      changePercent
    );
  }


  /*
   * =======================================================
   * STOP LOSS
   * =======================================================
   */

  if (
    change <= STOP_LOSS
  ) {
    return await sellPosition(
      env,
      wallet,
      connection,
      position,
      tokenBalance.amount,
      sellQuote,
      "STOP_LOSS",
      changePercent
    );
  }


  /*
   * =======================================================
   * HOLD
   * =======================================================
   */

  return {
    bot: "Memebot",
    trading: "ENABLED",
    action: "HOLDING_TOKEN",

    token:
      position.tokenSymbol,

    token_name:
      position.tokenName,

    token_mint:
      position.tokenMint,

    entry_sol:
      entrySol,

    estimated_sell_sol:
      expectedSol,

    change_percent:
      changePercent,

    profit_target_percent:
      5,

    stop_loss_percent:
      -2,

    buy_signature:
      position.buySignature
  };
}


/* =========================================================
   SELL POSITION
   ========================================================= */

async function sellPosition(
  env,
  wallet,
  connection,
  position,
  tokenAmount,
  sellQuote,
  reason,
  changePercent
) {
  if (!LIVE_TRADING) {
    return {
      bot: "Memebot",
      trading: "DISABLED",
      action: "SELL_WOULD_EXECUTE",
      token:
        position.tokenSymbol,
      reason,
      change_percent:
        changePercent
    };
  }

  console.log(
    "SELLING TOKEN:",
    position.tokenSymbol
  );

  const sellResult =
    await executeJupiterOrder(
      env,
      wallet,
      position.tokenMint,
      SOL_MINT,
      tokenAmount
    );

  if (
    sellResult.status !==
    "Success"
  ) {
    throw new Error(
      `Sell failed: ${JSON.stringify(sellResult)}`
    );
  }

  const solReceived =
    Number(
      sellResult.totalOutputAmount ||
      sellResult.outputAmountResult ||
      sellQuote.outAmount ||
      0
    ) /
    1_000_000_000;

  const entrySol =
    Number(
      position.entrySol
    );

  const realizedChange =
    entrySol > 0
      ? (
          solReceived -
          entrySol
        ) /
        entrySol
      : 0;

  await clearPosition(env);

  return {
    bot: "Memebot",
    trading: "ENABLED",

    action:
      reason === "PROFIT_TARGET"
        ? "SOLD_PROFIT"
        : "SOLD_STOP_LOSS",

    token:
      position.tokenSymbol,

    token_name:
      position.tokenName,

    token_mint:
      position.tokenMint,

    reason,

    entry_sol:
      entrySol,

    sol_received:
      solReceived,

    realized_change_percent:
      realizedChange * 100,

    sell_signature:
      sellResult.signature,

    next_action:
      "WAITING_FOR_NEXT_TRENDING_TOKEN"
  };
}


/* =========================================================
   TOKEN SELECTION
   ========================================================= */

async function selectBestCandidate(
  env,
  tradeLamports
) {
  const candidates =
    await getTrendingTokens(env);

  if (
    candidates.length === 0
  ) {
    return null;
  }

  const ranked =
    candidates
      .map(token => {
        const liquidity =
          toNumber(
            token.liquidity
          );

        const volume24h =
          getVolume24h(token);

        const organicScore =
          toNumber(
            token.organicScore
          );

        const priceChange =
          getPriceChange(token);

        /*
         * Jupiter already ranks toptrending tokens.
         * This additional score rewards liquidity,
         * activity and momentum without blindly
         * buying the biggest percentage gainer.
         */

        const score =
          (
            organicScore * 0.40
          ) +
          (
            Math.min(
              liquidity / 1000000,
              10
            ) * 20
          ) +
          (
            Math.min(
              volume24h / 1000000,
              10
            ) * 15
          ) +
          (
            Math.max(
              Math.min(
                priceChange,
                50
              ),
              -50
            ) * 0.5
          );

        return {
          ...token,
          score
        };
      })
      .filter(token => {
        if (
          !token.mint ||
          token.mint === SOL_MINT ||
          token.mint === USDC_MINT
        ) {
          return false;
        }

        if (
          token.audit &&
          token.audit.isSus === true
        ) {
          return false;
        }

        const liquidity =
          toNumber(
            token.liquidity
          );

        const volume24h =
          getVolume24h(token);

        if (
          liquidity <
          MIN_LIQUIDITY_USD
        ) {
          return false;
        }

        if (
          volume24h <
          MIN_VOLUME_24H_USD
        ) {
          return false;
        }

        return true;
      })
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  /*
   * Test only the strongest candidates.
   * The quote itself is the final execution check.
   */

  const limited =
    ranked.slice(0, 8);

  for (
    const token of limited
  ) {
    try {
      const quote =
        await getJupiterOrder(
          env,
          SOL_MINT,
          token.mint,
          tradeLamports.toString(),
          null
        );

      if (
        !quote.outAmount ||
        Number(quote.outAmount) <= 0
      ) {
        continue;
      }

      const priceImpact =
        getPriceImpactPercent(
          quote
        );

      if (
        priceImpact >
        MAX_PRICE_IMPACT_PERCENT
      ) {
        console.log(
          "Rejected:",
          token.symbol,
          "price impact:",
          priceImpact
        );

        continue;
      }

      return {
        mint:
          token.mint,

        symbol:
          token.symbol ||
          "UNKNOWN",

        name:
          token.name ||
          token.symbol ||
          "Unknown Token",

        decimals:
          Number(
            token.decimals ||
            0
          ),

        score:
          token.score,

        reason:
          "Trending + liquidity + volume + momentum passed screening.",

        quote
      };

    } catch (error) {
      console.log(
        "Candidate rejected:",
        token.symbol ||
        token.mint,
        error?.message ||
        String(error)
      );
    }
  }

  return null;
}


/* =========================================================
   TRENDING TOKEN DATA
   ========================================================= */

async function getTrendingTokens(env) {
  const headers = {
    "x-api-key":
      env.JUPITER_API_KEY
  };

  const urls = [
    `${TOKEN_BASE}/toptrending/1h?limit=20`,
    `${TOKEN_BASE}/toptrending/6h?limit=20`,
    `${TOKEN_BASE}/toptraded/1h?limit=20`
  ];

  const responses =
    await Promise.all(
      urls.map(url =>
        fetch(
          url,
          { headers }
        )
      )
    );

  const all = [];

  for (
    const response of responses
  ) {
    if (!response.ok) {
      console.log(
        "Token API request failed:",
        response.status
      );

      continue;
    }

    const data =
      await response.json();

    const list =
      Array.isArray(data)
        ? data
        : Array.isArray(data.data)
          ? data.data
          : [];

    all.push(
      ...list
    );
  }

  /*
   * Deduplicate by mint.
   */

  const map =
    new Map();

  for (
    const token of all
  ) {
    if (
      token &&
      token.id
    ) {
      token.mint =
        token.id;
    }

    if (
      token &&
      token.address &&
      !token.mint
    ) {
      token.mint =
        token.address;
    }

    if (
      token &&
      token.mint &&
      !map.has(token.mint)
    ) {
      map.set(
        token.mint,
        token
      );
    }
  }

  return Array.from(
    map.values()
  );
}


/* =========================================================
   JUPITER SWAP V2
   ========================================================= */

async function getJupiterOrder(
  env,
  inputMint,
  outputMint,
  amount,
  taker
) {
  const url =
    new URL(
      `${SWAP_BASE}/order`
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
   * A taker causes Jupiter to return
   * the actual transaction to sign.
   *
   * For candidate screening we can omit it.
   */

  if (taker) {
    url.searchParams.set(
      "taker",
      taker
    );
  }

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",
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
      "Jupiter order returned no output amount."
    );
  }

  return order;
}


async function executeJupiterOrder(
  env,
  wallet,
  inputMint,
  outputMint,
  amount
) {
  const order =
    await getJupiterOrder(
      env,
      inputMint,
      outputMint,
      amount,
      wallet.publicKey.toBase58()
    );

  if (
    !order.transaction
  ) {
    throw new Error(
      `Jupiter did not return a transaction: ${JSON.stringify(order)}`
    );
  }

  /*
   * Jupiter V2 returns a versioned transaction.
   */

  const transactionBytes =
    base64ToBytes(
      order.transaction
    );

  const transaction =
    VersionedTransaction.deserialize(
      transactionBytes
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
      `${SWAP_BASE}/execute`,
      {
        method: "POST",

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
      `Jupiter execute failed: ${executeText}`
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
      `Jupiter transaction failed: ${JSON.stringify(result)}`
    );
  }

  return result;
}


/* =========================================================
   PRICE DATA
   ========================================================= */

async function getSolUsdPrice(env) {
  const response =
    await fetch(
      `${PRICE_BASE}?ids=${SOL_MINT}`,
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
      `SOL price request failed: ${text}`
    );
  }

  const data =
    JSON.parse(text);

  const item =
    data?.data?.[SOL_MINT] ||
    data?.[SOL_MINT];

  const price =
    Number(
      item?.usdPrice ||
      item?.price ||
      0
    );

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      "Jupiter returned an invalid SOL price."
    );
  }

  return price;
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


function getSpendableSolLamports(
  solBalance
) {
  const totalLamports =
    Math.floor(
      solBalance *
      1_000_000_000
    );

  const reserve =
    Math.floor(
      MIN_SOL_RESERVE *
      1_000_000_000
    );

  const extraSafety =
    5_000_000;

  return Math.max(
    0,
    totalLamports -
      reserve -
      extraSafety
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
  const mintPublicKey =
    new PublicKey(
      mint
    );

  const result =
    await connection.getParsedTokenAccountsByOwner(
      owner,
      {
        mint:
          mintPublicKey
      },
      "confirmed"
    );

  let rawAmount =
    0n;

  let decimals =
    0;

  for (
    const account of result.value
  ) {
    const info =
      account.account.data.parsed.info;

    const tokenAmount =
      info.tokenAmount;

    decimals =
      Number(
        tokenAmount.decimals
      );

    rawAmount +=
      BigInt(
        tokenAmount.amount
      );
  }

  return {
    amount:
      rawAmount.toString(),

    decimals,

    uiAmount:
      decimals > 0
        ? Number(rawAmount) /
          Math.pow(
            10,
            decimals
          )
        : Number(rawAmount)
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
    const result =
      await getTokenBalance(
        connection,
        owner,
        USDC_MINT
      );

    return result.uiAmount;

  } catch (error) {
    console.log(
      "USDC balance lookup failed:",
      error?.message ||
      String(error)
    );

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
    secret.length !== 64 &&
    secret.length !== 32
  ) {
    throw new Error(
      `WALLET_PRIVATE_KEY decoded to ${secret.length} bytes. Expected 32 or 64 bytes.`
    );
  }

  if (
    secret.length === 32
  ) {
    return Keypair.fromSeed(
      secret
    );
  }

  return Keypair.fromSecretKey(
    secret
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
    `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
    "confirmed"
  );
}


/* =========================================================
   PRIVATE KEY DECODER
   ========================================================= */

function decodePrivateKey(value) {
  const text =
    value.trim();

  if (
    text.startsWith("[")
  ) {
    const array =
      JSON.parse(text);

    return Uint8Array.from(
      array
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

  const chunkSize =
    0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    binary +=
      String.fromCharCode(
        ...bytes.subarray(
          i,
          Math.min(
            i + chunkSize,
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

  let digits = [0];

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
        number & 255;

      carry =
        Math.floor(
          number / 256
        );
    }

    while (
      carry > 0
    ) {
      digits.push(
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
    JSON.stringify(
      position
    )
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
   SCAN ENDPOINT
   ========================================================= */

async function scanCandidates(
  env
) {
  validateSecrets(env);

  const solPrice =
    await getSolUsdPrice(
      env
    );

  const connection =
    getConnection(env);

  const wallet =
    getWallet(env);

  const solBalance =
    await getSolBalance(
      connection,
      wallet.publicKey
    );

  const availableLamports =
    getSpendableSolLamports(
      solBalance
    );

  if (
    availableLamports <= 0
  ) {
    return {
      action:
        "WAITING",
      reason:
        "Not enough SOL after reserve."
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
      availableLamports,
      maxTradeLamports
    );

  const tokens =
    await getTrendingTokens(
      env
    );

  const results = [];

  for (
    const token of tokens.slice(
      0,
      10
    )
  ) {
    const liquidity =
      toNumber(
        token.liquidity
      );

    const volume24h =
      getVolume24h(token);

    if (
      liquidity <
      MIN_LIQUIDITY_USD ||
      volume24h <
      MIN_VOLUME_24H_USD
    ) {
      continue;
    }

    try {
      const quote =
        await getJupiterOrder(
          env,
          SOL_MINT,
          token.mint ||
          token.id,
          tradeLamports.toString(),
          null
        );

      results.push({
        symbol:
          token.symbol,
        name:
          token.name,
        mint:
          token.mint ||
          token.id,
        liquidity,
        volume_24h:
          volume24h,
        price_change:
          getPriceChange(token),
        price_impact:
          getPriceImpactPercent(
            quote
          ),
        output_amount:
          quote.outAmount
      });

    } catch (_) {}
  }

  return {
    bot:
      "Memebot",

    strategy:
      "SOL -> trending token -> SOL",

    sol_balance:
      solBalance,

    sol_price:
      solPrice,

    trade_sol:
      tradeLamports /
      1_000_000_000,

    candidates:
      results
  };
}


/* =========================================================
   TOKEN HELPERS
   ========================================================= */

function getVolume24h(
  token
) {
  const direct =
    toNumber(
      token.volume24h
    );

  if (direct > 0) {
    return direct;
  }

  const stats =
    token.stats ||
    token.stats24h ||
    {};

  return toNumber(
    stats.volume24h ||
    stats.volume
  );
}


function getPriceChange(
  token
) {
  const direct =
    toNumber(
      token.priceChange24h
    );

  if (
    Number.isFinite(
      direct
    )
  ) {
    return direct;
  }

  const stats =
    token.stats ||
    token.stats24h ||
    {};

  return toNumber(
    stats.priceChange24h ||
    stats.priceChange ||
    0
  );
}


function getPriceImpactPercent(
  quote
) {
  const value =
    toNumber(
      quote.priceImpactPct
    );

  return value;
}


function toNumber(
  value
) {
  const number =
    Number(
      value
    );

  return Number.isFinite(
    number
  )
    ? number
    : 0;
}


/* =========================================================
   SECRET / BINDING VALIDATION
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
