import type { ArbitrageOpportunity } from './types.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  ARB = 4,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

function colorize(text: string, color: string): string {
  const colors: Record<string, string> = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    brightGreen: '\x1b[92m',
    brightYellow: '\x1b[93m',
  };
  return `${colors[color] ?? ''}${text}${colors['reset']}`;
}

export function debug(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.DEBUG) {
    console.log(`${colorize('[DEBUG]', 'cyan')} ${timestamp()} ${msg}`, ...args);
  }
}

export function info(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.INFO) {
    console.log(`${colorize('[INFO]', 'blue')} ${timestamp()} ${msg}`, ...args);
  }
}

export function warn(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.WARN) {
    console.log(`${colorize('[WARN]', 'yellow')} ${timestamp()} ${msg}`, ...args);
  }
}

export function error(msg: string, ...args: unknown[]): void {
  if (currentLevel <= LogLevel.ERROR) {
    console.error(`${colorize('[ERROR]', 'red')} ${timestamp()} ${msg}`, ...args);
  }
}

export function logArbitrage(opp: ArbitrageOpportunity): void {
  const profitStr = (opp.profit * 100).toFixed(2);
  const percentStr = (opp.profitPercent * 100).toFixed(2);

  console.log('\n' + colorize('═'.repeat(60), 'brightGreen'));
  console.log(colorize('  ARBITRAGE OPPORTUNITY FOUND!', 'brightGreen'));
  console.log(colorize('═'.repeat(60), 'brightGreen'));
  console.log(`  ${colorize('Market:', 'white')} ${opp.market.question}`);
  console.log(`  ${colorize('YES Ask:', 'cyan')} $${opp.yesAskPrice.toFixed(4)} (${opp.yesAskSize.toFixed(2)} shares)`);
  console.log(`  ${colorize('NO Ask:', 'cyan')} $${opp.noAskPrice.toFixed(4)} (${opp.noAskSize.toFixed(2)} shares)`);
  console.log(`  ${colorize('Total Cost:', 'yellow')} $${opp.totalCost.toFixed(4)}`);
  console.log(`  ${colorize('Profit/Share:', 'brightGreen')} ${profitStr} cents (${percentStr}%)`);
  console.log(`  ${colorize('Max Shares:', 'white')} ${opp.maxShares.toFixed(2)}`);
  console.log(`  ${colorize('Max Profit:', 'brightGreen')} $${(opp.profit * opp.maxShares).toFixed(4)}`);
  console.log(`  ${colorize('Slug:', 'white')} https://polymarket.com/event/${opp.market.slug}`);
  console.log(colorize('═'.repeat(60), 'brightGreen') + '\n');
}

export function logStats(
  marketsScanned: number,
  opportunitiesFound: number,
  wsConnected: boolean,
  uptime: number
): void {
  const uptimeMin = Math.floor(uptime / 60000);
  const uptimeSec = Math.floor((uptime % 60000) / 1000);

  console.log(
    `${colorize('[STATS]', 'magenta')} ${timestamp()} ` +
    `Markets: ${marketsScanned} | ` +
    `Opportunities: ${opportunitiesFound} | ` +
    `WS: ${wsConnected ? colorize('Connected', 'green') : colorize('Disconnected', 'red')} | ` +
    `Uptime: ${uptimeMin}m ${uptimeSec}s`
  );
}
