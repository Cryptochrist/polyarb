import axios from 'axios';
import { CLOB_API_BASE } from './config.js';
import type { OrderBook } from './types.js';
import { debug, error } from './logger.js';

const client = axios.create({
  baseURL: CLOB_API_BASE,
  timeout: 10000,
});

export async function fetchOrderBook(tokenId: string): Promise<OrderBook | null> {
  try {
    const response = await client.get<OrderBook>('/book', {
      params: { token_id: tokenId },
    });
    return response.data;
  } catch (err: unknown) {
    // 404s are expected for some tokens - silently skip
    const axiosError = err as { response?: { status?: number } };
    if (axiosError.response?.status !== 404) {
      debug(`Failed to fetch orderbook for ${tokenId.slice(0, 16)}...`);
    }
    return null;
  }
}

export async function fetchMultipleOrderBooks(
  tokenIds: string[],
  maxConcurrent = 10
): Promise<Map<string, OrderBook>> {
  const results = new Map<string, OrderBook>();

  // Process in batches to respect rate limits
  for (let i = 0; i < tokenIds.length; i += maxConcurrent) {
    const batch = tokenIds.slice(i, i + maxConcurrent);
    const promises = batch.map(async (tokenId) => {
      const book = await fetchOrderBook(tokenId);
      if (book) {
        results.set(tokenId, book);
      }
    });

    await Promise.all(promises);

    // Small delay between batches to avoid rate limiting
    if (i + maxConcurrent < tokenIds.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return results;
}

export function getBestAsk(book: OrderBook): { price: number; size: number } | null {
  if (!book.asks || book.asks.length === 0) {
    return null;
  }

  // Asks should be sorted ascending - first ask is best (lowest)
  const sortedAsks = [...book.asks].sort(
    (a, b) => parseFloat(a.price) - parseFloat(b.price)
  );

  const best = sortedAsks[0]!;
  return {
    price: parseFloat(best.price),
    size: parseFloat(best.size),
  };
}

export function getBestBid(book: OrderBook): { price: number; size: number } | null {
  if (!book.bids || book.bids.length === 0) {
    return null;
  }

  // Bids should be sorted descending - first bid is best (highest)
  const sortedBids = [...book.bids].sort(
    (a, b) => parseFloat(b.price) - parseFloat(a.price)
  );

  const best = sortedBids[0]!;
  return {
    price: parseFloat(best.price),
    size: parseFloat(best.size),
  };
}

export function getMidPrice(book: OrderBook): number | null {
  const bestBid = getBestBid(book);
  const bestAsk = getBestAsk(book);

  if (!bestBid || !bestAsk) {
    return null;
  }

  return (bestBid.price + bestAsk.price) / 2;
}
