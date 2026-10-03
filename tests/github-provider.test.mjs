/** 中文：GitHub 适配器的错误、安全与不可变上传测试。 English: GitHub provider error and safety tests. */
import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubReadCache, GitHubReleaseProvider, githubRetryAt } from "../sync/github-provider.mjs";

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

test("GitHub authentication errors redact the access token", async () => {
  const token = "test-token-that-must-never-appear";
  const provider = new GitHubReleaseProvider({
    token,
    fetchImpl: async () => json({ message: `Bad credentials: ${token}` }, 401),
  });
  await assert.rejects(() => provider.getAuthenticatedUser(), (error) => {
    assert.equal(error.code, "github_auth_required");
    assert.equal(error.status, 401);
    assert.equal(String(error.message).includes(token), false);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test("GitHub sync refuses a public repository before creating a release", async () => {
  const calls = [];
  const provider = new GitHubReleaseProvider({
    token: "test-token",
    repository: "sync-repo",
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/user")) return json({ id: 1, login: "test-user", avatar_url: "" });
      if (String(url).includes("/repos/test-user/sync-repo")) return json({ id: 2, private: false, archived: false, disabled: false });
      throw new Error("unexpected request");
    },
  });
  await assert.rejects(() => provider.ensureReady(), (error) => error.code === "github_repository_public");
  assert.equal(calls.some((url) => url.includes("/releases")), false);
});

test("GitHub request timeouts use a stable user-facing error code", async () => {
  const provider = new GitHubReleaseProvider({
    token: "test-token",
    fetchImpl: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  await assert.rejects(() => provider.getAuthenticatedUser(), (error) => error.code === "github_timeout");
});

test("GitHub Release assets are immutable and duplicates never upload", async () => {
  let uploadCalls = 0;
  const provider = new GitHubReleaseProvider({
    token: "test-token",
    repository: "sync-repo",
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/user")) return json({ id: 1, login: "test-user", avatar_url: "" });
      if (target.endsWith("/repos/test-user/sync-repo")) return json({ id: 2, private: true, archived: false, disabled: false, html_url: "https://github.com/test-user/sync-repo" });
      if (target.endsWith("/releases/tags/cherry-sync")) return json({ id: 3, tag_name: "cherry-sync" });
      if (target.includes("/releases/3/assets?") && options.method !== "POST") return json([{ id: 4, name: "manifest-g000001-ssync_00000000-0000-0000-0000-000000000000.json", size: 2, created_at: new Date().toISOString() }]);
      if (options.method === "POST" && target.includes("uploads.github.com")) { uploadCalls += 1; return json({ id: 5, name: "uploaded", size: 2 }); }
      throw new Error(`unexpected request: ${target}`);
    },
  });
  await provider.ensureReady();
  await assert.rejects(
    () => provider.uploadAsset("manifest-g000001-ssync_00000000-0000-0000-0000-000000000000.json", Buffer.from("{}")),
    (error) => error.code === "github_immutable_asset_exists",
  );
  assert.equal(uploadCalls, 0);
});

test("GitHub Release asset catalogs are reused until a refresh is requested", async () => {
  let catalogCalls = 0;
  const provider = new GitHubReleaseProvider({
    token: "test-token",
    repository: "sync-repo",
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith("/user")) return json({ id: 1, login: "test-user", avatar_url: "" });
      if (target.endsWith("/repos/test-user/sync-repo")) return json({ id: 2, private: true, archived: false, disabled: false });
      if (target.endsWith("/releases/tags/cherry-sync")) return json({ id: 3, tag_name: "cherry-sync" });
      if (target.includes("/releases/3/assets?")) {
        catalogCalls += 1;
        return json([]);
      }
      throw new Error(`unexpected request: ${target}`);
    },
  });
  await provider.ensureReady();
  await provider.listAssets();
  await provider.listAssets();
  assert.equal(catalogCalls, 1);
  await provider.listAssets({ refresh: true });
  assert.equal(catalogCalls, 2);
});

test("shared read cache sends ETags and returns an isolated cached JSON value on 304", async () => {
  const readCache = createGitHubReadCache();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), etag: options.headers?.["if-none-match"] || "" });
    if (String(url).endsWith("/user")) {
      if (options.headers?.["if-none-match"] === 'W/"user-v1"') return new Response(null, { status: 304 });
      return json({ id: 7, login: "cached-user", avatar_url: "" }, 200, { etag: 'W/"user-v1"' });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const first = new GitHubReleaseProvider({ token: "test-token", fetchImpl, readCache });
  const firstUser = await first.getAuthenticatedUser();
  firstUser.login = "mutated-by-caller";
  const second = new GitHubReleaseProvider({ token: "test-token", fetchImpl, readCache });
  assert.deepEqual(await second.getAuthenticatedUser(), { id: "7", login: "cached-user", avatarUrl: "" });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].etag, 'W/"user-v1"');
});

test("JSON responses without an ETag are fetched again and are not cached", async () => {
  let userReads = 0;
  const provider = new GitHubReleaseProvider({
    token: "test-token",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/user")) return json({ id: 7, login: `user-${++userReads}`, avatar_url: "" });
      throw new Error(`unexpected request: ${url}`);
    },
  });
  assert.equal((await provider.getAuthenticatedUser()).login, "user-1");
  assert.equal((await provider.getAuthenticatedUser()).login, "user-2");
  assert.equal(userReads, 2);
});

