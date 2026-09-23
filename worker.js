const BOT_NAME = "memebott";

const WALLET_ADDRESS =
  "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const LIVE_TRADING = true;

const PROFIT_TARGET = 0.025;
const STOP_LOSS = -0.01;

const SMALL_TRADE_CAP_USD = 2;
const LARGE_TRADE_CAP_USD = 5;
const BALANCE_THRESHOLD_USD = 20;

const MIN_SOL_RESERVE = 0.01;

const MAX_POSITIONS = 10;

const IMMEDIATE_LOSS_FILTER = 0.005;

const SLIPPAGE_BPS = 50;

const POSITION_KEY = "POSITIONS";
const COOLDOWN_KEY = "TRADE_COOLDOWN";

const COOLDOWN_SECONDS = 30;

const JUPITER_API = "https://api.jup.ag";

const PRICE_API =
  `${JUPITER_API}/price/v3`;

const TOKENS_API =
  `${JUPITER_API}/tokens/v2`;

const SWAP_API =
  `${JUPITER_API}/swap/v2`;

const HELIUS_RPC_BASE =
  "https://mainnet.helius-rpc.com";


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
          ok: true,
          bot: BOT_NAME,
          message: "memebott is running",
          live_trading: LIVE_TRADING
        });

      }

      if (url.pathname === "/status") {
        return await status(env);
      }

      // SAFE TEST - NEVER BUYS OR SELLS
      if (url.pathname === "/test") {
        return await testBot(env);
      }

      if (url.pathname === "/run") {
        return await runBot(env, "manual");
      }

      return json({
        ok: false,
        error: "Not found"
      }, 404);

    } catch (error) {

      console.log(
        `FETCH ERROR: ${errorMessage(error)}`
      );

      return json({
        ok: false,
        error: errorMessage(error)
      }, 500);
    }
  },


  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      runBot(env, "cron")
        .catch(error => {
          console.log(
            `CRON ERROR: ${errorMessage(error)}`
          );
        })
    );
  }

};


// ============================================================
// SAFE TEST
// ============================================================

async function testBot(env) {

  validateEnv(env);

  const wallet =
    await getWalletBalance(env);

  const solPrice =
    await getUsdPrice(
      SOL_MINT,
      env
    );

  const positions =
    await getPositions(env);

  const cooldown =
    await env.BOT_KV.get(
      COOLDOWN_KEY
    );

  let trending = [];
  let trendingError = null;

  try {

    trending =
      await getTrendingTokens(env);

  } catch (error) {

    trendingError =
      errorMessage(error);
  }

  return json({

    ok: true,

    test_only: true,

    bot: BOT_NAME,

    live_trading:
      LIVE_TRADING,

    wallet:
      WALLET_ADDRESS,

    sol_balance:
      wallet.sol,

    sol_price_usd:
      solPrice,

    wallet_value_usd:
      round(
        wallet.sol *
        solPrice,
        4
      ),

    open_positions:
      positions.length,

    cooldown_active:
      !!cooldown &&
      Number(cooldown) >
        Date.now(),

    trending_candidates:
      trending.length,

    sample_candidates:
      trending
        .slice(0, 10)
        .map(token => ({
          symbol:
            token.symbol ||
            token.name ||
            "TOKEN",

          name:
            token.name ||
            null,

          mint:
            getTokenMint(token)
        })),

    trending_error:
      trendingError,

    note:
      "TEST NEVER BUYS OR SELLS."

  });
}


// ============================================================
// MAIN BOT
// ============================================================

