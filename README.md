# mqtt-pool

A connection pool for the [mqtt](https://www.npmjs.com/package/mqtt) package, inspired by [pg-pool](https://github.com/brianc/node-postgres/tree/master/packages/pg-pool).

## Why?

Every MQTT operation in a web server involves two choices: create a connection per request, or reuse connections from a pool.

The naive approach pays for a full TCP + MQTT handshake on every request — typically 7 round-trips before your handler even runs. Here is what that costs in a command/reply scenario benchmarked against an in-process broker (same machine, no network latency):

```
                    req/s    p50     p99     connects   disconnects
Express  naive        861    10 ms   24 ms      8617          8616
Express  pool        2427     3 ms    9 ms         8             0

Fastify  naive        906     9 ms   28 ms      9073          9073
Fastify  pool        3129     3 ms    5 ms         8             0

MojoJS   naive        926     9 ms   26 ms      9266          9266
MojoJS   pool        2902     3 ms    9 ms         8             0
```

**~3× throughput, ~3× lower p50, and the broker sees 8 connection cycles instead of 9000.**

The pool creates connections once and keeps them alive. Your handlers borrow a connection, use it, and return it — no handshake, no teardown.

## Installation

```sh
npm install mqtt-pool mqtt
# or
pnpm add mqtt-pool mqtt
```

`mqtt` is a peer dependency — bring your own version.

## Quick start

```ts
import { createMqttPool } from 'mqtt-pool';

await using pool = createMqttPool('mqtt://broker.example.com', { max: 10 });

// publish — acquire → publish → release, automatically
await pool.publish('sensors/temperature', '22.5');

// receive — acquire → subscribe → wait for one message → unsubscribe → release
const { topic, message } = await pool.receive('sensors/temperature');

// request — subscribe to reply topic, publish command, wait for one reply
const { message: reply } = await pool.request('cmd/ping', 'ping', {
  responseTopic: 'cmd/pong',
});
```

`await using` on the pool itself drains all connections when the scope exits.

## API

### `createMqttPool(brokerUrl, opts?)` / `new MqttPool(brokerUrl, opts?)`

| Option | Default | Description |
|---|---|---|
| `max` | `10` | Maximum connections |
| `min` | `2` | Minimum warm connections kept alive |
| `acquireTimeoutMillis` | `10000` | Max wait for a free connection |
| `idleTimeoutMillis` | `30000` | Close idle connections above `min` after this |
| `evictionRunIntervalMillis` | `10000` | How often to validate idle connections |
| `mqttOptions` | `{}` | Passed to `mqtt.connectAsync()`. `will`, `clean`, and `reconnectPeriod` are not allowed |

`clean: true` and `reconnectPeriod: 0` are enforced on every pooled connection — the pool manages the connection lifecycle, not mqtt.js. Passing `will` throws at construction time with a clear error message; use a dedicated persistent connection for LWT.

### `pool.acquire(): Promise<PooledClient>`

Borrow a connection. The returned client has `[Symbol.asyncDispose]` attached for automatic release with `await using`:

```ts
await using client = await pool.acquire();
await client.subscribeAsync('my/topic');
client.on('message', (topic, msg) => { /* ... */ });
// released automatically here, subscriptions cleaned up
```

### `pool.release(client): Promise<void>`

Return a connection. All active subscriptions are unsubscribed first so the connection is clean for the next borrower. Subscriptions to string, array, and `ISubscriptionMap` topic forms are all tracked.

### `pool.destroy(client): Promise<void>`

Permanently remove a connection from the pool (call this on errors, not `release`).

### `pool.publish(topic, payload, opts?): Promise<void>`

Acquire → publish → release in one call. On error, the connection is destroyed rather than returned.

### `pool.receive(topic, opts?): Promise<{ topic, message }>`

Acquire → subscribe → wait for one message → unsubscribe → release.

```ts
const { message } = await pool.receive('sensors/humidity', { timeout: 5000, qos: 1 });
```

Options: `timeout` (ms, default `10000`), `qos` (`0|1|2`, default `0`).

### `pool.request(cmdTopic, payload, opts): Promise<{ topic, message }>`

Acquire → subscribe to `responseTopic` → publish command → wait for one reply → release.
The response listener is registered **before** publishing to avoid missing fast replies.

```ts
const { message } = await pool.request('cmd/reboot', 'device-42', {
  responseTopic: 'cmd/reboot/ack',
  timeout: 5000,
});
```

Options: `responseTopic` (required), `timeout` (ms, default `10000`), `qos` (`0|1|2`, default `0`).

### `pool.end(): Promise<void>` / `[Symbol.asyncDispose]`

Drain and close all connections gracefully. Automatically called when used with `await using`.

### Status getters

```ts
pool.size       // total connections (borrowed + available)
pool.available  // idle connections ready to borrow
pool.borrowed   // connections currently in use
pool.pending    // acquire calls waiting for a free slot
```

## Running the benchmarks

```sh
pnpm bench
```

Starts an in-process [aedes](https://github.com/moscajs/aedes) broker and runs a command/reply scenario against Express, Fastify, and MojoJS — each with a naive route (connect per request) and a pool route — for 10 seconds at 10 concurrent connections.

## License

MIT
