import {createServer} from 'node:net';
import Aedes from 'aedes';

export async function startBroker(port = 61663) {
  const aedes = new Aedes();
  const server = createServer(aedes.handle.bind(aedes));

  await new Promise(resolve => server.listen(port, resolve));

  return {
    port,
    [Symbol.asyncDispose]: () =>
      new Promise((resolve, reject) => {
        aedes.close(() => {
          server.close(err => (err ? reject(err) : resolve()));
        });
      })
  };
}
