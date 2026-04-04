// Compatibility test suite — no `await using`, runs on Node 22+.
// Covers the same API surface as pool.test.ts using try/finally for cleanup.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMqttPool} from '../lib/index.js';
import {startBroker} from './helpers/broker.js';

type TrackedClient = {_poolSubs: Set<string>};

test('MqttPool (compat)', async t => {
  const broker = await startBroker();
  try {
    const BROKER_URL = `mqtt://localhost:${broker.port}`;

    await t.test('throws on LWT option', () => {
      assert.throws(
        () =>
          // @ts-expect-error: `will` is intentionally excluded from mqttOptions — verifying the runtime guard
          createMqttPool(BROKER_URL, {mqttOptions: {will: {topic: 'x', payload: 'x', qos: 0, retain: false}}}),
        /LWT/
      );
    });

    await t.test('acquire and release', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      try {
        const client = await pool.acquire();
        assert.ok(client.connected);
        assert.equal(broker.aedes.connectedClients, 1);
        await pool.release(client);
        assert.equal(pool.borrowed, 0);
        assert.equal(pool.available, 1);
        assert.equal(broker.aedes.connectedClients, 1);
      } finally {
        await pool.end();
      }
    });

    await t.test('release unsubscribes tracked topics', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      try {
        const client = await pool.acquire();
        await client.subscribeAsync('test/topic');
        await pool.release(client);
        const client2 = (await pool.acquire()) as unknown as TrackedClient;
        assert.equal(client2._poolSubs.size, 0);
        await pool.release(client2);
      } finally {
        await pool.end();
      }
    });

    await t.test('publish', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      try {
        await assert.doesNotReject(() => pool.publish('test/pub', 'hello'));
        assert.equal(pool.borrowed, 0);
      } finally {
        await pool.end();
      }
    });

    await t.test('receive', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      try {
        // Publish retained so receive() gets the message regardless of subscribe timing
        await pool.publish('test/recv', 'world', {retain: true});
        const {topic, message} = await pool.receive('test/recv');
        assert.equal(topic, 'test/recv');
        assert.equal(message.toString(), 'world');
        assert.equal(pool.borrowed, 0);
        // Clear retained message
        await pool.publish('test/recv', '', {retain: true});
      } finally {
        await pool.end();
      }
    });

    await t.test('receive timeout', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      try {
        await assert.rejects(() => pool.receive('test/timeout', {timeout: 1}), /timed out/);
        assert.equal(pool.borrowed, 0);
      } finally {
        await pool.end();
      }
    });

    await t.test('request timeout', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      try {
        await assert.rejects(
          () => pool.request('cmd/noreply', 'ping', {responseTopic: 'cmd/noreply-resp', timeout: 1}),
          /timed out/
        );
        assert.equal(pool.borrowed, 0);
      } finally {
        await pool.end();
      }
    });

    await t.test('request', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      try {
        const device = await pool.acquire();
        await device.subscribeAsync('cmd/ping');
        device.on('message', async () => {
          await pool.publish('cmd/pong', 'pong');
        });
        const {message} = await pool.request('cmd/ping', 'ping', {responseTopic: 'cmd/pong'});
        assert.equal(message.toString(), 'pong');
        await pool.release(device);
        assert.equal(pool.borrowed, 0);
      } finally {
        await pool.end();
      }
    });

    await t.test('destroy removes connection from pool', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 0, max: 3});
      try {
        const client = await pool.acquire();
        assert.equal(pool.borrowed, 1);
        assert.equal(broker.aedes.connectedClients, 1);
        await pool.destroy(client);
        assert.equal(pool.borrowed, 0);
        assert.equal(pool.size, 0);
        await broker.waitForClients(0);
        assert.equal(broker.aedes.connectedClients, 0);
      } finally {
        await pool.end();
      }
    });

    await t.test('pool.end() drains all connections', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      const client = await pool.acquire();
      assert.equal(broker.aedes.connectedClients, 1);
      await pool.release(client);
      await pool.end();
      assert.equal(pool.size, 0);
      await broker.waitForClients(0);
      assert.equal(broker.aedes.connectedClients, 0);
    });

    await t.test('release unsubscribes array of topics', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      try {
        const client = await pool.acquire();
        await client.subscribeAsync(['test/a', 'test/b']);
        await pool.release(client);
        const client2 = (await pool.acquire()) as unknown as TrackedClient;
        assert.equal(client2._poolSubs.size, 0);
        await pool.release(client2);
      } finally {
        await pool.end();
      }
    });

    await t.test('release unsubscribes ISubscriptionMap topics', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      try {
        const client = await pool.acquire();
        await client.subscribeAsync({'test/x': {qos: 0}, 'test/y': {qos: 1}});
        await pool.release(client);
        const client2 = (await pool.acquire()) as unknown as TrackedClient;
        assert.equal(client2._poolSubs.size, 0);
        await pool.release(client2);
      } finally {
        await pool.end();
      }
    });

    await t.test('pool status getters reflect concurrency', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 0, max: 2});
      try {
        const [c1, c2] = await Promise.all([pool.acquire(), pool.acquire()]);
        assert.equal(pool.borrowed, 2);
        assert.equal(pool.available, 0);
        assert.equal(pool.size, 2);
        assert.equal(broker.aedes.connectedClients, 2);
        await pool.release(c1);
        assert.equal(pool.borrowed, 1);
        assert.equal(pool.available, 1);
        assert.equal(broker.aedes.connectedClients, 2);
        await pool.release(c2);
        assert.equal(pool.borrowed, 0);
        assert.equal(broker.aedes.connectedClients, 2);
      } finally {
        await pool.end();
      }
    });

    await t.test('max connections limit — pending acquire waits', async () => {
      const pool = createMqttPool(BROKER_URL, {min: 0, max: 1, acquireTimeoutMillis: 5000});
      try {
        const c1 = await pool.acquire();
        assert.equal(pool.borrowed, 1);
        const pendingAcquire = pool.acquire();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(pool.pending, 1);
        await pool.release(c1);
        const c2 = await pendingAcquire;
        assert.equal(pool.borrowed, 1);
        assert.equal(pool.pending, 0);
        await pool.release(c2);
      } finally {
        await pool.end();
      }
    });
  } finally {
    await broker[Symbol.asyncDispose]();
  }
});
