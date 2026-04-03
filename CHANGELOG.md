# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.1.1 - 2026-04-03

### Added

- Benchmark suite (`pnpm bench`) — Express, Fastify, and MojoJS each with a
  naive (connect per request) and a pool route; reports req/s, p50/p97.5/p99
  latency, and broker-side connect/disconnect/publish counts via aedes events
- README rewritten around benchmark results as the primary "why this package"
  argument

## 0.1.0 - 2026-04-03

### Added

- `MqttPool` class and `createMqttPool` factory function
- `pool.acquire()` — returns a `PooledClient` with `[Symbol.asyncDispose]` support for `await using`
- `pool.release(client)` — unsubscribes all tracked topics then returns client to pool
- `pool.destroy(client)` — permanently removes and ends a connection (use on errors)
- `pool.publish(topic, payload, opts?)` — fire-and-forget publish with automatic acquire/release
- `pool.receive(topic, opts?)` — subscribe, wait for one message, unsubscribe, release
- `pool.request(cmdTopic, payload, opts)` — publish a command and wait for one reply
- `pool.end()` / `[Symbol.asyncDispose]` — graceful drain and shutdown, supports `await using`
- Pool status getters: `size`, `available`, `borrowed`, `pending`
- Subscription tracking: `subscribeAsync` and `unsubscribeAsync` calls are tracked per client; all active subscriptions are cleaned up on release; string, array, and `ISubscriptionMap` topic forms all tracked correctly
- `clean: true` and `reconnectPeriod: 0` enforced on all pooled connections
- `testOnBorrow: true` with periodic eviction to detect and replace stale connections
- LWT (`will`) option throws at construction time with a clear error message
- Test suite using `node:test` and an in-process `aedes` broker; assertions include `broker.aedes.connectedClients` to verify actual TCP connection lifecycle

## 0.0.1 - 2026-04-02

### Added

- Initial placeholder release to reserve package name
