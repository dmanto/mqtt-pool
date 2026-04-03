import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMqttPool} from '../lib/index.js';
import {startBroker} from './helpers/broker.js';

test('MqttPool', async t => {
  await using broker = await startBroker();
  const BROKER_URL = `mqtt://localhost:${broker.port}`;

  await t.test('throws on LWT option', () => {
    assert.throws(
      () => createMqttPool(BROKER_URL, {mqttOptions: {will: {topic: 'x', payload: 'x', qos: 0, retain: false}}}),
      /LWT/
    );
  });

  await t.test('acquire and release', async () => {
    await using pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    const client = await pool.acquire();
    assert.ok(client.connected);
    await pool.release(client);
    assert.equal(pool.borrowed, 0);
    assert.equal(pool.available, 1);
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
    const client2 = await pool.acquire();
    assert.equal((client2 as {_poolSubs: Set<string>})._poolSubs.size, 0);
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
    await assert.rejects(
      () => pool.receive('test/timeout', {timeout: 100}),
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

  await t.test('pool.end() drains all connections', async () => {
    const pool = createMqttPool(BROKER_URL, {min: 1, max: 3});
    const client = await pool.acquire();
    await pool.release(client);
    await pool.end();
    assert.equal(pool.size, 0);
  });
});
