/** 中文：GitHub 适配器的错误、安全与不可变上传测试。 English: GitHub provider error and safety tests. */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReleaseProvider } from "../sync/github-provider.mjs";

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
