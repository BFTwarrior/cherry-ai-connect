import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { chooseGatewayPort, RANDOM_PORT_MIN, RANDOM_PORT_MAX, RANDOM_PORT_COUNT } = require("../electron/port-selector.js");

test("manual reset uses the expanded secure-random port pool", async () => {
  assert.equal(RANDOM_PORT_COUNT, 29_000);
  const previous = 27891;
  const selected = await chooseGatewayPort(previous, { exclude: previous, randomize: true, probe: async () => true });
  assert.ok(selected >= RANDOM_PORT_MIN && selected <= RANDOM_PORT_MAX);
  assert.notEqual(selected, previous);
});

test("normal startup keeps an available saved port", async () => {
  const selected = await chooseGatewayPort(27891, { probe: async (port) => port === 27891 });
  assert.equal(selected, 27891);
});

test("occupied ports are skipped", async () => {
  let probes = 0;
  const selected = await chooseGatewayPort(27891, {
    exclude: 27891,
    randomize: true,
    probe: async () => { probes += 1; return probes > 1; },
  });
  assert.equal(probes, 2);
  assert.ok(selected >= RANDOM_PORT_MIN && selected <= RANDOM_PORT_MAX);
});
