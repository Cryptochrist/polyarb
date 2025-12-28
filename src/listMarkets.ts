import { fetchAllCryptoUpDownMarkets, createMarketPairs, type BTCMarketInterval } from './gammaApi.js';
import { fetchMultipleOrderBooks, getBestAsk, getBestBid } from './clobApi.js';
import { getMarketOpenPriceFromPolymarket } from './polymarketPriceApi.js';
import type { MarketPair, GammaMarket } from './types.js';

interface MarketDisplay {
  asset: string;
  interval: BTCMarketInterval;
  slug: string;
  endDate: Date;
  minutesUntilResolution: number;
  referencePrice: number | null;
  upBestAsk: number | null;
  upBestBid: number | null;
  downBestAsk: number | null;
  downBestBid: number | null;
}

/**
 * Calculate the candle start time from the end time and interval
 */
function calculateCandleStartTime(endTime: Date, interval: BTCMarketInterval): Date {
  const startTime = new Date(endTime);

  switch (interval) {
    case '15m':
      startTime.setTime(startTime.getTime() - 15 * 60 * 1000);
      break;
    case '30m':
      startTime.setTime(startTime.getTime() - 30 * 60 * 1000);
      break;
    case '1h':
      startTime.setTime(startTime.getTime() - 60 * 60 * 1000);
      break;
    case '4h':
      startTime.setTime(startTime.getTime() - 4 * 60 * 60 * 1000);
      break;
    case '1d':
      startTime.setTime(startTime.getTime() - 24 * 60 * 60 * 1000);
      break;
  }

  return startTime;
}

/**
 * Parse market info to extract asset and interval
 */
function parseMarketInfo(pair: MarketPair): { asset: string; interval: BTCMarketInterval } | null {
  const slug = pair.market.slug;
  const market = pair.market as GammaMarket & { interval?: BTCMarketInterval };

  // Check if market has interval metadata from series endpoint
  if (market.interval) {
    let asset: string;
    if (slug.toLowerCase().includes('bitcoin') || slug.toLowerCase().startsWith('btc')) {
      asset = 'btc';
    } else if (slug.toLowerCase().includes('ethereum') || slug.toLowerCase().startsWith('eth')) {
      asset = 'eth';
    } else if (slug.toLowerCase().includes('solana') || slug.toLowerCase().startsWith('sol')) {
      asset = 'sol';
    } else if (slug.toLowerCase().includes('xrp')) {
      asset = 'xrp';
    } else {
      return null;
    }
    return { asset, interval: market.interval };
  }

  // Try 15m slug pattern: {asset}-updown-{interval}-{timestamp}
  const match15m = slug.match(/^([a-z]+)-updown-(15m|30m|1h|4h|1d)-(\d+)$/i);
  if (match15m) {
    return {
      asset: match15m[1]!.toLowerCase(),
      interval: match15m[2] as BTCMarketInterval,
    };
  }

  // Try descriptive slug for 1h/4h/1d markets
  const matchDescriptive = slug.match(/^(bitcoin|ethereum|solana|xrp|btc|eth|sol)-up-or-down-(.+)$/i);
  if (matchDescriptive) {
    let asset: string;
    const assetPart = matchDescriptive[1]!.toLowerCase();
    if (assetPart === 'bitcoin' || assetPart === 'btc') {
      asset = 'btc';
    } else if (assetPart === 'ethereum' || assetPart === 'eth') {
      asset = 'eth';
    } else if (assetPart === 'solana' || assetPart === 'sol') {
      asset = 'sol';
    } else if (assetPart === 'xrp') {
      asset = 'xrp';
    } else {
      return null;
    }

    // Determine interval from slug pattern
    let interval: BTCMarketInterval;
    if (slug.includes('-4h-')) {
      interval = '4h';
    } else if (slug.includes('-daily-')) {
      interval = '1d';
    } else {
      interval = '1h';
    }

    return { asset, interval };
  }

  return null;
}

/**
 * List all active up/down markets with their reference prices and bid/ask data
 */
