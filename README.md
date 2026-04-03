# mqtt-pool

A connection pool for the [mqtt](https://www.npmjs.com/package/mqtt) package, inspired by [pg-pool](https://github.com/brianc/node-postgres/tree/master/packages/pg-pool).

Manages a pool of persistent MQTT connections so that frequent publish/subscribe operations share connections without the overhead of connecting and disconnecting on every call.

## Installation

```sh
npm install mqtt-pool mqtt
# or
pnpm add mqtt-pool mqtt
```

`mqtt` is a peer dependency.

## Quick start

```ts
import { createMqttPool } from 'mqtt-pool';

await using pool = createMqttPool('mqtt://broker.example.com', { max: 10 });

// fire-and-forget publish
await pool.publish('sensors/temperature', '22.5');

// subscribe, receive one message, unsubscribe
const { topic, message } = await pool.receive('sensors/temperature');
console.log(topic, message.toString());

// publish a command and wait for one reply
const { message: reply } = await pool.request('cmd/ping', 'ping', {
  responseTopic: 'cmd/pong',
});
```

## API

### `createMqttPool(brokerUrl, opts?)` / `new MqttPool(brokerUrl, opts?)`

Creates a pool. `opts` fields:

| Option | Default | Description |
|---|---|---|
| `max` | `10` | Maximum connections |
| `min` | `2` | Minimum warm connections |
| `acquireTimeoutMillis` | `10000` | Max wait for a free connection |
| `idleTimeoutMillis` | `30000` | Close idle connections above `min` after this |
| `evictionRunIntervalMillis` | `10000` | How often to validate idle connections |
| `mqttOptions` | `{}` | Passed to `mqtt.connectAsync()`. `will`, `clean`, and `reconnectPeriod` are not allowed |

`clean: true` and `reconnectPeriod: 0` are enforced on all pooled connections.
Passing `will` throws immediately — use a dedicated persistent connection for LWT.

### `pool.acquire(): Promise<PooledClient>`

Borrow a connection. The returned client has `[Symbol.asyncDispose]` attached so it can be used with `await using` for automatic release.

```ts
await using client = await pool.acquire();
await client.subscribeAsync('my/topic');
client.on('message', (topic, msg) => { /* ... */ });
```

### `pool.release(client): Promise<void>`

Return a connection. All active subscriptions are unsubscribed first so the connection is clean for the next borrower.

### `pool.destroy(client): Promise<void>`

Permanently remove a connection (call this on errors instead of `release`).

### `pool.publish(topic, payload, opts?): Promise<void>`

Acquire → publish → release in one call.

### `pool.receive(topic, opts?): Promise<{ topic, message }>`

Acquire → subscribe → wait for one message → unsubscribe → release.

```ts
const { message } = await pool.receive('sensors/humidity', { timeout: 5000, qos: 1 });
```

Options: `timeout` (ms, default `10000`), `qos` (`0|1|2`, default `0`).

### `pool.request(cmdTopic, payload, opts): Promise<{ topic, message }>`

Acquire → subscribe to `responseTopic` → publish command → wait for one reply → release.
The response listener is registered before publishing to avoid missing fast replies.

```ts
const { message } = await pool.request('cmd/reboot', 'device-42', {
  responseTopic: 'cmd/reboot/ack',
  timeout: 5000,
});
```

Options: `responseTopic` (required), `timeout` (ms, default `10000`), `qos` (`0|1|2`, default `0`).

### `pool.end(): Promise<void>` / `[Symbol.asyncDispose]`

Drain and close all connections. Also called automatically when used with `await using`.

### Pool status getters

```ts
pool.size       // total connections (borrowed + available)
pool.available  // idle connections ready to borrow
pool.borrowed   // connections currently in use
pool.pending    // acquire calls waiting for a free slot
```

## License

MIT
