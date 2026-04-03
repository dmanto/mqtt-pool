import {createServer} from 'node:net';
import Aedes from 'aedes';

export async function startBroker(port = 61664) {
  const aedes = new Aedes();
  const server = createServer(aedes.handle.bind(aedes));
  await new Promise(resolve => server.listen(port, resolve));

  // ── echo handler: bench/cmd/{id} → bench/reply/{id} ──────────────────────
  aedes.on('publish', (packet, client) => {
    if (!client) return; // skip broker-internal publishes (including our own echoes)
    if (packet.topic.startsWith('bench/cmd/')) {
      const replyTopic = packet.topic.replace('bench/cmd/', 'bench/reply/');
      aedes.publish(
        {cmd: 'publish', topic: replyTopic, payload: packet.payload, qos: 0, retain: false, dup: false},
        () => {}
      );
    }
  });

  // ── connection-cycle tracker ──────────────────────────────────────────────
  let connects = 0;
  let disconnects = 0;
  let publishes = 0;

  aedes.on('client',           () => connects++);
  aedes.on('clientDisconnect', () => disconnects++);
  aedes.on('publish',          (packet, client) => { if (client) publishes++; });

  return {
    port,
    aedes,
    getSnapshot() {
      return {connects, disconnects, publishes, connectedClients: aedes.connectedClients};
    },
    resetCounters() {
      connects = 0; disconnects = 0; publishes = 0;
    },
    [Symbol.asyncDispose]: () =>
      new Promise((resolve, reject) => {
        aedes.close(() => {
          server.close(err => (err ? reject(err) : resolve()));
        });
      })
  };
}