async function runBot(
  env,
  source
) {

  validateEnv(env);

  const wallet =
    await getWalletBalance(env);

  const solPrice =
    await getUsdPrice(
      SOL_MINT,
      env
    );

  const walletValueUsd =
    wallet.sol *
    solPrice;

  const maxTradeUsd =
    walletValueUsd >=
    BALANCE_THRESHOLD_USD

      ? LARGE_TRADE_CAP_USD

      : SMALL_TRADE_CAP_USD;

  const positions =
    await getPositions(env);

  const actions = [];


  // ----------------------------------------------------------
  // MANAGE EXISTING POSITIONS
  // ----------------------------------------------------------

  for (
    const position of positions
  ) {

    try {

      const result =
        await managePosition(
          position,
          env
        );

      if (result) {
        actions.push(result);
      }

    } catch (error) {

      const msg =
        `POSITION ERROR ${
          position.symbol ||
          position.mint
        }: ${
          errorMessage(error)
        }`;

      console.log(msg);

      actions.push({
        action: "ERROR",
        error: msg
      });
    }
  }


  // ----------------------------------------------------------
  // LOOK FOR NEW BUY
  // ----------------------------------------------------------

  const updatedPositions =
    await getPositions(env);

  if (
    updatedPositions.length <
    MAX_POSITIONS
  ) {

    const cooldown =
      await env.BOT_KV.get(
        COOLDOWN_KEY
      );

    if (
      !cooldown ||
      Number(cooldown) <=
        Date.now()
    ) {

      try {

        const result =
          await findAndBuy(
            env,
            walletValueUsd,
            maxTradeUsd
          );

        if (result) {
          actions.push(result);
        }

      } catch (error) {

        const msg =
          `BUY ERROR: ${
            errorMessage(error)
          }`;

        console.log(msg);

        actions.push({
          action: "ERROR",
          error: msg
        });
      }

    } else {

      actions.push({
        action: "NO_TRADE",
        reason: "Cooldown active"
      });
    }

  } else {

    actions.push({
      action: "NO_TRADE",
      reason:
        "Maximum positions reached"
    });
  }


  return json({

    ok: true,

    bot: BOT_NAME,

    source,

    live_trading:
      LIVE_TRADING,

    wallet:
      WALLET_ADDRESS,

    sol_balance:
      wallet.sol,

    sol_price_usd:
      solPrice,

    wallet_value_usd:
      round(
        walletValueUsd,
        4
      ),

    max_trade_usd:
      maxTradeUsd,

    open_positions:
      (
        await getPositions(env)
      ).length,

    max_positions:
      MAX_POSITIONS,

    profit_target_percent:
      PROFIT_TARGET * 100,

    stop_loss_percent:
      STOP_LOSS * 100,

    actions,

    positions:
      await getPositions(env)

  });
}


// ============================================================
// FIND AND BUY
// ============================================================

