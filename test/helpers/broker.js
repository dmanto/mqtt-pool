import {createServer} from 'node:net';
import Aedes from 'aedes';

export async function startBroker(port = 61663) {
  const aedes = new Aedes();
  const server = createServer(aedes.handle.bind(aedes));

  await new Promise(resolve => server.listen(port, resolve));

  return {
    port,
    // aedes instance — use e.g. broker.aedes.connectedClients to inspect live connections
    aedes,
    // Poll until connectedClients reaches n (connections close asynchronously after pool.end())
    async waitForClients(n, ms = 1000) {
      const deadline = Date.now() + ms;
      while (aedes.connectedClients !== n) {
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting for ${n} connected clients (current: ${aedes.connectedClients})`);
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    [Symbol.asyncDispose]: () =>
      new Promise((resolve, reject) => {
        aedes.close(() => {
          server.close(err => (err ? reject(err) : resolve()));
        });
      })
  };
}
