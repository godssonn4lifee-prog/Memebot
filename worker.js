const BOT_NAME = "memebott";

const WALLET_ADDRESS =
  "266pAnqVEivGn3bH87c3pbTcrR5iCnpZSt6E9H6rcvS6";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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

const JUPITER_API =
  "https://api.jup.ag";

const JUPITER_LITE_API =
  "https://lite-api.jup.ag";

const PRICE_API =
  `${JUPITER_LITE_API}/price/v3`;

const TOKENS_API =
  `${JUPITER_LITE_API}/tokens/v2`;

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
      const url = new URL(request.url);

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

      if (url.pathname === "/run") {
        return await runBot(env);
      }

      return json({
        ok: false,
        error: "Not found"
      }, 404);

    } catch (error) {
      return json({
        ok: false,
        error: errorMessage(error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBot(env).catch(() => {})
    );
  }
};


// ============================================================
// MAIN BOT
// ============================================================

async function runBot(env) {
  validateEnv(env);

  const wallet = await getWalletBalance(env);

  const solBalance = wallet.sol;

  const solPrice = await getUsdPrice(
    SOL_MINT,
    env
  );

  const walletValueUsd =
    solBalance * solPrice;

  const maxTradeUsd =
    walletValueUsd >= BALANCE_THRESHOLD_USD
      ? LARGE_TRADE_CAP_USD
      : SMALL_TRADE_CAP_USD;

  const positions =
    await getPositions(env);

  const result = {
    ok: true,
    bot: BOT_NAME,
    live_trading: LIVE_TRADING,
    wallet: WALLET_ADDRESS,
    sol_balance: solBalance,
    sol_price_usd: solPrice,
    wallet_value_usd: round(walletValueUsd, 4),
    max_trade_usd: maxTradeUsd,
    open_positions: positions.length,
    max_positions: MAX_POSITIONS,
    profit_target_percent: PROFIT_TARGET * 100,
    stop_loss_percent: STOP_LOSS * 100,
    positions
  };

  // ----------------------------------------------------------
  // First manage existing positions.
  // ----------------------------------------------------------

  for (const position of positions) {
    try {
      await managePosition(
        position,
        env
      );
    } catch (error) {
      console.log(
        `Position management error: ${errorMessage(error)}`
      );
    }
  }

  const updatedPositions =
    await getPositions(env);

  // ----------------------------------------------------------
  // If there is room, look for a new trade.
  // ----------------------------------------------------------

  if (
    updatedPositions.length <
    MAX_POSITIONS
  ) {
    try {
      const cooldown =
        await env.BOT_KV.get(COOLDOWN_KEY);

      if (
        !cooldown ||
        Number(cooldown) <= Date.now()
      ) {
        await findAndBuy(
          env,
          walletValueUsd,
          maxTradeUsd
        );
      }
    } catch (error) {
      console.log(
        `Buy scan error: ${errorMessage(error)}`
      );
    }
  }

  return json({
    ...result,
    positions: await getPositions(env)
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
    positions.length >= MAX_POSITIONS
  ) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "Maximum positions reached"
    };
  }

  const wallet =
    await getWalletBalance(env);

  const availableSol =
    Math.max(
      0,
      wallet.sol - MIN_SOL_RESERVE
    );

  const availableUsd =
    availableSol *
    await getUsdPrice(SOL_MINT, env);

  const tradeUsd =
    Math.min(
      maxTradeUsd,
      availableUsd
    );

  if (tradeUsd <= 0) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "Insufficient SOL"
    };
  }

  const candidates =
    await getTrendingTokens(env);

  if (!candidates.length) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "No suitable candidates"
    };
  }

  const candidate =
    await selectCandidate(
      candidates,
      env
    );

  if (!candidate) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "No executable candidate"
    };
  }

  const mint =
    getTokenMint(candidate);

  if (!mint) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "Candidate has no mint"
    };
  }

  if (mint === SOL_MINT) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "Candidate is SOL"
    };
  }

  const symbol =
    candidate.symbol ||
    candidate.name ||
    "TOKEN";

  const tokenPrice =
    await getUsdPrice(
      mint,
      env
    );

  if (!tokenPrice || tokenPrice <= 0) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "Token has no usable price"
    };
  }

  const solPrice =
    await getUsdPrice(
      SOL_MINT,
      env
    );

  const tradeSol =
    tradeUsd / solPrice;

  const lamports =
    Math.floor(
      tradeSol * 1_000_000_000
    );

  if (lamports <= 0) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "Trade amount too small"
    };
  }

  const order =
    await getOrder(
      SOL_MINT,
      mint,
      lamports,
      env
    );

  if (!order) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "No Jupiter route"
    };
  }

  const expectedOutput =
    Number(
      order.outAmount ||
      order.outputAmount ||
      0
    );

  if (
    !Number.isFinite(expectedOutput) ||
    expectedOutput <= 0
  ) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "Invalid Jupiter output"
    };
  }

  // Immediate round-trip filter.
  // This prevents entering when the executable route
  // already represents a material loss.

  const minimumAcceptableUsd =
    tradeUsd *
    (1 - IMMEDIATE_LOSS_FILTER);

  const expectedTokenUsd =
    expectedOutput *
    tokenPrice /
    1_000_000;

  if (
    expectedTokenUsd <
    minimumAcceptableUsd
  ) {
    return {
      ok: true,
      action: "NO_TRADE",
      reason: "Immediate loss filter rejected trade"
    };
  }

  if (!LIVE_TRADING) {
    return {
      ok: true,
      action: "PAPER_TRADE",
      symbol,
      mint,
      trade_usd: tradeUsd
    };
  }

  const signature =
    await executeOrder(
      order,
      env
    );

  const position = {
    mint,
    symbol,
    name:
      candidate.name ||
      symbol,

    entrySol: tradeSol,
    entryUsd: tradeUsd,

    tokenAmount:
      expectedOutput,

    entryTokenPrice:
      tokenPrice,

    buySignature:
      signature,

    createdAt:
      Date.now(),

    selectionScore:
      Number(
        candidate._score || 0
      ),

    selectionReason:
      "Trending token with liquidity, momentum and executable route"
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
      COOLDOWN_SECONDS * 1000
    )
  );

  return {
    ok: true,
    action: "BUY",
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

  if (
    !currentPrice ||
    currentPrice <= 0
  ) {
    return;
  }

  const entryPrice =
    Number(
      position.entryTokenPrice
    );

  if (
    !entryPrice ||
    entryPrice <= 0
  ) {
    return;
  }

  const change =
    (
      currentPrice -
      entryPrice
    ) /
    entryPrice;

  console.log(
    `${position.symbol}: ${(change * 100).toFixed(3)}%`
  );

  if (
    change >= PROFIT_TARGET
  ) {
    await sellPosition(
      position,
      env,
      "TAKE_PROFIT"
    );

    return;
  }

  if (
    change <= STOP_LOSS
  ) {
    await sellPosition(
      position,
      env,
      "STOP_LOSS"
    );
  }
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

    return;
  }

  const amount =
    balance.amount;

  const order =
    await getOrder(
      position.mint,
      SOL_MINT,
      amount,
      env
    );

  if (!order) {
    console.log(
      `No sell route for ${position.symbol}`
    );

    return;
  }

  if (!LIVE_TRADING) {
    await removePosition(
      position.mint,
      env
    );

    return;
  }

  const signature =
    await executeOrder(
      order,
      env
    );

  console.log(
    `SELL ${position.symbol} ${reason}: ${signature}`
  );

  await removePosition(
    position.mint,
    env
  );

  await env.BOT_KV.put(
    COOLDOWN_KEY,
    String(
      Date.now() +
      COOLDOWN_SECONDS * 1000
    )
  );
}