async function findAndBuy(
  env,
  walletValueUsd,
  maxTradeUsd
) {

  const positions =
    await getPositions(env);

  if (
    positions.length >=
    MAX_POSITIONS
  ) {

    return {
      action: "NO_TRADE",
      reason:
        "Maximum positions reached"
    };
  }


  const wallet =
    await getWalletBalance(env);

  const solPrice =
    await getUsdPrice(
      SOL_MINT,
      env
    );


  const availableSol =
    Math.max(
      0,
      wallet.sol -
        MIN_SOL_RESERVE
    );


  const availableUsd =
    availableSol *
    solPrice;


  const tradeUsd =
    Math.min(
      maxTradeUsd,
      availableUsd
    );


  if (
    tradeUsd <= 0
  ) {

    return {
      action: "NO_TRADE",
      reason:
        "Insufficient SOL"
    };
  }


  const candidates =
    await getTrendingTokens(env);


  if (
    !candidates.length
  ) {

    return {
      action: "NO_TRADE",
      reason:
        "No trending candidates returned"
    };
  }


  const candidate =
    await selectCandidate(
      candidates,
      env
    );


  if (!candidate) {

    return {
      action: "NO_TRADE",
      reason:
        "No candidate passed price/score checks"
    };
  }


  const mint =
    getTokenMint(candidate);


  const symbol =
    candidate.symbol ||
    candidate.name ||
    "TOKEN";


  if (
    !mint ||
    mint === SOL_MINT
  ) {

    return {
      action: "NO_TRADE",
      reason:
        "Invalid candidate mint"
    };
  }


  const tokenPrice =
    await getUsdPrice(
      mint,
      env
    );


  const decimals =
    await getTokenDecimals(
      mint,
      env
    );


  if (
    !tokenPrice ||
    tokenPrice <= 0
  ) {

    return {
      action: "NO_TRADE",
      reason:
        `${symbol}: no usable token price`
    };
  }


  if (
    decimals == null
  ) {

    return {
      action: "NO_TRADE",
      reason:
        `${symbol}: token decimals unavailable`
    };
  }


  const tradeSol =
    tradeUsd /
    solPrice;


  const lamports =
    Math.floor(
      tradeSol *
      1_000_000_000
    );


  if (
    lamports < 1
  ) {

    return {
      action: "NO_TRADE",
      reason:
        "Trade amount is below 1 lamport"
    };
  }


  // ----------------------------------------------------------
  // JUPITER ORDER
  // ----------------------------------------------------------

  const order =
    await getOrder(
      SOL_MINT,
      mint,
      lamports,
      env
    );


  if (!order) {

    return {
      action: "NO_TRADE",
      reason:
        `${symbol}: Jupiter returned no executable order`
    };
  }


  const expectedOutput =
    Number(
      order.outAmount ||
      order.outputAmount ||
      0
    );


  if (
    !Number.isFinite(
      expectedOutput
    ) ||
    expectedOutput <= 0
  ) {

    return {
      action: "NO_TRADE",
      reason:
        `${symbol}: invalid Jupiter output`
    };
  }


  // ----------------------------------------------------------
  // CORRECT TOKEN DECIMAL CALCULATION
  // ----------------------------------------------------------

  const expectedTokenUnits =
    expectedOutput /
    Math.pow(
      10,
      decimals
    );


  const expectedTokenUsd =
    expectedTokenUnits *
    tokenPrice;


  const minimumAcceptableUsd =
    tradeUsd *
    (
      1 -
      IMMEDIATE_LOSS_FILTER
    );


  if (
    expectedTokenUsd <
    minimumAcceptableUsd
  ) {

    return {

      action:
        "NO_TRADE",

      reason:
        `${symbol}: immediate loss filter`,

      expected_usd:
        round(
          expectedTokenUsd,
          6
        ),

      minimum_usd:
        round(
          minimumAcceptableUsd,
          6
        )
    };
  }


  if (
    !LIVE_TRADING
  ) {

    return {

      action:
        "PAPER_TRADE",

      symbol,

      mint,

      trade_usd:
        tradeUsd
    };
  }


  console.log(
    `BUY ATTEMPT ${symbol} ${mint} $${tradeUsd}`
  );


  // ----------------------------------------------------------
  // SIGN + JUPITER EXECUTE
  // ----------------------------------------------------------

  const execution =
    await executeOrder(
      order,
      env
    );


  if (
    execution.status !==
    "Success"
  ) {

    throw new Error(
      `BUY FAILED: ${
        execution.error ||
        JSON.stringify(execution)
      }`
    );
  }


  const position = {

    mint,

    symbol,

    name:
      candidate.name ||
      symbol,

    entrySol:
      tradeSol,

    entryUsd:
      tradeUsd,

    tokenAmount:
      Number(
        execution.outputAmountResult ||
        expectedOutput
      ),

    tokenDecimals:
      decimals,

    entryTokenPrice:
      tokenPrice,

    buySignature:
      execution.signature,

    createdAt:
      Date.now(),

    selectionScore:
      Number(
        candidate._score ||
        0
      ),

    selectionReason:
      "Trending token with liquidity, volume, verification/organic score and executable Jupiter route"
  };


  const latest =
    await getPositions(env);


  latest.push(position);


  await savePositions(
    env,
    latest
  );


  await env.BOT_KV.put(
    COOLDOWN_KEY,
    String(
      Date.now() +
      COOLDOWN_SECONDS *
      1000
    )
  );


  console.log(
    `BUY SUCCESS ${symbol}: ${execution.signature}`
  );


  return {

    action:
      "BUY",

    symbol,

    mint,

    signature:
      execution.signature,

    trade_usd:
      tradeUsd,

    position
  };
}


