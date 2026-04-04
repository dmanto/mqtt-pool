import express from 'express';
import {createServer} from 'node:http';
import {connectAsync} from 'mqtt';
import {createMqttPool} from '../../lib/index.js';

export function createExpressApp(brokerUrl) {
  const expressApp = express();
  const pool = createMqttPool(brokerUrl, {min: 2, max: 10});

  // naive: new connection on every request
  expressApp.get('/naive', async (req, res) => {
    const id = Math.random().toString(36).slice(2);
    const client = await connectAsync(brokerUrl, {clean: true, reconnectPeriod: 0});
    try {
      const {message} = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        client.once('message', (topic, message) => {
          clearTimeout(timer);
          resolve({topic, message});
        });
        client.subscribe(`bench/reply/${id}`, () => {
          client.publish(`bench/cmd/${id}`, 'ping');
        });
      });
      res.send(message.toString());
    } finally {
      await client.endAsync();
    }
  });

  // pool: reuse connections via pool.request()
  expressApp.get('/pool', async (req, res) => {
    const id = Math.random().toString(36).slice(2);
    const {message} = await pool.request(`bench/cmd/${id}`, 'ping', {
      responseTopic: `bench/reply/${id}`
    });
    res.send(message.toString());
  });

  const server = createServer(expressApp);

  return {
    pool,
    listen: port => new Promise(resolve => server.listen(port, '127.0.0.1', resolve)),
    stop: () => new Promise(resolve => server.close(resolve))
  };
}
