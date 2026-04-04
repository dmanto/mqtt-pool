import autocannon from 'autocannon';
import {startBroker} from './broker.js';
import {createExpressApp} from './apps/express.js';
import {createFastifyApp} from './apps/fastify.js';
import {createMojoApp} from './apps/mojo.js';

const DURATION = 10; // seconds per route
const CONNECTIONS = 10; // concurrent HTTP connections
const DRAIN_MS = 600; // wait after each run for stragglers to disconnect

// ── helpers ───────────────────────────────────────────────────────────────────

const drain = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bench(url, broker, label) {
  broker.resetCounters();
  const result = await autocannon({url, duration: DURATION, connections: CONNECTIONS, silent: true});
  await drain(DRAIN_MS);
  const snap = broker.getSnapshot();
  return {label, result, snap};
}

function pad(n, w = 8) {
  return String(n).padStart(w);
}
function ms(n) {
  return (typeof n === 'number' ? n.toFixed(2) + ' ms' : 'n/a').padStart(10);
}

function printResult({label, result, snap}) {
  const lat = result.latency;
  console.log(`\n  ${label}`);
  console.log(`    req/s         ${pad(Math.round(result.requests.average))}`);
  console.log(`    p50 latency   ${ms(lat.p50)}`);
  console.log(`    p97.5 latency ${ms(lat.p97_5)}`);
  console.log(`    p99 latency   ${ms(lat.p99)}`);
  console.log(`    errors        ${pad(result.errors + result.timeouts)}`);
  console.log(`    connects      ${pad(snap.connects)}`);
  console.log(`    disconnects   ${pad(snap.disconnects)}`);
  console.log(`    publishes     ${pad(snap.publishes)}`);
}

// ── run one framework ─────────────────────────────────────────────────────────

async function runFramework(name, broker, createApp, port) {
  const brokerUrl = `mqtt://localhost:${broker.port}`;
  const {listen, stop, pool} = createApp(brokerUrl);
  await listen(port);

  // warm up: ensure min pool connections are established before measuring
  const warmup = await pool.acquire();
  await pool.release(warmup);

  const base = `http://127.0.0.1:${port}`;

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  ${name}  (${DURATION}s × ${CONNECTIONS} connections)`);
  console.log(`${'─'.repeat(56)}`);

  const naiveResult = await bench(`${base}/naive`, broker, 'naive  (connect per request)');
  const poolResult = await bench(`${base}/pool`, broker, 'pool   (reuse connections)');

  printResult(naiveResult);
  printResult(poolResult);

  await pool.end();
  await stop();
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  await using broker = await startBroker();

  await runFramework('Express', broker, createExpressApp, 4001);
  await runFramework('Fastify', broker, createFastifyApp, 4002);
  await runFramework('MojoJS', broker, createMojoApp, 4003);

  console.log(`\n${'─'.repeat(56)}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