// ============================================================
// MANAGE POSITION
// ============================================================

async function managePosition(
  position,
  env
) {

  const currentPrice =
    await getUsdPrice(
      position.mint,
      env
    );


  const entryPrice =
    Number(
      position.entryTokenPrice
    );


  if (
    !currentPrice ||
    currentPrice <= 0 ||
    !entryPrice ||
    entryPrice <= 0
  ) {

    return {
      action:
        "HOLD",

      symbol:
        position.symbol,

      reason:
        "Price unavailable"
    };
  }


  const change =
    (
      currentPrice -
      entryPrice
    ) /
    entryPrice;


  console.log(
    `${position.symbol}: ${
      (
        change *
        100
      ).toFixed(3)
    }%`
  );


  if (
    change >=
    PROFIT_TARGET
  ) {

    return await sellPosition(
      position,
      env,
      "TAKE_PROFIT"
    );
  }


  if (
    change <=
    STOP_LOSS
  ) {

    return await sellPosition(
      position,
      env,
      "STOP_LOSS"
    );
  }


  return {

    action:
      "HOLD",

    symbol:
      position.symbol,

    change_percent:
      round(
        change * 100,
        4
      )
  };
}


// ============================================================
// SELL
// ============================================================

async function sellPosition(
  position,
  env,
  reason
) {

  const balance =
    await getTokenBalance(
      position.mint,
      env
    );


  if (
    !balance ||
    balance.amount <= 0
  ) {

    await removePosition(
      position.mint,
      env
    );

    return {

      action:
        "REMOVE",

      symbol:
        position.symbol,

      reason:
        "No token balance"
    };
  }


  const order =
    await getOrder(
      position.mint,
      SOL_MINT,
      balance.amount,
      env
    );


  if (!order) {

    return {

      action:
        "SELL_WAIT",

      symbol:
        position.symbol,

      reason:
        "No Jupiter sell route"
    };
  }


  if (
    !LIVE_TRADING
  ) {

    await removePosition(
      position.mint,
      env
    );

    return {

      action:
        "PAPER_SELL",

      symbol:
        position.symbol,

      reason
    };
  }


  console.log(
    `SELL ATTEMPT ${position.symbol} ${reason}`
  );


  const execution =
    await executeOrder(
      order,
      env
    );


  if (
    execution.status !==
    "Success"
  ) {

    throw new Error(
      `SELL FAILED: ${
        execution.error ||
        JSON.stringify(execution)
      }`
    );
  }


  await removePosition(
    position.mint,
    env
  );


  await env.BOT_KV.put(
    COOLDOWN_KEY,
    String(
      Date.now() +
      COOLDOWN_SECONDS *
      1000
    )
  );


  console.log(
    `SELL SUCCESS ${position.symbol}: ${execution.signature}`
  );


  return {

    action:
      "SELL",

    symbol:
      position.symbol,

    reason,

    signature:
      execution.signature
  };
}


// ============================================================
// CANDIDATE SELECTION
// ============================================================

