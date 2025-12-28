import axios from 'axios';
import type { ArbitrageOpportunity } from './types.js';
import type { ExtendedOpportunity, NearMissOpportunity } from './arbDetector.js';
import type { CrossMarketOpportunity } from './crossMarketDetector.js';
import { info, error, warn } from './logger.js';

/**
 * Market data for Telegram summary
 */
export interface MarketSummaryData {
  asset: string;
  interval: string;
  minutesUntilResolution: number;
  referencePrice: number | null;
  upBestAsk: number | null;
  upBestBid: number | null;
  downBestAsk: number | null;
  downBestBid: number | null;
}

interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

let config: TelegramConfig | null = null;

export function initTelegram(botToken?: string, chatId?: string): boolean {
  if (!botToken || !chatId) {
    warn('Telegram notifications disabled - TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return false;
  }

  config = {
    botToken,
    chatId,
    enabled: true,
  };

  info('Telegram notifications enabled');
  return true;
}

export async function sendTelegramMessage(message: string): Promise<boolean> {
  if (!config?.enabled) return false;

  try {
    await axios.post(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        chat_id: config.chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 10000 }
    );
    return true;
  } catch (err) {
    error('Failed to send Telegram message', err);
    return false;
  }
}

export async function notifyOpportunity(opp: ExtendedOpportunity | ArbitrageOpportunity): Promise<void> {
  if (!config?.enabled) return;

  const type = 'type' in opp ? opp.type : 'BUY_BOTH';
  const maxProfit = opp.profit * opp.maxShares;

  const message = `
🚨 <b>ARBITRAGE OPPORTUNITY</b>

<b>Type:</b> ${type}
<b>Market:</b> ${opp.market.question.slice(0, 100)}${opp.market.question.length > 100 ? '...' : ''}

<b>YES Ask:</b> $${opp.yesAskPrice.toFixed(4)}
<b>NO Ask:</b> $${opp.noAskPrice.toFixed(4)}
<b>Total Cost:</b> $${opp.totalCost.toFixed(4)}

<b>Profit/Share:</b> $${opp.profit.toFixed(4)} (${(opp.profitPercent * 100).toFixed(2)}%)
<b>Max Shares:</b> ${opp.maxShares.toFixed(2)}
<b>Max Profit:</b> $${maxProfit.toFixed(2)}

<b>Liquidity:</b> $${opp.market.liquidityNum.toLocaleString()}
<b>Time:</b> ${new Date().toISOString()}

@cryptochrist
`.trim();

  await sendTelegramMessage(message);
}

export async function notifyStartup(marketsCount: number, mode: string): Promise<void> {
  if (!config?.enabled) return;

  const message = `
✅ <b>PolyArb Scanner Started</b>

<b>Mode:</b> ${mode}
<b>Markets:</b> ${marketsCount}
<b>Time:</b> ${new Date().toISOString()}
`.trim();

  await sendTelegramMessage(message);
}

export async function notifyError(errorMsg: string): Promise<void> {
  if (!config?.enabled) return;

  const message = `
⚠️ <b>PolyArb Error</b>

${errorMsg}

<b>Time:</b> ${new Date().toISOString()}
`.trim();

  await sendTelegramMessage(message);
}

export function isTelegramEnabled(): boolean {
  return config?.enabled ?? false;
}