test("raw asset cache returns Buffer copies and refresh evicts changed assets", async () => {
  const readCache = createGitHubReadCache();
  let updatedAt = "2026-10-01T00:00:00Z";
  let contents = Buffer.from("old");
  let assetReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/repos/test-user/sync-repo")) return json({ id: 2, private: true, archived: false, disabled: false });
    if (target.includes("/releases/3/assets?")) {
      return json([{ id: 4, name: "summary.json.gz", size: contents.length, created_at: "2026-09-01T00:00:00Z", updated_at: updatedAt }]);
    }
    if (target.endsWith("/releases/assets/4") && options.method !== "DELETE") {
      assetReads += 1;
      return new Response(contents);
    }
    if (target.endsWith("/releases/assets/4") && options.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected request: ${target}`);
  };
  const provider = new GitHubReleaseProvider({ token: "test-token", owner: "test-user", repository: "sync-repo", fetchImpl, readCache });
  provider.release = { id: 3 };
  const firstCatalog = await provider.listAssets({ refresh: true });
  const firstBytes = await provider.downloadAsset(firstCatalog[0]);
  firstBytes[0] = 0;
  assert.equal((await provider.downloadAsset(firstCatalog[0])).toString(), "old");
  assert.equal(assetReads, 1);

  updatedAt = "2026-10-02T00:00:00Z";
  contents = Buffer.from("new");
  const changedCatalog = await provider.listAssets({ refresh: true });
  assert.equal((await provider.downloadAsset(changedCatalog[0])).toString(), "new");
  assert.equal(assetReads, 2);

  await provider.deleteAsset(changedCatalog[0]);
  await provider.downloadAsset(changedCatalog[0]);
  assert.equal(assetReads, 3, "successful delete must evict cached bytes");
});

test("upload response is not inserted into the raw cache before verification download", async () => {
  const readCache = createGitHubReadCache();
  let uploadCalls = 0;
  let assetReads = 0;
  const provider = new GitHubReleaseProvider({
    token: "test-token",
    owner: "test-user",
    repository: "sync-repo",
    readCache,
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/repos/test-user/sync-repo")) return json({ id: 2, private: true, archived: false, disabled: false });
      if (target.endsWith("/releases/3/assets?per_page=100&page=1")) return json([]);
      if (target.includes("uploads.github.com")) {
        uploadCalls += 1;
        return json({ id: 9, name: "new-asset.bin", size: 3, created_at: "2026-10-01T00:00:00Z" });
      }
      if (target.endsWith("/releases/assets/9")) {
        assetReads += 1;
        return new Response(Buffer.from("new"));
      }
      throw new Error(`unexpected request: ${target}`);
    },
  });
  provider.release = { id: 3 };
  const uploaded = await provider.uploadAsset("new-asset.bin", Buffer.from("new"));
  assert.equal(uploadCalls, 1);
  assert.equal(assetReads, 0);
  assert.equal((await provider.downloadAsset(uploaded)).toString(), "new");
  assert.equal(assetReads, 1);
});

test("GitHub rate-limit and transient errors produce bounded retry timestamps", () => {
  const now = Date.UTC(2026, 9, 4, 0, 0, 0);
  assert.equal(githubRetryAt({ status: 403, rateRemaining: "0", retryAfter: "120", rateReset: String((now + 90_000) / 1000) }, now), now + 120_000);
  assert.equal(githubRetryAt({ status: 429, rateReset: String((now + 180_000) / 1000) }, now), now + 180_000);
  assert.equal(githubRetryAt({ status: 403, message: "You have exceeded a secondary rate limit" }, now), now + 60_000);
  assert.equal(githubRetryAt({ code: "github_network_error" }, now, 3), now + 240_000);
  assert.equal(githubRetryAt({ status: 503 }, now, 30), now + 15 * 60_000);
  assert.equal(githubRetryAt({ status: 403, message: "Resource not accessible by integration" }, now), 0);
  assert.equal(githubRetryAt({ status: 401, code: "github_auth_required" }, now), 0);
});

test("GitHub provider errors preserve the rate-limit reset header", async () => {
  const provider = new GitHubReleaseProvider({
    token: "test-token",
    fetchImpl: async () => json({ message: "API rate limit exceeded" }, 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1791072000",
    }),
  });
  await assert.rejects(() => provider.getAuthenticatedUser(), (error) => {
    assert.equal(error.rateRemaining, "0");
    assert.equal(error.rateReset, "1791072000");
    return true;
  });
});

test("a shared read cache refuses reuse by another credential or repository", () => {
  const readCache = createGitHubReadCache();
  new GitHubReleaseProvider({ token: "account-a", owner: "owner-a", repository: "repo-a", readCache });
  for (const options of [{ token: "account-b", owner: "owner-a", repository: "repo-a" }, { token: "account-a", owner: "owner-b", repository: "repo-a" }, { token: "account-a", owner: "owner-a", repository: "repo-b" }]) {
    assert.throws(() => new GitHubReleaseProvider({ ...options, readCache }), /github_read_cache_scope_mismatch/);
  }
});