async function selectCandidate(
  candidates,
  env
) {

  let best = null;


  for (
    const token of candidates
  ) {

    const mint =
      getTokenMint(token);


    if (
      !mint ||
      mint === SOL_MINT
    ) {
      continue;
    }


    const symbol =
      token.symbol ||
      token.name ||
      "";


    if (!symbol) {
      continue;
    }


    try {

      const price =
        await getUsdPrice(
          mint,
          env
        );


      if (
        !price ||
        price <= 0
      ) {
        continue;
      }


      const liquidity =
        Number(
          token.liquidity ||
          token.liquidityUsd ||
          token.liquidity_usd ||
          0
        );


      const volume =
        Number(
          token.volume24h ||
          token.volume24hUsd ||
          token.volume_24h ||
          0
        );


      const buySell =
        Number(
          token.buySellRatio ||
          0
        );


      let score = 0;


      score +=
        Math.min(
          30,
          Math.log10(
            Math.max(
              liquidity,
              1
            )
          ) * 3
        );


      score +=
        Math.min(
          30,
          Math.log10(
            Math.max(
              volume,
              1
            )
          ) * 3
        );


      if (
        Number.isFinite(
          buySell
        ) &&
        buySell > 1
      ) {

        score +=
          Math.min(
            20,
            buySell * 5
          );
      }


      if (
        token.isVerified === true
      ) {

        score += 10;
      }


      if (
        token.organicScore != null
      ) {

        score +=
          Math.min(
            10,
            Number(
              token.organicScore
            ) || 0
          );
      }


      token._score =
        score;


      if (
        !best ||
        score >
        best._score
      ) {

        best =
          token;
      }

    } catch (error) {

      console.log(
        `CANDIDATE ERROR ${symbol}: ${
          errorMessage(error)
        }`
      );
    }
  }


  return best;
}


// ============================================================
// TRENDING TOKENS
// ============================================================

async function getTrendingTokens(env) {

  const urls = [

    `${TOKENS_API}/toptrending/24h`,

    `${TOKENS_API}/toptrending/1h`,

    `${TOKENS_API}/toptrending/5m`

  ];


  const results = [];


  for (
    const url of urls
  ) {

    try {

      const response =
        await jupiterFetch(
          url,
          env
        );


      const body =
        await response.text();


      if (
        !response.ok
      ) {

        console.log(
          `TRENDING HTTP ${
            response.status
          }: ${body}`
        );

        continue;
      }


      const data =
        JSON.parse(body);


      const list =
        Array.isArray(data)

          ? data

          : (
              data.tokens ||
              data.data ||
              []
            );


      for (
        const token of list
      ) {

        const mint =
          getTokenMint(
            token
          );


        if (
          mint &&
          mint !== SOL_MINT
        ) {

          results.push(
            token
          );
        }
      }


    } catch (error) {

      console.log(
        `TRENDING ERROR: ${
          errorMessage(error)
        }`
      );
    }
  }


  const seen =
    new Set();


  return results.filter(
    token => {

      const mint =
        getTokenMint(
          token
        );


      if (
        !mint ||
        seen.has(mint)
      ) {

        return false;
      }


      seen.add(mint);

      return true;
    }
  );
}


// ============================================================
// TOKEN MINT
// ============================================================

function getTokenMint(token) {

  return (
    token?.id ||
    token?.address ||
    token?.mint ||
    null
  );
}


// ============================================================
// PRICE
// ============================================================

async function getPrices(
  ids,
  env
) {

  if (
    !ids.length
  ) {
    return {};
  }


  const response =
    await jupiterFetch(
      `${PRICE_API}?ids=${
        encodeURIComponent(
          ids.join(",")
        )
      }`,
      env
    );


  if (
    !response.ok
  ) {

    throw new Error(
      `Jupiter price HTTP ${
        response.status
      }: ${
        await response.text()
      }`
    );
  }


  return await response.json();
}


async function getUsdPrice(
  mint,
  env
) {

  const prices =
    await getPrices(
      [mint],
      env
    );


  const item =
    prices[mint];


  return item
    ? Number(
        item.usdPrice ||
        item.price ||
        0
      )
    : 0;
}


// ============================================================
// TOKEN DECIMALS
// ============================================================

