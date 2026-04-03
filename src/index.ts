import {
  connectAsync,
  type MqttClient,
  type IClientOptions,
  type IClientPublishOptions,
  type IClientSubscribeOptions,
  type IClientSubscribeProperties,
  type IClientUnsubscribeProperties,
  type ISubscriptionGrant,
  type ISubscriptionMap,
  type Packet
} from 'mqtt';
import {createPool, type Pool} from 'generic-pool';

// ─── Public types ─────────────────────────────────────────────────────────────

export type MqttPoolOptions = {
  /** Maximum number of connections in the pool. Default: 10 */
  max?: number;
  /** Minimum number of warm connections kept alive. Default: 2 */
  min?: number;
  /** Milliseconds to wait for an available connection before rejecting. Default: 10000 */
  acquireTimeoutMillis?: number;
  /** Milliseconds before closing idle connections above `min`. Default: 30000 */
  idleTimeoutMillis?: number;
  /** Milliseconds between eviction runs that validate idle connections. Default: 10000 */
  evictionRunIntervalMillis?: number;
  /** mqtt connection options. `will`, `clean` and `reconnectPeriod` are not allowed. */
  mqttOptions?: Omit<IClientOptions, 'will' | 'clean' | 'reconnectPeriod'>;
};

export type ReceiveResult = {topic: string; message: Buffer};

export type ReceiveOptions = {
  /** Milliseconds to wait for a message before rejecting. Default: 10000 */
  timeout?: number;
  qos?: 0 | 1 | 2;
};

export type RequestOptions = ReceiveOptions & {
  /** Topic to subscribe to for the response. */
  responseTopic: string;
};

export type PooledClient = MqttClient & AsyncDisposable;

// ─── Internal types ───────────────────────────────────────────────────────────

type TrackedClient = MqttClient & {_poolSubs: Set<string>};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function topicsOf(arg: string | string[] | ISubscriptionMap): string[] {
  if (typeof arg === 'string') return [arg];
  if (Array.isArray(arg)) return arg;
  return Object.keys(arg);
}

function wrapClient(client: MqttClient): TrackedClient {
  const subs = new Set<string>();
  const origSubscribe = client.subscribeAsync.bind(client);
  const origUnsubscribe = client.unsubscribeAsync.bind(client);

  const wrappedSubscribe = async (
    topicObject: string | string[] | ISubscriptionMap,
    opts?: IClientSubscribeOptions | IClientSubscribeProperties
  ): Promise<ISubscriptionGrant[]> => {
    const result = opts !== undefined
      ? await origSubscribe(topicObject, opts)
      : await origSubscribe(topicObject);
    topicsOf(topicObject).forEach(t => subs.add(t));
    return result;
  };

  const wrappedUnsubscribe = async (
    topic: string | string[],
    opts?: IClientUnsubscribeProperties
  ): Promise<Packet | undefined> => {
    const result = opts !== undefined
      ? await origUnsubscribe(topic, opts)
      : await origUnsubscribe(topic);
    topicsOf(topic).forEach(t => subs.delete(t));
    return result;
  };

  return Object.assign(client, {
    subscribeAsync: wrappedSubscribe,
    unsubscribeAsync: wrappedUnsubscribe,
    _poolSubs: subs
  }) as TrackedClient;
}

// ─── MqttPool ─────────────────────────────────────────────────────────────────

export class MqttPool implements AsyncDisposable {
  private _pool: Pool<TrackedClient>;

  constructor(brokerUrl: string, opts: MqttPoolOptions = {}) {
    const {
      max = 10,
      min = 2,
      acquireTimeoutMillis = 10000,
      idleTimeoutMillis = 30000,
      evictionRunIntervalMillis = 10000,
      mqttOptions = {}
    } = opts;

    if ('will' in mqttOptions) {
      throw new Error(
        'mqtt-pool: LWT (will) is not supported on pooled connections — use a dedicated persistent connection for presence signalling'
      );
    }

    const mqttOpts: IClientOptions = {...mqttOptions, clean: true, reconnectPeriod: 0};

    this._pool = createPool<TrackedClient>(
      {
        create: () => connectAsync(brokerUrl, mqttOpts).then(wrapClient),
        destroy: client => client.endAsync(),
        validate: client => Promise.resolve(client.connected)
      },
      {max, min, acquireTimeoutMillis, idleTimeoutMillis, evictionRunIntervalMillis, testOnBorrow: true}
    );
  }

  /** Acquire a connection from the pool. Supports `await using` for automatic release. */
  async acquire(): Promise<PooledClient> {
    const client = await this._pool.acquire();
    return Object.assign(client, {[Symbol.asyncDispose]: () => this.release(client)});
  }

  /** Return a connection to the pool, unsubscribing from any active subscriptions first. */
  async release(client: MqttClient): Promise<void> {
    const tracked = client as TrackedClient;
    if (tracked._poolSubs.size > 0) await client.unsubscribeAsync([...tracked._poolSubs]);
    await this._pool.release(tracked);
  }

  /** Permanently remove a connection from the pool and end it. Use on errors. */
  async destroy(client: MqttClient): Promise<void> {
    await this._pool.destroy(client as TrackedClient);
  }

  /** Publish a message, acquiring and releasing a connection automatically. */
  async publish(topic: string, payload: string | Buffer, opts?: IClientPublishOptions): Promise<void> {
    const client = await this._pool.acquire();
    try {
      await client.publishAsync(topic, payload, opts);
      await this.release(client);
    } catch (err) {
      await this.destroy(client);
      throw err;
    }
  }

  /** Subscribe to a topic, wait for one message, then unsubscribe and release. */
  async receive(topic: string, opts: ReceiveOptions = {}): Promise<ReceiveResult> {
    const {timeout = 10000, qos = 0} = opts;
    const client = await this._pool.acquire();
    try {
      await client.subscribeAsync(topic, {qos});
      const result = await new Promise<ReceiveResult>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`mqtt-pool: receive timed out after ${timeout}ms`)),
          timeout
        );
        client.once('message', (t, message) => {
          clearTimeout(timer);
          resolve({topic: t, message});
        });
      });
      await this.release(client);
      return result;
    } catch (err) {
      await this.destroy(client);
      throw err;
    }
  }

  /**
   * Publish a command and wait for one response message, then unsubscribe and release.
   * The response listener is registered before publishing to avoid missing fast replies.
   */
  async request(cmdTopic: string, payload: string | Buffer, opts: RequestOptions): Promise<ReceiveResult> {
    const {responseTopic, timeout = 10000, qos = 0} = opts;
    const client = await this._pool.acquire();
    try {
      await client.subscribeAsync(responseTopic, {qos});
      const responsePromise = new Promise<ReceiveResult>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`mqtt-pool: request timed out after ${timeout}ms`)),
          timeout
        );
        client.once('message', (t, message) => {
          clearTimeout(timer);
          resolve({topic: t, message});
        });
      });
      await client.publishAsync(cmdTopic, payload, {qos});
      const result = await responsePromise;
      await this.release(client);
      return result;
    } catch (err) {
      await this.destroy(client);
      throw err;
    }
  }

  /** Drain and close all pool connections. Also called by `await using`. */
  async end(): Promise<void> {
    await this._pool.drain();
    await this._pool.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.end();
  }

  get size(): number {return this._pool.size;}
  get available(): number {return this._pool.available;}
  get borrowed(): number {return this._pool.borrowed;}
  get pending(): number {return this._pool.pending;}
}

export function createMqttPool(brokerUrl: string, opts?: MqttPoolOptions): MqttPool {
  return new MqttPool(brokerUrl, opts);
}
