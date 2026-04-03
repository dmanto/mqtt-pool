import mojo, {Server} from '@mojojs/core';
import {connectAsync} from 'mqtt';
import {createMqttPool} from '../../lib/index.js';

export function createMojoApp(brokerUrl) {
  const mojoApp = mojo();
  mojoApp.log.level = 'fatal'; // suppress trace/debug output during benchmark
  const pool = createMqttPool(brokerUrl, {min: 2, max: 10});

  // naive: new connection on every request
  mojoApp.get('/naive', async ctx => {
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
      await ctx.render({text: message.toString()});
    } finally {
      await client.endAsync();
    }
  });

  // pool: reuse connections via pool.request()
  mojoApp.get('/pool', async ctx => {
    const id = Math.random().toString(36).slice(2);
    const {message} = await pool.request(`bench/cmd/${id}`, 'ping', {
      responseTopic: `bench/reply/${id}`
    });
    await ctx.render({text: message.toString()});
  });

  let server;
  return {
    pool,
    listen: async port => {
      server = new Server(mojoApp, {listen: [`http://127.0.0.1:${port}`]});
      await server.start();
    },
    stop: () => server.stop()
  };
}