async function getTokenDecimals(
  mint,
  env
) {

  const result =
    await heliusRpc(
      env,
      "getTokenSupply",
      [mint]
    );


  const decimals =
    result?.result
      ?.value
      ?.decimals;


  return Number.isInteger(
    decimals
  )
    ? decimals
    : null;
}


// ============================================================
// JUPITER ORDER
// ============================================================

async function getOrder(
  inputMint,
  outputMint,
  amount,
  env
) {

  const params =
    new URLSearchParams({

      inputMint,

      outputMint,

      amount:
        String(amount),

      taker:
        WALLET_ADDRESS,

      slippageBps:
        String(
          SLIPPAGE_BPS
        )

    });


  const response =
    await jupiterFetch(
      `${SWAP_API}/order?${params.toString()}`,
      env
    );


  const body =
    await response.text();


  if (
    !response.ok
  ) {

    console.log(
      `JUPITER ORDER HTTP ${
        response.status
      }: ${body}`
    );

    return null;
  }


  const data =
    JSON.parse(body);


  if (
    !data ||
    !data.transaction ||
    !data.requestId
  ) {

    console.log(
      `JUPITER ORDER NO TRANSACTION: ${body}`
    );

    return null;
  }


  return data;
}


// ============================================================
// JUPITER EXECUTE
// ============================================================

async function executeOrder(
  order,
  env
) {

  const transactionBytes =
    base64ToBytes(
      order.transaction
    );


  const signatureInfo =
    readShortVec(
      transactionBytes,
      0
    );


  if (
    signatureInfo.value < 1
  ) {

    throw new Error(
      "Transaction has no signer"
    );
  }


  const signatureOffset =
    signatureInfo.offset;


  const messageOffset =
    signatureOffset +
    signatureInfo.value *
      64;


  if (
    messageOffset >=
    transactionBytes.length
  ) {

    throw new Error(
      "Invalid Solana transaction layout"
    );
  }


  const messageBytes =
    transactionBytes.slice(
      messageOffset
    );


  const key =
    await importPrivateKey(
      env.WALLET_PRIVATE_KEY
    );


  const signedBytes =
    await crypto.subtle.sign(
      {
        name:
          "Ed25519"
      },
      key,
      messageBytes
    );


  if (
    signedBytes.byteLength !==
    64
  ) {

    throw new Error(
      "Invalid Ed25519 signature length"
    );
  }


  transactionBytes.set(
    new Uint8Array(
      signedBytes
    ),
    signatureOffset
  );


  const signedTransaction =
    bytesToBase64(
      transactionBytes
    );


  const response =
    await jupiterFetch(
      `${SWAP_API}/execute`,
      env,
      {

        method:
          "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify({

            signedTransaction,

            requestId:
              order.requestId

          })
      }
    );


  const body =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `Jupiter execute HTTP ${
        response.status
      }: ${body}`
    );
  }


  const result =
    JSON.parse(body);


  console.log(
    `JUPITER EXECUTE: ${
      JSON.stringify(result)
    }`
  );


  return result;
}


// ============================================================
// SOLANA SHORTVEC
// ============================================================

function readShortVec(
  bytes,
  offset
) {

  let value = 0;

  let size = 0;

  let shift = 0;


  while (true) {

    if (
      offset + size >=
      bytes.length
    ) {

      throw new Error(
        "Invalid Solana shortvec"
      );
    }


    const byte =
      bytes[
        offset + size
      ];


    value +=
      (
        byte &
        0x7f
      ) *
      Math.pow(
        2,
        shift
      );


    size++;


    if (
      (
        byte &
        0x80
      ) === 0
    ) {

      return {

        value,

        offset:
          offset + size

      };
    }


    shift += 7;


    if (
      size > 5
    ) {

      throw new Error(
        "Invalid Solana shortvec"
      );
    }
  }
}


// ============================================================
// PRIVATE KEY
// ============================================================

