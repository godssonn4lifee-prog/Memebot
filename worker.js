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
