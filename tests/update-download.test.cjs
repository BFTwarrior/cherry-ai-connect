const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { downloadVerifiedInstaller } = require("../electron/update-manager");

const runtimeRoot = path.resolve(__dirname, "../.test-runtime");
fs.mkdirSync(runtimeRoot, { recursive: true });

function makeFixture() {
  const root = fs.mkdtempSync(path.join(runtimeRoot, "update-download-"));
  const destination = path.join(root, "installer.exe");
  return {
    root,
    destination,
    temporary: `${destination}.${process.pid}.part`,
    cleanup() {
      const resolved = path.resolve(root);
      assert.ok(resolved.startsWith(`${runtimeRoot}${path.sep}`), "test cleanup stays within .test-runtime");
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assetFor(bytes, url = "https://github.com/example/release/installer.exe") {
  return { name: "installer.exe", url, sha256: digest(bytes) };
}

function responseFor(bytes, { statusCode = 200, location, complete = true } = {}) {
  const response = new PassThrough();
  response.statusCode = statusCode;
  response.headers = { "content-length": String(bytes.length) };
  if (location) response.headers.location = location;
  response.complete = complete;
  return response;
}

function requestWith(handler) {
  const calls = [];
  const requestImpl = (url, options, onResponse) => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; };
    calls.push({ url: String(url), options, request });
    queueMicrotask(() => handler({ url, options, onResponse, request, calls }));
    return request;
  };
  return { requestImpl, calls };
}

function sendResponse(onResponse, response, bytes = Buffer.alloc(0)) {
  onResponse(response);
  queueMicrotask(() => response.end(bytes));
}

function assertNoPartial(fixture) {
  assert.equal(fs.existsSync(fixture.temporary), false, "partial download must be removed");
  assert.equal(fs.existsSync(fixture.destination), false, "failed download must not leave a final installer");
}

test("downloads and verifies an installer through an injected HTTPS response", async () => {
  const fixture = makeFixture();
  const bytes = Buffer.from("test installer bytes");
  const progress = [];
  const fake = requestWith(({ onResponse }) => sendResponse(onResponse, responseFor(bytes), bytes));
  try {
    const result = await downloadVerifiedInstaller({
      asset: assetFor(bytes),
      destination: fixture.destination,
      onProgress: (value) => progress.push(value),
      requestImpl: fake.requestImpl,
      timeoutMs: 100,
    });

    assert.deepEqual(result, { file: fixture.destination, bytes: bytes.length, sha256: digest(bytes) });
    assert.equal(fs.readFileSync(fixture.destination).toString(), bytes.toString());
    assert.equal(fs.existsSync(fixture.temporary), false);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, "https://github.com/example/release/installer.exe");
    assert.ok(progress.some((item) => item.received === bytes.length && item.percent === 100));
  } finally { fixture.cleanup(); }
});

test("rejects an aborted response and removes partial bytes", async () => {
  const fixture = makeFixture();
  const bytes = Buffer.from("partial response");
  const fake = requestWith(({ onResponse }) => {
    const response = responseFor(bytes, { complete: false });
    onResponse(response);
    queueMicrotask(() => {
      response.write(bytes.subarray(0, 7));
      response.emit("aborted");
    });
  });
  try {
    await assert.rejects(
      downloadVerifiedInstaller({ asset: assetFor(bytes), destination: fixture.destination, requestImpl: fake.requestImpl, timeoutMs: 100 }),
      /update_download_interrupted/,
    );
    assertNoPartial(fixture);
  } finally { fixture.cleanup(); }
});

test("rejects a response stream error and removes partial bytes", async () => {
  const fixture = makeFixture();
  const bytes = Buffer.from("partial response");
  const failure = new Error("simulated socket reset");
  const fake = requestWith(({ onResponse }) => {
    const response = responseFor(bytes, { complete: false });
    onResponse(response);
    queueMicrotask(() => {
      response.write(bytes.subarray(0, 7));
      response.destroy(failure);
    });
  });
  try {
    await assert.rejects(
      downloadVerifiedInstaller({ asset: assetFor(bytes), destination: fixture.destination, requestImpl: fake.requestImpl, timeoutMs: 100 }),
      /simulated socket reset/,
    );
    assertNoPartial(fixture);
  } finally { fixture.cleanup(); }
});