async function importPrivateKey(
  privateKey
) {

  if (
    !privateKey
  ) {

    throw new Error(
      "Missing WALLET_PRIVATE_KEY"
    );
  }


  const trimmed =
    privateKey.trim();


  let secretBytes;


  if (
    trimmed.startsWith("[")
  ) {

    secretBytes =
      new Uint8Array(
        JSON.parse(
          trimmed
        )
      );

  } else {

    secretBytes =
      base58ToBytes(
        trimmed
      );
  }


  let seed;


  if (
    secretBytes.length ===
    64
  ) {

    seed =
      secretBytes.slice(
        0,
        32
      );

  } else if (
    secretBytes.length ===
    32
  ) {

    seed =
      secretBytes;

  } else {

    throw new Error(
      `Private key must decode to 32 or 64 bytes, got ${
        secretBytes.length
      }`
    );
  }


  const prefix =
    new Uint8Array([

      0x30, 0x2e,

      0x02, 0x01, 0x00,

      0x30, 0x05,

      0x06, 0x03,

      0x2b, 0x65, 0x70,

      0x04, 0x22,

      0x04, 0x20

    ]);


  const pkcs8 =
    new Uint8Array(
      prefix.length +
      seed.length
    );


  pkcs8.set(
    prefix
  );


  pkcs8.set(
    seed,
    prefix.length
  );


  return await crypto.subtle.importKey(

    "pkcs8",

    pkcs8,

    {
      name:
        "Ed25519"
    },

    false,

    ["sign"]

  );
}


// ============================================================
// HELIUS RPC
// ============================================================

async function heliusRpc(
  env,
  method,
  params
) {

  if (
    !env.HELIUS_API_KEY
  ) {

    throw new Error(
      "Missing HELIUS_API_KEY"
    );
  }


  const response =
    await fetch(

      `${HELIUS_RPC_BASE}/?api-key=${
        encodeURIComponent(
          env.HELIUS_API_KEY
        )
      }`,

      {

        method:
          "POST",

        headers: {

          "content-type":
            "application/json"

        },

        body:
          JSON.stringify({

            jsonrpc:
              "2.0",

            id:
              1,

            method,

            params

          })

      }
    );


  const body =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `Helius RPC HTTP ${
        response.status
      }: ${body}`
    );
  }


  const data =
    JSON.parse(body);


  if (
    data.error
  ) {

    throw new Error(
      data.error.message ||
      JSON.stringify(
        data.error
      )
    );
  }


  return data;
}


// ============================================================
// JUPITER FETCH
// ============================================================

async function jupiterFetch(
  url,
  env,
  options = {}
) {

  const headers =
    new Headers(
      options.headers || {}
    );


  headers.set(
    "accept",
    "application/json"
  );


  if (
    env.JUPITER_API_KEY
  ) {

    headers.set(
      "x-api-key",
      env.JUPITER_API_KEY
    );
  }


  return await fetch(
    url,
    {
      ...options,
      headers
    }
  );
}


// ============================================================
// WALLET BALANCE
// ============================================================

async function getWalletBalance(
  env
) {

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
      result?.result?.value ||
      0
    );


  return {

    lamports,

    sol:
      lamports /
      1_000_000_000

  };
}


// ============================================================
// TOKEN BALANCE
// ============================================================

async function getTokenBalance(
  mint,
  env
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
    result?.result?.value ||
    [];


  let amount = 0;


  for (
    const account of accounts
  ) {

    const tokenAmount =
      account
        ?.account
        ?.data
        ?.parsed
        ?.info
        ?.tokenAmount;


    if (
      tokenAmount
    ) {

      amount +=
        Number(
          tokenAmount.amount ||
          0
        );
    }
  }


  return {
    amount
  };
}


// ============================================================
// POSITIONS
// ============================================================

