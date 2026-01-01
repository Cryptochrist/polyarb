import dotenv from 'dotenv';
import { PolyArbScanner, type MarketMode } from './scanner.js';
import { setLogLevel, LogLevel, info, error, warn } from './logger.js';
import { initTelegram } from './telegram.js';
import type { ScannerConfig } from './types.js';
import type { ExecutorConfig } from './executor.js';
import type { BTCMarketInterval } from './gammaApi.js';
import { listAllMarkets } from './listMarkets.js';

// Load environment variables
dotenv.config();

interface ParsedArgs {
  scannerConfig: Partial<ScannerConfig>;
  executorConfig?: ExecutorConfig;
  debug: boolean;
  execute: boolean;
  dryRun: boolean;
  mode: MarketMode;
  maxHours?: number;
  intervals?: BTCMarketInterval[];
  listOnly: boolean;  // Just list markets and exit
}

// Parse command line arguments
function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const result: ParsedArgs = {
    scannerConfig: {},
    debug: false,
    execute: false,
    dryRun: true,
    mode: 'all',
    listOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--min-profit':
        if (nextArg) {
          result.scannerConfig.minProfit = parseFloat(nextArg);
          i++;
        }
        break;
      case '--min-liquidity':
        if (nextArg) {
          result.scannerConfig.minLiquidity = parseFloat(nextArg);
          i++;
        }
        break;
      case '--scan-interval':
        if (nextArg) {
          result.scannerConfig.scanIntervalMs = parseInt(nextArg, 10);
          i++;
        }
        break;
      case '--debug':
        result.debug = true;
        break;
      case '--execute':
        result.execute = true;
        break;
      case '--live':
        result.dryRun = false;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--crypto':
        result.mode = 'crypto';
        break;
      case '--short':
        result.mode = 'short';
        break;
      case '--max-hours':
        if (nextArg) {
          result.maxHours = parseInt(nextArg, 10);
          i++;
        }
        break;
      case '--updown':
        result.mode = 'updown';
        break;
      case '--intervals':
        if (nextArg) {
          // Parse comma-separated intervals like "15m,30m,1h"
          result.intervals = nextArg.split(',').map(s => s.trim()) as BTCMarketInterval[];
          i++;
        }
        break;
      case '--list':
        result.listOnly = true;
        result.mode = 'updown';  // List mode uses updown markets
        break;
    }
  }

  // Build executor config if execution is enabled
  if (result.execute) {
    const privateKey = process.env['PRIVATE_KEY'];
    const funderAddress = process.env['FUNDER_ADDRESS'] || '';
    const signatureType = parseInt(process.env['SIGNATURE_TYPE'] || '0', 10) as 0 | 1 | 2;
    const maxPositionSize = parseFloat(process.env['MAX_POSITION_SIZE'] || '100');

    // API credentials (faster startup if provided)
    const apiKey = process.env['POLY_API_KEY'];
    const apiSecret = process.env['POLY_API_SECRET'];
    const passphrase = process.env['POLY_PASSPHRASE'];

    if (!privateKey && !result.dryRun) {
      console.error('ERROR: PRIVATE_KEY environment variable required for live execution');
      console.error('Set up your .env file (see .env.example) or use --execute without --live for dry run');
      process.exit(1);
    }

    result.executorConfig = {
      privateKey: privateKey || '',
      funderAddress,
      signatureType,
      maxPositionSize,
      dryRun: result.dryRun,
      apiKey,
      apiSecret,
      passphrase,
    };
  }

  return result;
}