test("cancels an active download and removes its partial file", async () => {
  const fixture = makeFixture();
  const bytes = Buffer.from("partial response");
  const controller = new AbortController();
  let responseStarted;
  const started = new Promise((resolve) => { responseStarted = resolve; });
  const fake = requestWith(({ onResponse }) => {
    const response = responseFor(bytes, { complete: false });
    onResponse(response);
    response.write(bytes.subarray(0, 7));
    responseStarted();
  });
  try {
    const download = downloadVerifiedInstaller({
      asset: assetFor(bytes),
      destination: fixture.destination,
      signal: controller.signal,
      requestImpl: fake.requestImpl,
      timeoutMs: 100,
    });
    await started;
    controller.abort(new Error("user_cancelled_update"));
    await assert.rejects(download, /user_cancelled_update/);
    assert.equal(fake.calls[0].request.destroyed, true, "cancellation destroys the active request");
    assertNoPartial(fixture);
  } finally { fixture.cleanup(); }
});

test("does not start a request when the download is already cancelled", async () => {
  const fixture = makeFixture();
  const bytes = Buffer.from("never downloaded");
  const controller = new AbortController();
  controller.abort(new Error("cancelled_before_start"));
  const fake = requestWith(() => assert.fail("pre-cancelled download must not make a request"));
  try {
    await assert.rejects(
      downloadVerifiedInstaller({ asset: assetFor(bytes), destination: fixture.destination, signal: controller.signal, requestImpl: fake.requestImpl }),
      /cancelled_before_start/,
    );
    assert.equal(fake.calls.length, 0);
    assertNoPartial(fixture);
  } finally { fixture.cleanup(); }
});

test("times out while the request has not established a response", async () => {
  const fixture = makeFixture();
  const bytes = Buffer.from("never downloaded");
  const fake = requestWith(() => {});
  try {
    await assert.rejects(
      downloadVerifiedInstaller({ asset: assetFor(bytes), destination: fixture.destination, requestImpl: fake.requestImpl, timeoutMs: 15 }),
      /update_download_timeout/,
    );
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].request.destroyed, true, "connection timeout destroys the request");
    assertNoPartial(fixture);
  } finally { fixture.cleanup(); }
});

test("removes a downloaded installer when its trusted checksum does not match", async () => {
  const fixture = makeFixture();
  const bytes = Buffer.from("downloaded but wrong");
  const asset = { ...assetFor(Buffer.from("expected installer")), url: "https://github.com/example/release/installer.exe" };
  const fake = requestWith(({ onResponse }) => sendResponse(onResponse, responseFor(bytes), bytes));
  try {
    await assert.rejects(
      downloadVerifiedInstaller({ asset, destination: fixture.destination, requestImpl: fake.requestImpl, timeoutMs: 100 }),
      /update_checksum_mismatch/,
    );
    assertNoPartial(fixture);
  } finally { fixture.cleanup(); }
});

test("rejects a redirect to a host outside the download allowlist", async () => {
  const fixture = makeFixture();
  const bytes = Buffer.from("redirect target");
  const fake = requestWith(({ onResponse }) => {
    const response = responseFor(Buffer.alloc(0), { statusCode: 302, location: "https://example.invalid/installer.exe" });
    sendResponse(onResponse, response);
  });
  try {
    await assert.rejects(
      downloadVerifiedInstaller({ asset: assetFor(bytes), destination: fixture.destination, requestImpl: fake.requestImpl, timeoutMs: 100 }),
      /update_untrusted_download_url/,
    );
    assert.equal(fake.calls.length, 1, "untrusted redirect is rejected before another request starts");
    assertNoPartial(fixture);
  } finally { fixture.cleanup(); }
});