async function getPositions(
  env
) {

  const raw =
    await env.BOT_KV.get(
      POSITION_KEY
    );


  if (!raw) {
    return [];
  }


  try {

    const parsed =
      JSON.parse(raw);


    return Array.isArray(
      parsed
    )
      ? parsed
      : [];

  } catch {

    return [];
  }
}


async function savePositions(
  env,
  positions
) {

  await env.BOT_KV.put(

    POSITION_KEY,

    JSON.stringify(
      positions
    )

  );
}


async function removePosition(
  mint,
  env
) {

  const positions =
    await getPositions(
      env
    );


  await savePositions(

    env,

    positions.filter(
      position =>
        position.mint !==
        mint
    )

  );
}


// ============================================================
// STATUS
// ============================================================

async function status(
  env
) {

  validateEnv(env);


  const wallet =
    await getWalletBalance(
      env
    );


  const solPrice =
    await getUsdPrice(
      SOL_MINT,
      env
    );


  const walletValueUsd =
    wallet.sol *
    solPrice;


  const positions =
    await getPositions(
      env
    );


  const cooldown =
    await env.BOT_KV.get(
      COOLDOWN_KEY
    );


  return json({

    ok: true,

    bot:
      BOT_NAME,

    live_trading:
      LIVE_TRADING,

    wallet:
      WALLET_ADDRESS,

    sol_balance:
      wallet.sol,

    sol_price_usd:
      solPrice,

    wallet_value_usd:
      round(
        walletValueUsd,
        4
      ),

    max_trade_usd:
      walletValueUsd >=
      BALANCE_THRESHOLD_USD

        ? LARGE_TRADE_CAP_USD

        : SMALL_TRADE_CAP_USD,

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

    profit_target_percent:
      PROFIT_TARGET * 100,

    stop_loss_percent:
      STOP_LOSS * 100,

    cooldown_active:
      !!cooldown &&
      Number(cooldown) >
        Date.now(),

    positions

  });
}


// ============================================================
// VALIDATION
// ============================================================

function validateEnv(
  env
) {

  const required = [

    "BOT_KV",

    "HELIUS_API_KEY",

    "JUPITER_API_KEY",

    "WALLET_PRIVATE_KEY"

  ];


  for (
    const name of required
  ) {

    if (!env[name]) {

      throw new Error(
        `Missing ${name}`
      );
    }
  }
}


// ============================================================
// BASE64
// ============================================================

function base64ToBytes(
  value
) {

  const binary =
    atob(value);


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
        ...bytes.subarray(
          i,
          Math.min(
            i + chunkSize,
            bytes.length
          )
        )
      );
  }


  return btoa(binary);
}


// ============================================================
// BASE58
// ============================================================

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";


function base58ToBytes(
  input
) {

  if (!input) {

    return new Uint8Array();
  }


  let n = 0n;


  for (
    const char of input
  ) {

    const value =
      BASE58_ALPHABET.indexOf(
        char
      );


    if (
      value < 0
    ) {

      throw new Error(
        "Invalid base58 private key"
      );
    }


    n =
      n *
      58n +
      BigInt(value);
  }


  const out = [];


  while (
    n > 0n
  ) {

    out.push(
      Number(
        n &
        255n
      )
    );


    n >>= 8n;
  }


  out.reverse();


  let leading = 0;


  while (
    leading <
      input.length &&
    input[leading] ===
      "1"
  ) {

    leading++;
  }


  if (
    leading
  ) {

    return new Uint8Array(

      new Array(
        leading
      )
        .fill(0)
        .concat(out)

    );
  }


  return new Uint8Array(
    out
  );
}


// ============================================================
// HELPERS
// ============================================================

function round(
  value,
  decimals = 4
) {

  const factor =
    Math.pow(
      10,
      decimals
    );


  return (
    Math.round(
      value *
      factor
    ) /
    factor
  );
}


function errorMessage(
  error
) {

  return error instanceof Error
    ? error.message
    : String(error);
}


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
          "application/json; charset=utf-8"

      }

    }

  );
}