function printHelp(): void {
  console.log(`
PolyArb Scanner - Polymarket Arbitrage Detection & Execution

Usage: npm start -- [options]

Scanner Options:
  --min-profit <amount>     Minimum profit per share in USD (default: 0.005)
  --min-liquidity <amount>  Minimum market liquidity in USD (default: 1000)
  --scan-interval <ms>      REST polling interval in ms (default: 5000)
  --debug                   Enable debug logging
  --help                    Show this help message

Market Filtering:
  --crypto                  Focus only on Crypto category markets (faster moves)
  --short                   Focus on short-duration markets (resolving soon)
  --max-hours <hours>       Max hours until resolution for --short mode (default: 24)
  --updown                  BTC/ETH/XRP/SOL up/down markets with cross-market arb
  --intervals <list>        Intervals for --updown mode (default: 15m,1h,4h,1d)
                            Example: --intervals 15m,1h
  --list                    List all active up/down markets with prices and exit

Execution Options:
  --execute                 Enable trade execution (dry run by default)
  --live                    Execute REAL trades (requires .env configuration)

Environment Variables (for execution):
  PRIVATE_KEY               Your wallet private key (required for --live)
  FUNDER_ADDRESS            Your Polymarket profile address
  SIGNATURE_TYPE            0=EOA, 1=Magic/Email, 2=Browser wallet (default: 1)
  MAX_POSITION_SIZE         Max USD per trade (default: 100)

Examples:
  npm start                              # Scan all markets
  npm start -- --crypto                  # Scan only crypto markets
  npm start -- --short --max-hours 4     # Markets resolving in 4 hours
  npm start -- --updown                  # All crypto up/down + cross-market arb
  npm start -- --updown --intervals 15m,1h # Only 15m and 1h markets
  npm start -- --execute                 # Scan + dry run execution
  npm start -- --execute --live          # Scan + LIVE execution
  npm start -- --updown --execute        # Up/down + cross-market + execution

Setup for Live Execution:
  1. Copy .env.example to .env
  2. Fill in your PRIVATE_KEY and FUNDER_ADDRESS
  3. Run with --execute --live

Arbitrage Types:
  Single-Market:
    BUY_BOTH:  Buy YES + NO when asks sum < $1.00 (guaranteed profit)
    SELL_BOTH: Mint for $1.00 and sell when bids sum > $1.00

  Cross-Market (--updown mode):
    When 1h and 15m markets resolve at same time with different ref prices:
    - 1h started at $100,000 BTC, 15m started at $99,000 BTC
    - Buy 1h-DOWN + 15m-UP: both pay $1 if price ends between refs!
    - "Profit zone" = range between the two reference prices
`);
}

async function main(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                     PolyArb Scanner                           ║
║         Polymarket Arbitrage Detection & Execution            ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const args = parseArgs();

  if (args.debug) {
    setLogLevel(LogLevel.DEBUG);
    info('Debug logging enabled');
  }

  // Handle --list mode: just show markets and exit
  if (args.listOnly) {
    const intervals = args.intervals ?? ['15m', '1h', '4h', '1d'];
    await listAllMarkets(intervals);
    return;
  }

  if (args.execute && !args.dryRun) {
    warn('LIVE EXECUTION ENABLED - Real trades will be placed!');
  } else if (args.execute) {
    info('Dry run mode - trades will be simulated');
  }

  // Initialize Telegram notifications
  initTelegram(
    process.env['TELEGRAM_BOT_TOKEN'],
    process.env['TELEGRAM_CHAT_ID']
  );

  // Log market mode
  if (args.mode === 'crypto') {
    info('Mode: CRYPTO - focusing on cryptocurrency markets');
  } else if (args.mode === 'short') {
    info(`Mode: SHORT - focusing on markets resolving within ${args.maxHours ?? 24} hours`);
  } else if (args.mode === 'updown') {
    const intervals = args.intervals ?? ['15m', '1h', '4h', '1d'];
    info(`Mode: UPDOWN - focusing on crypto up/down markets (${intervals.join(', ')})`);
  }

  const scanner = new PolyArbScanner({
    config: args.scannerConfig,
    executorConfig: args.executorConfig,
    mode: args.mode,
    maxHours: args.maxHours,
    intervals: args.intervals,
  });

  // Graceful shutdown handlers
  const shutdown = (): void => {
    info('Received shutdown signal...');
    scanner.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await scanner.start();

    // Keep the process alive
    process.stdin.resume();
  } catch (err) {
    error('Fatal error', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
