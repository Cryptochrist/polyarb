import dotenv from 'dotenv';
import { PolyArbScanner, type MarketMode } from './scanner.js';
import { setLogLevel, LogLevel, info, error, warn } from './logger.js';
import type { ScannerConfig } from './types.js';
import type { ExecutorConfig } from './executor.js';

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
    }
  }

  // Build executor config if execution is enabled
  if (result.execute) {
    const privateKey = process.env['PRIVATE_KEY'];
    const funderAddress = process.env['FUNDER_ADDRESS'] || '';
    const signatureType = parseInt(process.env['SIGNATURE_TYPE'] || '1', 10) as 0 | 1 | 2;
    const maxPositionSize = parseFloat(process.env['MAX_POSITION_SIZE'] || '100');

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
  npm start -- --execute                 # Scan + dry run execution
  npm start -- --execute --live          # Scan + LIVE execution
  npm start -- --crypto --execute        # Crypto markets + execution

Setup for Live Execution:
  1. Copy .env.example to .env
  2. Fill in your PRIVATE_KEY and FUNDER_ADDRESS
  3. Run with --execute --live

Arbitrage Types:
  BUY_BOTH:  Buy YES + NO when asks sum < $1.00 (guaranteed profit)
  SELL_BOTH: Mint for $1.00 and sell when bids sum > $1.00

  Example: YES ask $0.48 + NO ask $0.51 = $0.99 -> $0.01 profit per share
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

  if (args.execute && !args.dryRun) {
    warn('LIVE EXECUTION ENABLED - Real trades will be placed!');
  } else if (args.execute) {
    info('Dry run mode - trades will be simulated');
  }

  // Log market mode
  if (args.mode === 'crypto') {
    info('Mode: CRYPTO - focusing on cryptocurrency markets');
  } else if (args.mode === 'short') {
    info(`Mode: SHORT - focusing on markets resolving within ${args.maxHours ?? 24} hours`);
  }

  const scanner = new PolyArbScanner({
    config: args.scannerConfig,
    executorConfig: args.executorConfig,
    mode: args.mode,
    maxHours: args.maxHours,
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
