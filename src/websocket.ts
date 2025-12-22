import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { info, debug, error, warn } from './logger.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

interface BookUpdate {
  event_type: 'book';
  asset_id: string;
  market: string;
  bids: [string, string][]; // [price, size]
  asks: [string, string][];
  timestamp: string;
  hash: string;
}

interface PriceChange {
  event_type: 'price_change';
  asset_id: string;
  price_changes: Array<{
    best_bid: string;
    best_ask: string;
  }>;
}

interface LastTradePrice {
  event_type: 'last_trade_price';
  asset_id: string;
  price: string;
  size: string;
  side: string;
}

type WSMessage = BookUpdate | PriceChange | LastTradePrice;

export interface ParsedBookUpdate {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
  timestamp: Date;
}

export class PolymarketWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedTokens: Set<string> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private pingInterval: NodeJS.Timeout | null = null;
  private isConnected = false;

  constructor() {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(WS_URL);

        this.ws.on('open', () => {
          info('WebSocket connected to Polymarket CLOB');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startPingInterval();

          // Resubscribe to any previously subscribed tokens
          if (this.subscribedTokens.size > 0) {
            this.subscribeToTokens([...this.subscribedTokens]);
          }

          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', () => {
          warn('WebSocket connection closed');
          this.isConnected = false;
          this.stopPingInterval();
          this.emit('disconnected');
          this.attemptReconnect();
        });

        this.ws.on('error', (err) => {
          error('WebSocket error', err);
          this.emit('error', err);
          if (!this.isConnected) {
            reject(err);
          }
        });
      } catch (err) {
        error('Failed to create WebSocket', err);
        reject(err);
      }
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as WSMessage;

      if (message.event_type === 'book') {
        const update = this.parseBookUpdate(message as BookUpdate);
        this.emit('book', update);
      } else if (message.event_type === 'price_change') {
        const priceMsg = message as PriceChange;
        for (const change of priceMsg.price_changes) {
          const update: ParsedBookUpdate = {
            tokenId: priceMsg.asset_id,
            bestBid: change.best_bid ? parseFloat(change.best_bid) : null,
            bestAsk: change.best_ask ? parseFloat(change.best_ask) : null,
            bestBidSize: null,
            bestAskSize: null,
            timestamp: new Date(),
          };
          this.emit('price', update);
        }
      } else if (message.event_type === 'last_trade_price') {
        const tradeMsg = message as LastTradePrice;
        this.emit('trade', {
          tokenId: tradeMsg.asset_id,
          price: parseFloat(tradeMsg.price),
          size: parseFloat(tradeMsg.size),
          side: tradeMsg.side,
        });
      }
    } catch (err) {
      debug('Failed to parse WebSocket message', err);
    }
  }

  private parseBookUpdate(msg: BookUpdate): ParsedBookUpdate {
    // Bids are sorted descending (highest first), asks ascending (lowest first)
    const bestBid = msg.bids.length > 0 ? parseFloat(msg.bids[0]![0]!) : null;
    const bestBidSize = msg.bids.length > 0 ? parseFloat(msg.bids[0]![1]!) : null;
    const bestAsk = msg.asks.length > 0 ? parseFloat(msg.asks[0]![0]!) : null;
    const bestAskSize = msg.asks.length > 0 ? parseFloat(msg.asks[0]![1]!) : null;

    return {
      tokenId: msg.asset_id,
      bestBid,
      bestAsk,
      bestBidSize,
      bestAskSize,
      timestamp: new Date(msg.timestamp),
    };
  }

  subscribeToTokens(tokenIds: string[]): void {
    if (!this.ws || !this.isConnected) {
      warn('Cannot subscribe - WebSocket not connected');
      return;
    }

    // Add to tracked set
    for (const id of tokenIds) {
      this.subscribedTokens.add(id);
    }

    const subscription = {
      assets_ids: tokenIds,
      type: 'market',
    };

    debug(`Subscribing to ${tokenIds.length} tokens`);
    this.ws.send(JSON.stringify(subscription));
  }

  unsubscribeFromTokens(tokenIds: string[]): void {
    if (!this.ws || !this.isConnected) {
      return;
    }

    for (const id of tokenIds) {
      this.subscribedTokens.delete(id);
    }

    const message = {
      assets_ids: tokenIds,
      type: 'market',
      action: 'unsubscribe',
    };

    this.ws.send(JSON.stringify(message));
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      error('Max reconnection attempts reached');
      this.emit('maxReconnectAttempts');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    info(`Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    setTimeout(() => {
      this.connect().catch((err) => {
        error('Reconnection failed', err);
      });
    }, delay);
  }

  disconnect(): void {
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.subscribedTokens.clear();
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  getSubscribedCount(): number {
    return this.subscribedTokens.size;
  }
}
