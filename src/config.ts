import type { ScannerConfig } from './types.js';

export const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
export const CLOB_API_BASE = 'https://clob.polymarket.com';
export const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export const DEFAULT_CONFIG: ScannerConfig = {
  minProfit: 0.005,            // 0.5 cent minimum profit per share
  minLiquidity: 1000,          // $1000 minimum liquidity
  scanIntervalMs: 5000,        // 5 second REST refresh for market discovery
  maxConcurrentRequests: 10,   // Parallel orderbook requests
};

export const RATE_LIMIT = {
  requestsPerSecond: 10,
  burstLimit: 20,
};