export async function listAllMarkets(intervals: BTCMarketInterval[]): Promise<void> {
  console.log(`\nFetching active crypto up/down markets (${intervals.join(', ')})...\n`);

  // Fetch all markets
  const markets = await fetchAllCryptoUpDownMarkets(intervals);
  const pairs = createMarketPairs(markets);

  console.log(`Found ${pairs.length} markets\n`);

  // Collect all token IDs
  const tokenIds: string[] = [];
  for (const pair of pairs) {
    tokenIds.push(pair.yesTokenId, pair.noTokenId);
  }

  // Fetch orderbooks
  console.log(`Fetching orderbooks for ${tokenIds.length} tokens...`);
  const orderBooks = await fetchMultipleOrderBooks(tokenIds, 10);
  console.log(`Loaded ${orderBooks.size} orderbooks\n`);

  // Build display data
  const displayData: MarketDisplay[] = [];

  for (const pair of pairs) {
    const info = parseMarketInfo(pair);
    if (!info) continue;

    const endDate = new Date(pair.market.endDate);
    const minutesUntilResolution = (endDate.getTime() - Date.now()) / 60000;

    // Get orderbook data
    const upBook = orderBooks.get(pair.yesTokenId);
    const downBook = orderBooks.get(pair.noTokenId);

    const upAsk = upBook ? getBestAsk(upBook) : null;
    const upBid = upBook ? getBestBid(upBook) : null;
    const downAsk = downBook ? getBestAsk(downBook) : null;
    const downBid = downBook ? getBestBid(downBook) : null;

    displayData.push({
      asset: info.asset,
      interval: info.interval,
      slug: pair.market.slug,
      endDate,
      minutesUntilResolution,
      referencePrice: null, // Will fetch below
      upBestAsk: upAsk?.price ?? null,
      upBestBid: upBid?.price ?? null,
      downBestAsk: downAsk?.price ?? null,
      downBestBid: downBid?.price ?? null,
    });
  }

  // Fetch reference prices
  console.log('Fetching reference prices from Polymarket API...\n');

  for (const data of displayData) {
    try {
      const price = await getMarketOpenPriceFromPolymarket(
        data.asset,
        data.interval,
        data.endDate
      );
      data.referencePrice = price;
    } catch (err) {
      // Price fetch failed, leave as null
    }
  }

  // Sort by asset, then by interval, then by resolution time
  const intervalOrder: Record<BTCMarketInterval, number> = {
    '15m': 1,
    '30m': 2,
    '1h': 3,
    '4h': 4,
    '1d': 5,
  };

  displayData.sort((a, b) => {
    if (a.asset !== b.asset) return a.asset.localeCompare(b.asset);
    if (a.interval !== b.interval) return intervalOrder[a.interval] - intervalOrder[b.interval];
    return a.minutesUntilResolution - b.minutesUntilResolution;
  });

  // Print results
  console.log('=' .repeat(120));
  console.log('ACTIVE CRYPTO UP/DOWN MARKETS');
  console.log('=' .repeat(120));
  console.log('');

  const formatPrice = (p: number | null): string => {
    if (p === null) return '   -   ';
    return `$${p.toFixed(3)}`;
  };

  const formatRef = (p: number | null): string => {
    if (p === null) return '      -      ';
    return `$${p.toLocaleString()}`;
  };

  // Header
  console.log(
    'Asset'.padEnd(6) +
    'Int'.padEnd(5) +
    'Resolves'.padEnd(12) +
    'Reference Price'.padEnd(16) +
    '| UP Ask '.padEnd(10) +
    'UP Bid '.padEnd(9) +
    '| DOWN Ask'.padEnd(11) +
    'DOWN Bid'.padEnd(10) +
    '| Sum Asks'.padEnd(11) +
    'Slug'
  );
  console.log('-'.repeat(120));

  let currentAsset = '';

  for (const data of displayData) {
    // Add separator between assets
    if (data.asset !== currentAsset) {
      if (currentAsset !== '') {
        console.log('');
      }
      currentAsset = data.asset;
    }

    const minsLeft = data.minutesUntilResolution;
    const timeStr = minsLeft < 60
      ? `${minsLeft.toFixed(0)}m`
      : `${(minsLeft / 60).toFixed(1)}h`;

    const sumAsks = (data.upBestAsk ?? 0) + (data.downBestAsk ?? 0);
    const sumAsksStr = sumAsks > 0 ? `$${sumAsks.toFixed(3)}` : '   -   ';

    // Highlight profitable opportunities (sum < $1)
    const profitMarker = sumAsks > 0 && sumAsks < 1.0 ? ' *** PROFIT ***' : '';

    console.log(
      data.asset.toUpperCase().padEnd(6) +
      data.interval.padEnd(5) +
      timeStr.padStart(8).padEnd(12) +
      formatRef(data.referencePrice).padEnd(16) +
      '| ' + formatPrice(data.upBestAsk).padEnd(8) +
      formatPrice(data.upBestBid).padEnd(9) +
      '| ' + formatPrice(data.downBestAsk).padEnd(9) +
      formatPrice(data.downBestBid).padEnd(10) +
      '| ' + sumAsksStr.padEnd(9) +
      data.slug.slice(0, 40) +
      profitMarker
    );
  }

  console.log('');
  console.log('=' .repeat(120));
  console.log(`Total: ${displayData.length} markets`);

  // Count markets with/without data
  const withRef = displayData.filter(d => d.referencePrice !== null).length;
  const withAsks = displayData.filter(d => d.upBestAsk !== null && d.downBestAsk !== null).length;

  console.log(`Reference prices: ${withRef}/${displayData.length}`);
  console.log(`Both asks available: ${withAsks}/${displayData.length}`);
  console.log('');

  // Show overlapping pairs (different intervals resolving at same time)
  console.log('=' .repeat(120));
  console.log('OVERLAPPING PAIRS (same asset, same resolution time, different intervals)');
  console.log('=' .repeat(120));
  console.log('');

  // Group by asset and resolution time
  const byResolution = new Map<string, MarketDisplay[]>();
  for (const data of displayData) {
    // Round to 5 minute buckets
    const roundedTime = Math.round(data.endDate.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000);
    const key = `${data.asset}-${roundedTime}`;
    if (!byResolution.has(key)) {
      byResolution.set(key, []);
    }
    byResolution.get(key)!.push(data);
  }

  let pairCount = 0;
  for (const [key, group] of byResolution) {
    if (group.length < 2) continue;

    // Multiple intervals resolving together
    const asset = group[0]!.asset.toUpperCase();
    const time = group[0]!.endDate.toISOString();
    const minsLeft = group[0]!.minutesUntilResolution;
    const timeStr = minsLeft < 60 ? `${minsLeft.toFixed(0)}m` : `${(minsLeft / 60).toFixed(1)}h`;

    console.log(`${asset} resolving in ${timeStr} (${time}):`);

    for (const data of group) {
      const refStr = data.referencePrice ? `$${data.referencePrice.toLocaleString()}` : 'no ref';
      const upStr = data.upBestAsk ? `$${data.upBestAsk.toFixed(3)}` : '-';
      const downStr = data.downBestAsk ? `$${data.downBestAsk.toFixed(3)}` : '-';
      console.log(`  ${data.interval.padEnd(4)} | Ref: ${refStr.padEnd(14)} | UP: ${upStr.padEnd(7)} | DOWN: ${downStr.padEnd(7)}`);
    }

    // Check for cross-market opportunity
    if (group.length >= 2) {
      // Sort by interval (longer first)
      const sorted = [...group].sort((a, b) => intervalOrder[b.interval] - intervalOrder[a.interval]);
      const long = sorted[0]!;
      const short = sorted[1]!;

      if (long.referencePrice && short.referencePrice && long.referencePrice !== short.referencePrice) {
        const profitZoneLow = Math.min(long.referencePrice, short.referencePrice);
        const profitZoneHigh = Math.max(long.referencePrice, short.referencePrice);
        const zoneWidth = profitZoneHigh - profitZoneLow;
        const zonePercent = (zoneWidth / ((profitZoneLow + profitZoneHigh) / 2)) * 100;

        // Determine strategy
        let entryCost: number | null = null;
        let strategy: string;
        if (long.referencePrice > short.referencePrice) {
          // Buy long-DOWN + short-UP
          strategy = `${long.interval} DOWN + ${short.interval} UP`;
          if (long.downBestAsk && short.upBestAsk) {
            entryCost = long.downBestAsk + short.upBestAsk;
          }
        } else {
          // Buy long-UP + short-DOWN
          strategy = `${long.interval} UP + ${short.interval} DOWN`;
          if (long.upBestAsk && short.downBestAsk) {
            entryCost = long.upBestAsk + short.downBestAsk;
          }
        }

        console.log(`  --> Profit Zone: $${profitZoneLow.toLocaleString()} - $${profitZoneHigh.toLocaleString()} (${zonePercent.toFixed(2)}%)`);
        console.log(`  --> Strategy: ${strategy}`);
        if (entryCost) {
          const profit = 2.0 - entryCost;
          console.log(`  --> Entry: $${entryCost.toFixed(3)} | Profit: $${profit.toFixed(3)} ${profit > 0 ? '*** PROFITABLE ***' : ''}`);
        } else {
          console.log(`  --> Entry: missing ask prices`);
        }
      } else if (long.referencePrice && short.referencePrice && long.referencePrice === short.referencePrice) {
        console.log(`  --> Same ref price ($${long.referencePrice.toLocaleString()}) - no profit zone`);
      } else {
        console.log(`  --> Missing reference prices - cannot calculate opportunity`);
      }
    }

    console.log('');
    pairCount++;
  }

  if (pairCount === 0) {
    console.log('No overlapping pairs found.');
    console.log('');
  }

  console.log(`Found ${pairCount} overlapping pair groups`);
}
