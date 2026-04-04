import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMqttPool} from '../lib/index.js';
import {startBroker} from './helpers/broker.js';
import {type MqttClient} from 'mqtt';

// Internal shape added by wrapClient — used only in subscription-tracking tests
type TrackedMqttClient = MqttClient & {
  _poolSubs: Set<string>;
};

test('MqttPool', async t => {
  await using broker = await startBroker();
  const BROKER_URL = `mqtt://localhost:${broker.port}`;

  await t.test('throws on LWT option', () => {
    assert.throws(
      // @ts-expect-error: `will` is intentionally excluded from mqttOptions — verifying the runtime guard
      () => createMqttPool(BROKER_URL, {mqttOptions: {will: {topic: 'x', payload: 'x', qos: 0, retain: false}}}),
      /LWT/
    );
  });

  await t.test('acquire and release', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    const client = await pool.acquire();
    assert.ok(client.connected);
    assert.equal(broker.aedes.connectedClients, 1);
    await pool.release(client);
    assert.equal(pool.borrowed, 0);
    assert.equal(pool.available, 1);
    assert.equal(broker.aedes.connectedClients, 1); // returned to pool, not closed
  });

  await t.test('await using on acquired client releases back to pool', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    {
      await using client = await pool.acquire();
      assert.ok(client.connected);
    }
    assert.equal(pool.borrowed, 0);
  });

  await t.test('release unsubscribes tracked topics', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    const client = await pool.acquire();
    await client.subscribeAsync('test/topic');
    await pool.release(client);
    // reacquire same connection — subscription set must be empty
    const client2 = (await pool.acquire()) as unknown as TrackedMqttClient;
    assert.equal(client2._poolSubs.size, 0);

    await pool.release(client2);
  });

  await t.test('publish', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    await assert.doesNotReject(() => pool.publish('test/pub', 'hello'));
    assert.equal(pool.borrowed, 0);
  });

  await t.test('receive', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    const receivePromise = pool.receive('test/recv');
    await pool.publish('test/recv', 'world');
    const {topic, message} = await receivePromise;
    assert.equal(topic, 'test/recv');
    assert.equal(message.toString(), 'world');
    assert.equal(pool.borrowed, 0);
  });

  await t.test('receive timeout', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    // timeout fires after subscribeAsync completes; 1ms is enough since no message is published
    await assert.rejects(() => pool.receive('test/timeout', {timeout: 1}), /timed out/);
    assert.equal(pool.borrowed, 0);
  });

  await t.test('request timeout', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    await assert.rejects(
      () => pool.request('cmd/noreply', 'ping', {responseTopic: 'cmd/noreply-resp', timeout: 1}),
      /timed out/
    );
    assert.equal(pool.borrowed, 0);
  });

  await t.test('request', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    const device = await pool.acquire();
    await device.subscribeAsync('cmd/ping');
    device.on('message', async () => {
      await pool.publish('cmd/pong', 'pong');
    });
    const {message} = await pool.request('cmd/ping', 'ping', {responseTopic: 'cmd/pong'});
    assert.equal(message.toString(), 'pong');
    await pool.release(device);
    assert.equal(pool.borrowed, 0);
  });

  await t.test('destroy removes connection from pool', async () => {
    // min:0 so pool does not immediately replace the destroyed connection
    await using pool = createMqttPool(BROKER_URL, {min: 0, max: 3});
    const client = await pool.acquire();
    assert.equal(pool.borrowed, 1);
    assert.equal(broker.aedes.connectedClients, 1);
    await pool.destroy(client);
    assert.equal(pool.borrowed, 0);
    assert.equal(pool.size, 0);
    await broker.waitForClients(0);
    assert.equal(broker.aedes.connectedClients, 0);
  });

  await t.test('await using on pool calls end()', async () => {
    {
      await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
      const client = await pool.acquire();
      assert.equal(broker.aedes.connectedClients, 1);
      await pool.release(client);
    } // asyncDispose closes all connections here
    await broker.waitForClients(0);
    assert.equal(broker.aedes.connectedClients, 0);
  });

  await t.test('release unsubscribes array of topics', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    const client = await pool.acquire();
    await client.subscribeAsync(['test/a', 'test/b']);
    await pool.release(client);
    const client2 = (await pool.acquire()) as unknown as TrackedMqttClient;
    assert.equal(client2._poolSubs.size, 0);
    await pool.release(client2);
  });

  await t.test('release unsubscribes ISubscriptionMap topics', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    const client = await pool.acquire();
    await client.subscribeAsync({'test/x': {qos: 0}, 'test/y': {qos: 1}});
    await pool.release(client);
    const client2 = (await pool.acquire()) as unknown as TrackedMqttClient;
    assert.equal(client2._poolSubs.size, 0);
    await pool.release(client2);
  });

  await t.test('pool status getters reflect concurrency', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 0, max: 2});
    const [c1, c2] = await Promise.all([pool.acquire(), pool.acquire()]);
    assert.equal(pool.borrowed, 2);
    assert.equal(pool.available, 0);
    assert.equal(pool.size, 2);
    assert.equal(broker.aedes.connectedClients, 2);
    await pool.release(c1);
    assert.equal(pool.borrowed, 1);
    assert.equal(pool.available, 1);
    assert.equal(broker.aedes.connectedClients, 2); // c1 back in pool, still connected
    await pool.release(c2);
    assert.equal(pool.borrowed, 0);
    assert.equal(broker.aedes.connectedClients, 2); // both idle in pool
  });

  await t.test('max connections limit — pending acquire waits', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 0, max: 1, acquireTimeoutMillis: 5000});
    const c1 = await pool.acquire();
    assert.equal(pool.borrowed, 1);
    // second acquire must wait — release c1 after a tick
    const pendingAcquire = pool.acquire();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pool.pending, 1);
    await pool.release(c1);
    const c2 = await pendingAcquire;
    assert.equal(pool.borrowed, 1);
    assert.equal(pool.pending, 0);
    await pool.release(c2);
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
});
