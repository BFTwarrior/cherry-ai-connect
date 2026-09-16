/**
 * 中文：为本地连接服务选择端口。手动重置使用系统级安全随机源，并自动跳过占用端口。
 * English: Selects the local service port. Manual reset uses the OS-backed secure RNG and skips occupied ports.
 */
const crypto = require("node:crypto");
const net = require("node:net");

const RANDOM_PORT_MIN = 20000;
const RANDOM_PORT_MAX = 48999;
const RANDOM_PORT_COUNT = RANDOM_PORT_MAX - RANDOM_PORT_MIN + 1;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    const finish = (available) => {
      probe.removeAllListeners();
      try { probe.close(); } catch { /* probe was never listening */ }
      resolve(available);
    };
    probe.once("error", () => finish(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function isSelectablePort(value, exclude) {
  return Number.isInteger(value) && value >= RANDOM_PORT_MIN && value <= RANDOM_PORT_MAX && value !== exclude;
}

function securelyShuffledPorts(exclude) {
  const values = [];
  for (let port = RANDOM_PORT_MIN; port <= RANDOM_PORT_MAX; port += 1) {
    if (port !== exclude) values.push(port);
  }
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}

async function chooseGatewayPort(preferred, { exclude, randomize = false, probe = isPortAvailable } = {}) {
  const safePreferred = Number(preferred);
  if (!randomize && isSelectablePort(safePreferred, exclude) && await probe(safePreferred)) return safePreferred;

  const candidates = securelyShuffledPorts(exclude);
  for (const port of candidates) {
    if (!randomize && port === safePreferred) continue;
    if (await probe(port)) return port;
  }
  throw new Error(`没有找到可用的本地连接端口（${RANDOM_PORT_MIN}-${RANDOM_PORT_MAX}）`);
}

module.exports = { chooseGatewayPort, RANDOM_PORT_MIN, RANDOM_PORT_MAX, RANDOM_PORT_COUNT };
