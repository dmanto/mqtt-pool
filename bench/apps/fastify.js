import Fastify from 'fastify';
import {connectAsync} from 'mqtt';
import {createMqttPool} from '../../lib/index.js';

export function createFastifyApp(brokerUrl) {
  const app = Fastify();
  const pool = createMqttPool(brokerUrl, {min: 2, max: 10});

  // naive: new connection on every request
  app.get('/naive', async () => {
    const id = Math.random().toString(36).slice(2);
    const client = await connectAsync(brokerUrl, {clean: true, reconnectPeriod: 0});
    try {
      const {message} = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        client.once('message', (topic, message) => { clearTimeout(timer); resolve({topic, message}); });
        client.subscribe(`bench/reply/${id}`, () => {
          client.publish(`bench/cmd/${id}`, 'ping');
        });
      });
      return message.toString();
    } finally {
      await client.endAsync();
    }
  });

  // pool: reuse connections via pool.request()
  app.get('/pool', async () => {
    const id = Math.random().toString(36).slice(2);
    const {message} = await pool.request(`bench/cmd/${id}`, 'ping', {
      responseTopic: `bench/reply/${id}`
    });
    return message.toString();
  });

  return {
    pool,
    listen: port => app.listen({port, host: '127.0.0.1'}),
    stop:   ()   => app.close()
  };
}