// ============================================================
// CANDIDATE SELECTION
// ============================================================

async function selectCandidate(
  candidates,
  env
) {
  let best = null;

  for (const token of candidates) {
    const mint =
      getTokenMint(token);

    if (!mint) {
      continue;
    }

    if (mint === SOL_MINT) {
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

      let score = 0;

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

      score += Math.min(
        30,
        Math.log10(
          Math.max(
            liquidity,
            1
          )
        ) * 3
      );

      score += Math.min(
        30,
        Math.log10(
          Math.max(
            volume,
            1
          )
        ) * 3
      );

      if (
        Number.isFinite(buySell) &&
        buySell > 1
      ) {
        score += Math.min(
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
        score += Math.min(
          10,
          Number(token.organicScore)
        );
      }

      token._score = score;

      if (
        !best ||
        score > best._score
      ) {
        best = token;
      }

    } catch (error) {
      console.log(
        `Candidate error: ${errorMessage(error)}`
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

  for (const url of urls) {
    try {
      const response =
        await jupiterFetch(
          url,
          env
        );

      if (!response.ok) {
        continue;
      }

      const data =
        await response.json();

      const list =
        Array.isArray(data)
          ? data
          : (
              data.tokens ||
              data.data ||
              []
            );

      for (const token of list) {
        const mint =
          getTokenMint(token);

        if (
          mint &&
          mint !== SOL_MINT
        ) {
          results.push(token);
        }
      }

    } catch (error) {
      console.log(
        `Trending request failed: ${errorMessage(error)}`
      );
    }
  }

  const seen =
    new Set();

  return results.filter(
    token => {
      const mint =
        getTokenMint(token);

      if (!mint) {
        return false;
      }

      if (seen.has(mint)) {
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
  if (!ids.length) {
    return {};
  }

  const url =
    `${PRICE_API}?ids=${encodeURIComponent(
      ids.join(",")
    )}`;

  const response =
    await jupiterFetch(
      url,
      env
    );

  if (!response.ok) {
    throw new Error(
      `Jupiter price HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  return data || {};
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

  if (!item) {
    return 0;
  }

  return Number(
    item.usdPrice ||
    item.price ||
    0
  );
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
  const url =
    `${SWAP_API}/order` +
    `?inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&taker=${encodeURIComponent(WALLET_ADDRESS)}` +
    `&slippageBps=${SLIPPAGE_BPS}`;

  const response =
    await jupiterFetch(
      url,
      env
    );

  if (!response.ok) {
    const body =
      await response.text();

    console.log(
      `Jupiter order HTTP ${response.status}: ${body}`
    );

    return null;
  }

  const data =
    await response.json();

  if (
    !data ||
    !data.transaction
  ) {
    return null;
  }

  return data;
}


// ============================================================
// EXECUTE JUPITER TRANSACTION
// ============================================================

async function executeOrder(
  order,
  env
) {
  if (
    !order ||
    !order.transaction
  ) {
    throw new Error(
      "Jupiter order has no transaction"
    );
  }

  const transactionBytes =
    base64ToBytes(
      order.transaction
    );

  const key =
    await importPrivateKey(
      env.WALLET_PRIVATE_KEY
    );

  // Solana transaction serialization:
  //
  // [shortvec signature count]
  // [64-byte signature slots]
  // [message]
  //
  // The Ed25519 signature is over the MESSAGE,
  // not over the complete serialized transaction.

  const signatureInfo =
    readShortVec(
      transactionBytes,
      0
    );

  const signatureCount =
    signatureInfo.value;

  const signatureOffset =
    signatureInfo.offset;

  if (
    signatureCount < 1
  ) {
    throw new Error(
      "Transaction has no signer"
    );
  }

  const messageOffset =
    signatureOffset +
    signatureCount * 64;

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

  const signedBytes =
    await crypto.subtle.sign(
      {
        name: "Ed25519"
      },
      key,
      messageBytes
    );

  if (
    signedBytes.byteLength !== 64
  ) {
    throw new Error(
      "Invalid Ed25519 signature length"
    );
  }

  // First signature slot belongs to the taker wallet.
  const signature =
    new Uint8Array(
      signedBytes
    );

  transactionBytes.set(
    signature,
    signatureOffset
  );

  const encoded =
    bytesToBase64(
      transactionBytes
    );

  const result =
    await heliusRpc(
      env,
      "sendTransaction",
      [
        encoded,
        {
          encoding: "base64",
          skipPreflight: false,
          maxRetries: 3
        }
      ]
    );

  if (
    result?.error
  ) {
    throw new Error(
      result.error.message ||
      JSON.stringify(result.error)
    );
  }

  if (
    !result?.result
  ) {
    throw new Error(
      "Transaction was not accepted"
    );
  }

  return result.result;
}


// ============================================================
// IMPORTANT: SOLANA SHORTVEC DECODER
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
      (byte & 0x7f) *
      Math.pow(
        2,
        shift
      );

    size++;

    if (
      (byte & 0x80) === 0
    ) {
      return {
        value,
        offset:
          offset + size
      };
    }

    shift += 7;

    if (size > 5) {
      throw new Error(
        "Invalid Solana shortvec"
      );
    }
  }
}


// ============================================================
// PRIVATE KEY IMPORT
// ============================================================

async function importPrivateKey(
  privateKey
) {
  if (!privateKey) {
    throw new Error(
      "Missing WALLET_PRIVATE_KEY"
    );
  }

  let secretBytes;

  const trimmed =
    privateKey.trim();

  // JSON array format:
  // [1,2,3,...]

  if (
    trimmed.startsWith("[")
  ) {
    const array =
      JSON.parse(trimmed);

    secretBytes =
      new Uint8Array(
        array
      );
  } else {
    // Base58 format.
    secretBytes =
      base58ToBytes(
        trimmed
      );
  }

  // Solana wallets normally store
  // a 64-byte secret key:
  //
  // first 32 bytes = private seed
  // last 32 bytes = public key
  //
  // WebCrypto PKCS#8 import requires
  // the 32-byte Ed25519 seed.

  let seed;

  if (
    secretBytes.length === 64
  ) {
    seed =
      secretBytes.slice(
        0,
        32
      );
  } else if (
    secretBytes.length === 32
  ) {
    seed =
      secretBytes;
  } else {
    throw new Error(
      `Private key must decode to 32 or 64 bytes, got ${secretBytes.length}`
    );
  }

  // PKCS#8 wrapper for Ed25519.
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
    prefix,
    0
  );

  pkcs8.set(
    seed,
    prefix.length
  );

  return await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    {
      name: "Ed25519"
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

  if (!response.ok) {
    throw new Error(
      `Helius RPC HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (data.error) {
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
// SPL TOKEN BALANCE
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
    const info =
      account?.account
        ?.data
        ?.parsed
        ?.info;

    const tokenAmount =
      info?.tokenAmount;

    if (
      tokenAmount
    ) {
      amount += Number(
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
    await getPositions(env);

  const filtered =
    positions.filter(
      position =>
        position.mint !== mint
    );

  await savePositions(
    env,
    filtered
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

  const maxTradeUsd =
    walletValueUsd >=
    BALANCE_THRESHOLD_USD
      ? LARGE_TRADE_CAP_USD
      : SMALL_TRADE_CAP_USD;

  const positions =
    await getPositions(env);

  return json({
    ok: true,
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
        walletValueUsd,
        4
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

    profit_target_percent:
      PROFIT_TARGET * 100,

    stop_loss_percent:
      STOP_LOSS * 100,

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
    binary += String.fromCharCode(
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

  const bytes = [0];

  for (
    const char of input
  ) {
    const value =
      BASE58_ALPHABET.indexOf(
        char
      );

    if (value < 0) {
      throw new Error(
        "Invalid base58 private key"
      );
    }

    let carry = value;

    for (
      let j = 0;
      j < bytes.length;
      j++
    ) {
      const current =
        bytes[j] * 58 +
        carry;

      bytes[j] =
        current & 0xff;

      carry =
        current >> 8;
    }

    while (carry > 0) {
      bytes.push(
        carry & 0xff
      );

      carry >>= 8;
    }
  }

  for (
    let i = 0;
    i < input.length &&
    input[i] === "1";
    i++
  ) {
    bytes.push(0);
  }

  bytes.reverse();

  return new Uint8Array(
    bytes
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
      value * factor
    ) / factor
  );
}


function errorMessage(
  error
) {
  if (
    error instanceof Error
  ) {
    return error.message;
  }

  return String(error);
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