export async function notifyNearMiss(nearMiss: NearMissOpportunity, marketsCount: number, uptime: number): Promise<void> {
  if (!config?.enabled) return;

  const uptimeMinutes = Math.floor(uptime / 60000);
  const uptimeHours = Math.floor(uptimeMinutes / 60);
  const uptimeStr = uptimeHours > 0
    ? `${uptimeHours}h ${uptimeMinutes % 60}m`
    : `${uptimeMinutes}m`;

  const gapPercent = (nearMiss.profitGap * 100).toFixed(2);
  const isProfitable = nearMiss.profitGap >= 0;
  const statusEmoji = isProfitable ? '🟢' : '🔴';

  let priceInfo: string;
  if (nearMiss.type === 'BUY_BOTH') {
    priceInfo = `<b>YES Ask:</b> $${nearMiss.yesPrice.toFixed(4)}
<b>NO Ask:</b> $${nearMiss.noPrice.toFixed(4)}
<b>Total Cost:</b> $${nearMiss.totalCost.toFixed(4)}`;
  } else {
    priceInfo = `<b>YES Bid:</b> $${nearMiss.yesPrice.toFixed(4)}
<b>NO Bid:</b> $${nearMiss.noPrice.toFixed(4)}
<b>Total Bids:</b> $${nearMiss.totalBids.toFixed(4)}`;
  }

  const message = `
📊 <b>10-Minute Update</b>

${statusEmoji} <b>Closest to Profitable:</b>
<b>Type:</b> ${nearMiss.type}
<b>Market:</b> ${nearMiss.market.question.slice(0, 100)}${nearMiss.market.question.length > 100 ? '...' : ''}

${priceInfo}

<b>Gap from Profit:</b> ${gapPercent}% ${isProfitable ? '(PROFITABLE!)' : '(needs ' + Math.abs(nearMiss.profitGap * 100).toFixed(2) + '% more)'}
<b>Max Shares:</b> ${nearMiss.maxShares.toFixed(2)}
<b>Liquidity:</b> $${nearMiss.market.liquidityNum.toLocaleString()}

<b>Markets Tracked:</b> ${marketsCount}
<b>Uptime:</b> ${uptimeStr}
<b>Time:</b> ${new Date().toISOString()}
`.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about a cross-market arbitrage opportunity
 * This is when 1h and 15m markets resolve together but have different reference prices
 */
export async function notifyCrossMarketOpportunity(opp: CrossMarketOpportunity): Promise<void> {
  if (!config?.enabled) return;

  const maxProfit = opp.maxProfit * opp.maxShares;
  const isProfitable = opp.maxProfit > 0;
  const statusEmoji = isProfitable ? '🚨' : '📊';

  // Format the strategy for readability
  const strategyStr = opp.strategy === 'LONG_DOWN_SHORT_UP'
    ? `${opp.longInterval} DOWN + ${opp.shortInterval} UP`
    : `${opp.longInterval} UP + ${opp.shortInterval} DOWN`;

  // Tag user if profitable
  const tagLine = isProfitable ? '\n\n@cryptochrist' : '';

  const message = `
${statusEmoji} <b>CROSS-MARKET ${isProfitable ? 'ARBITRAGE' : 'OPPORTUNITY'}</b>

<b>Strategy:</b> ${strategyStr}
<b>Asset:</b> ${opp.longMarket.slug.split('-')[0]!.toUpperCase()}

<b>${opp.longInterval} Market:</b>
  Ref: $${opp.longRefPrice.toLocaleString()}
  UP Ask: $${opp.longUpAsk.toFixed(4)} | DOWN Ask: $${opp.longDownAsk.toFixed(4)}

<b>${opp.shortInterval} Market:</b>
  Ref: $${opp.shortRefPrice.toLocaleString()}
  UP Ask: $${opp.shortUpAsk.toFixed(4)} | DOWN Ask: $${opp.shortDownAsk.toFixed(4)}

<b>Profit Zone:</b> $${opp.profitZoneLow.toLocaleString()} - $${opp.profitZoneHigh.toLocaleString()}
<b>Zone Width:</b> $${opp.profitZoneWidth.toFixed(2)} (${opp.profitZonePercent.toFixed(3)}%)

<b>Entry Cost:</b> $${opp.entryCost.toFixed(4)}
<b>Profit/Share:</b> $${opp.maxProfit.toFixed(4)} ${isProfitable ? '✅' : '❌'}
<b>Max Shares:</b> ${opp.maxShares.toFixed(2)}
<b>Max Profit:</b> $${maxProfit.toFixed(2)}

<b>Resolves in:</b> ${opp.minutesUntilResolution.toFixed(1)} minutes
<b>Time:</b> ${new Date().toISOString()}${tagLine}
`.trim();

  await sendTelegramMessage(message);
}

/**
 * Send 5-minute update with all overlapping cross-market opportunities
 */
export async function notifyCrossMarketNearMiss(
  opp: CrossMarketOpportunity | null,
  singleMarketNearMiss: NearMissOpportunity | null,
  marketsCount: number,
  crossPairsCount: number,
  uptime: number,
  allCrossOpportunities: CrossMarketOpportunity[] = [],
  diagnosticInfo?: string
): Promise<void> {
  if (!config?.enabled) return;

  const uptimeMinutes = Math.floor(uptime / 60000);
  const uptimeHours = Math.floor(uptimeMinutes / 60);
  const uptimeStr = uptimeHours > 0
    ? `${uptimeHours}h ${uptimeMinutes % 60}m`
    : `${uptimeMinutes}m`;

  let crossMarketSection = '';

  // Check if any opportunity is profitable
  const hasProfitable = allCrossOpportunities.some(o => o.maxProfit > 0);

  // Show all overlapping pairs if we have them
  if (allCrossOpportunities.length > 0) {
    // Sort by profit (best first)
    const sorted = [...allCrossOpportunities].sort((a, b) => b.maxProfit - a.maxProfit);

    crossMarketSection = `\n<b>📈 Overlapping Market Pairs:</b>\n`;

    for (const crossOpp of sorted.slice(0, 5)) { // Show top 5
      const isProfitable = crossOpp.maxProfit > 0;
      const identicalRefs = crossOpp.longRefPrice === crossOpp.shortRefPrice;
      const statusEmoji = isProfitable ? '🟢' : (identicalRefs ? '⚪' : '🔴');
      const asset = crossOpp.longMarket.slug.split('-')[0]!.toUpperCase();
      const strategyStr = crossOpp.strategy === 'LONG_DOWN_SHORT_UP'
        ? `${crossOpp.longInterval}⬇ + ${crossOpp.shortInterval}⬆`
        : `${crossOpp.longInterval}⬆ + ${crossOpp.shortInterval}⬇`;

      // Show different info based on whether refs are identical
      if (identicalRefs) {
        crossMarketSection += `
${statusEmoji} <b>${asset}</b> ${crossOpp.longInterval} + ${crossOpp.shortInterval}
   Ref: $${crossOpp.longRefPrice.toLocaleString()} (identical)
   ${crossOpp.longInterval} UP: $${crossOpp.longUpAsk.toFixed(3)} | DOWN: $${crossOpp.longDownAsk.toFixed(3)}
   ${crossOpp.shortInterval} UP: $${crossOpp.shortUpAsk.toFixed(3)} | DOWN: $${crossOpp.shortDownAsk.toFixed(3)}
   ⏰ ${crossOpp.minutesUntilResolution.toFixed(0)}min (no zone yet)
`;
      } else {
        crossMarketSection += `
${statusEmoji} <b>${asset}</b> ${strategyStr}
   Refs: $${crossOpp.longRefPrice.toLocaleString()} vs $${crossOpp.shortRefPrice.toLocaleString()}
   Zone: $${crossOpp.profitZoneWidth.toFixed(0)} (${crossOpp.profitZonePercent.toFixed(2)}%)
   Cost: $${crossOpp.entryCost.toFixed(3)} → Profit: $${crossOpp.maxProfit.toFixed(3)}
   ⏰ ${crossOpp.minutesUntilResolution.toFixed(0)}min
`;
      }
    }

    if (allCrossOpportunities.length > 5) {
      crossMarketSection += `\n   <i>...and ${allCrossOpportunities.length - 5} more pairs</i>`;
    }
  } else if (opp) {
    // Fallback to single best opportunity
    const isProfitable = opp.maxProfit > 0;
    const statusEmoji = isProfitable ? '🟢' : '🔴';
    const strategyStr = opp.strategy === 'LONG_DOWN_SHORT_UP'
      ? `${opp.longInterval} DOWN + ${opp.shortInterval} UP`
      : `${opp.longInterval} UP + ${opp.shortInterval} DOWN`;

    crossMarketSection = `
${statusEmoji} <b>Best Cross-Market:</b>
<b>Strategy:</b> ${strategyStr}
<b>Ref Prices:</b> $${opp.longRefPrice.toLocaleString()} vs $${opp.shortRefPrice.toLocaleString()}
<b>Zone Width:</b> $${opp.profitZoneWidth.toFixed(2)} (${opp.profitZonePercent.toFixed(3)}%)
<b>Entry Cost:</b> $${opp.entryCost.toFixed(4)}
<b>Profit/Share:</b> $${opp.maxProfit.toFixed(4)} ${isProfitable ? '(PROFITABLE!)' : `(need ${(-opp.maxProfit).toFixed(4)} more)`}
<b>Resolves in:</b> ${opp.minutesUntilResolution.toFixed(1)} mins`;
  } else if (crossPairsCount > 0) {
    // There are potential pairs but no opportunities were found
    // This could be because:
    // 1. Reference prices are missing (candle hasn't started)
    // 2. Token prices (asks) are missing from orderbooks
    // 3. Both issues
    const now = new Date();
    const mins = now.getUTCMinutes();

    // Check if we're in the overlap window (:45-:59 or :00-:14)
    const inOverlapWindow = mins >= 45 || mins < 15;

    if (inOverlapWindow) {
      // Show diagnostic info if available
      const diagInfo = diagnosticInfo ? `\n<i>${diagnosticInfo}</i>` : '';
      crossMarketSection = `
⏳ <b>Cross-Market:</b> ${crossPairsCount} pairs, missing data
<i>In overlap window (:${String(mins).padStart(2, '0')})</i>${diagInfo}`;
    } else {
      // Not in overlap window, waiting for next one
      const nextCandle = Math.ceil((mins + 1) / 15) * 15;
      const minsUntil = nextCandle === 60 ? (60 - mins) : (nextCandle - mins);
      const nextMark = nextCandle === 60 ? '00' : String(nextCandle).padStart(2, '0');
      crossMarketSection = `
⏳ <b>Cross-Market:</b> Waiting for overlap window
<i>${crossPairsCount} pairs, next 15m candle in ~${minsUntil} min (:${nextMark})</i>`;
    }
  } else {
    crossMarketSection = `
⏳ <b>Cross-Market:</b> No overlapping pairs
<i>1h markets need ≤15 mins remaining to overlap with 15m</i>`;
  }

  let singleMarketSection = '';
  if (singleMarketNearMiss) {
    const gapPercent = (singleMarketNearMiss.profitGap * 100).toFixed(2);
    const isProfitable = singleMarketNearMiss.profitGap >= 0;
    const statusEmoji = isProfitable ? '🟢' : '🔴';

    singleMarketSection = `

${statusEmoji} <b>Single-Market (Best):</b>
<b>Type:</b> ${singleMarketNearMiss.type}
<b>Cost:</b> $${singleMarketNearMiss.totalCost.toFixed(4)}
<b>Gap:</b> ${gapPercent}%`;
  }

  // Tag user if there's a profitable opportunity
  const tagLine = hasProfitable ? '\n\n@cryptochrist' : '';

  const message = `
📊 <b>5-Minute Update</b>
${crossMarketSection}
${singleMarketSection}

<b>Markets:</b> ${marketsCount} | <b>Cross-Pairs:</b> ${crossPairsCount}
<b>Uptime:</b> ${uptimeStr}
<b>Time:</b> ${new Date().toISOString()}${tagLine}
`.trim();

  await sendTelegramMessage(message);
}

/**
 * Send comprehensive market summary organized by coin
 */
export async function notifyMarketSummary(
  markets: MarketSummaryData[],
  uptime: number
): Promise<void> {
  if (!config?.enabled) return;

  const uptimeMinutes = Math.floor(uptime / 60000);
  const uptimeHours = Math.floor(uptimeMinutes / 60);
  const uptimeStr = uptimeHours > 0
    ? `${uptimeHours}h ${uptimeMinutes % 60}m`
    : `${uptimeMinutes}m`;

  // Group markets by asset
  const byAsset = new Map<string, MarketSummaryData[]>();
  for (const m of markets) {
    const asset = m.asset.toUpperCase();
    if (!byAsset.has(asset)) {
      byAsset.set(asset, []);
    }
    byAsset.get(asset)!.push(m);
  }

  // Sort assets: BTC, ETH, SOL, XRP
  const assetOrder = ['BTC', 'ETH', 'SOL', 'XRP'];
  const sortedAssets = [...byAsset.keys()].sort((a, b) => {
    const aIdx = assetOrder.indexOf(a);
    const bIdx = assetOrder.indexOf(b);
    if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  // Interval sort order
  const intervalOrder: Record<string, number> = {
    '15m': 1, '30m': 2, '1h': 3, '4h': 4, '1d': 5,
  };

  // Build message sections for each asset
  let message = `📊 <b>Market Summary</b>\n`;
  message += `<code>Int Time │    Ref Price │  ⬆Ask ⬇Ask  =Sum</code>\n`;

  for (const asset of sortedAssets) {
    let assetMarkets = byAsset.get(asset)!;

    // Filter out 15m markets that haven't started yet (no reference price)
    assetMarkets = assetMarkets.filter(m => {
      if (m.interval === '15m' && m.referencePrice === null) {
        return false; // Skip 15m markets without ref price (not started)
      }
      return true;
    });

    // Sort by interval, then by resolution time
    assetMarkets.sort((a, b) => {
      const intA = intervalOrder[a.interval] ?? 99;
      const intB = intervalOrder[b.interval] ?? 99;
      if (intA !== intB) return intA - intB;
      return a.minutesUntilResolution - b.minutesUntilResolution;
    });

    if (assetMarkets.length === 0) continue; // Skip asset if no markets left

    message += `\n<b>${asset}</b>\n`;

    for (const m of assetMarkets) {
      const timeStr = m.minutesUntilResolution < 60
        ? `${m.minutesUntilResolution.toFixed(0)}m`
        : `${(m.minutesUntilResolution / 60).toFixed(1)}h`;

      // Format reference price - show full number for large values
      let refStr: string;
      if (m.referencePrice === null) {
        refStr = '—';
      } else if (m.referencePrice >= 1000) {
        refStr = `$${m.referencePrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      } else if (m.referencePrice >= 10) {
        refStr = `$${m.referencePrice.toFixed(2)}`;
      } else {
        refStr = `$${m.referencePrice.toFixed(3)}`;
      }

      // Format asks with cents - handle NaN and null
      const upAskVal = m.upBestAsk !== null && !isNaN(m.upBestAsk) ? m.upBestAsk : null;
      const downAskVal = m.downBestAsk !== null && !isNaN(m.downBestAsk) ? m.downBestAsk : null;

      const upAsk = upAskVal !== null ? (upAskVal * 100).toFixed(0) + '¢' : '—';
      const downAsk = downAskVal !== null ? (downAskVal * 100).toFixed(0) + '¢' : '—';

      const hasBothAsks = upAskVal !== null && downAskVal !== null;
      const sumAsks = (upAskVal ?? 0) + (downAskVal ?? 0);
      const sumStr = hasBothAsks ? (sumAsks * 100).toFixed(0) + '¢' : '—';

      // Mark profitable opportunities (sum < 100 cents)
      const profitMark = hasBothAsks && sumAsks < 1.0 ? ' 🚨' : '';

      message += `<code>${m.interval.padEnd(3)}</code> ${timeStr.padStart(4)} │ ${refStr.padStart(10)} │ ⬆${upAsk.padStart(3)} ⬇${downAsk.padStart(3)} =${sumStr.padStart(4)}${profitMark}\n`;
    }
  }

  // Add overlapping pairs section
  message += `\n<b>Cross-Market Pairs:</b>\n`;

  // Group by resolution time (within 5 min buckets)
  const byResolution = new Map<string, MarketSummaryData[]>();
  for (const m of markets) {
    const bucket = Math.round(m.minutesUntilResolution / 5) * 5;
    const key = `${m.asset.toUpperCase()}-${bucket}`;
    if (!byResolution.has(key)) {
      byResolution.set(key, []);
    }
    byResolution.get(key)!.push(m);
  }

  let hasProfitable = false;
  let pairCount = 0;

  for (const [, group] of byResolution) {
    // Need at least 2 different intervals
    const intervals = new Set(group.map(m => m.interval));
    if (intervals.size < 2) continue;

    pairCount++;
    const asset = group[0]!.asset.toUpperCase();
    const minsLeft = group[0]!.minutesUntilResolution;
    const timeStr = minsLeft < 60 ? `${minsLeft.toFixed(0)}m` : `${(minsLeft / 60).toFixed(1)}h`;

    // Sort by interval (longer first)
    const sorted = [...group].sort((a, b) =>
      (intervalOrder[b.interval] ?? 0) - (intervalOrder[a.interval] ?? 0)
    );
    const long = sorted[0]!;
    const short = sorted[1]!;

    const longRef = long.referencePrice;
    const shortRef = short.referencePrice;

    if (longRef && shortRef && longRef !== shortRef) {
      // Calculate opportunity
      const profitZoneLow = Math.min(longRef, shortRef);
      const profitZoneHigh = Math.max(longRef, shortRef);
      const zoneWidth = profitZoneHigh - profitZoneLow;
      const zonePercent = (zoneWidth / ((profitZoneLow + profitZoneHigh) / 2)) * 100;

      let entryCost: number | null = null;
      let strategy: string;
      if (longRef > shortRef) {
        strategy = `${long.interval}⬇+${short.interval}⬆`;
        if (long.downBestAsk && short.upBestAsk) {
          entryCost = long.downBestAsk + short.upBestAsk;
        }
      } else {
        strategy = `${long.interval}⬆+${short.interval}⬇`;
        if (long.upBestAsk && short.downBestAsk) {
          entryCost = long.upBestAsk + short.downBestAsk;
        }
      }

      const profit = entryCost ? 2.0 - entryCost : null;
      const isProfitable = profit !== null && profit > 0;
      if (isProfitable) hasProfitable = true;

      const profitStr = profit !== null
        ? (isProfitable ? `✅+${(profit * 100).toFixed(0)}¢` : `${(profit * 100).toFixed(0)}¢`)
        : '—';

      message += `${asset} ${timeStr}: ${strategy} │ ${zonePercent.toFixed(1)}% │ ${profitStr}\n`;
    } else if (longRef && shortRef) {
      // Same ref price - show the refs
      let refStr: string;
      if (longRef >= 1000) {
        refStr = `$${longRef.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      } else {
        refStr = `$${longRef.toFixed(2)}`;
      }
      message += `${asset} ${timeStr}: ${long.interval}+${short.interval} │ Same ${refStr}\n`;
    } else {
      // Missing refs - show what we have and what's missing
      const missing: string[] = [];
      const have: string[] = [];
      if (longRef) {
        have.push(`${long.interval}=$${longRef >= 1000 ? longRef.toLocaleString(undefined, { maximumFractionDigits: 0 }) : longRef.toFixed(2)}`);
      } else {
        missing.push(long.interval);
      }
      if (shortRef) {
        have.push(`${short.interval}=$${shortRef >= 1000 ? shortRef.toLocaleString(undefined, { maximumFractionDigits: 0 }) : shortRef.toFixed(2)}`);
      } else {
        missing.push(short.interval);
      }
      message += `${asset} ${timeStr}: ${long.interval}+${short.interval} │ Need: ${missing.join(', ')}\n`;
    }
  }

  if (pairCount === 0) {
    message += `No overlapping pairs found\n`;
  }

  // Footer
  message += `\n⏱ ${uptimeStr} │ ${new Date().toISOString().slice(11, 19)}Z`;

  // Tag if profitable
  if (hasProfitable) {
    message += `\n\n@cryptochrist`;
  }

  await sendTelegramMessage(message);
}
