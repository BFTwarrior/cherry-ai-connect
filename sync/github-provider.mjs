/**
 * 中文：GitHub 私有仓库 + 固定 Release 的云端适配器。Token 只用于请求头，不写日志和对象。
 * English: Private-repository and fixed-Release GitHub adapter. Tokens never enter logs or cloud payloads.
 */
import crypto from "node:crypto";
const API_ROOT = "https://api.github.com";
const UPLOAD_ROOT = "https://uploads.github.com";
const RELEASE_TAG = "cherry-sync";
const MAX_RAW_CACHE_BYTES = 32 * 1024 * 1024;
const READ_CACHE_STATE = new WeakMap();

/**
 * 中文：创建可由同一凭证/仓库作用域内多个 Provider 共享的只读响应缓存。
 * English: Create a read-response cache shareable by providers scoped to one credential/repository.
 */
export function createGitHubReadCache() {
  const cache = Object.freeze({});
  READ_CACHE_STATE.set(cache, { json: new Map(), raw: new Map(), rawBytes: 0, assets: new Map() });
  return cache;
}

function cacheState(cache) {
  const state = READ_CACHE_STATE.get(cache);
  if (!state) throw new Error("github_read_cache_invalid");
  return state;
}

function cloneJson(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function rawAssetKey(asset) {
  return JSON.stringify([String(asset.id), String(asset.name || ""), Number(asset.size || 0), String(asset.updatedAt || "")]);
}

function evictRaw(state, key) {
  const entry = state.raw.get(key);
  if (!entry) return;
  state.raw.delete(key);
  state.rawBytes -= entry.bytes.length;
}

function cacheRawAsset(state, key, id, bytes) {
  if (bytes.length > MAX_RAW_CACHE_BYTES) return;
  evictRaw(state, key);
  state.raw.set(key, { id: String(id), bytes: Buffer.from(bytes) });
  state.rawBytes += bytes.length;
  while (state.rawBytes > MAX_RAW_CACHE_BYTES && state.raw.size) {
    const oldestKey = state.raw.keys().next().value;
    evictRaw(state, oldestKey);
  }
}

function refreshRawAssetMetadata(state, assets) {
  const next = new Map(assets.map((asset) => [String(asset.id), rawAssetKey(asset)]));
  for (const [id, oldKey] of state.assets) {
    if (next.get(id) !== oldKey) evictRaw(state, oldKey);
  }
  state.assets = next;
}

function parseRetryAfter(value, now) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(now, date) : 0;
}

/** Return the next retry time in epoch milliseconds, or 0 when this error is not retryable. */
export function githubRetryAt(error, now = Date.now(), failureCount = 1) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const status = Number(error?.status || 0);
  const remaining = String(error?.rateRemaining ?? "").trim();
  const message = String(error?.message || "");
  const secondaryLimit = /secondary\s+rate\s+limit|abuse\s+detection|abuse\s+rate\s+limit/i.test(message);
  const rateLimited = status === 429 || remaining === "0" || secondaryLimit || /API rate limit exceeded/i.test(message);
  const networkOrServer = status >= 500 || /^(github_network_error|github_timeout|github_server_error)$/.test(String(error?.code || ""));
  if (!rateLimited && !networkOrServer) return 0;

  const attempt = Math.max(1, Math.floor(Number(failureCount) || 1));
  const backoffMs = Math.min(15 * 60 * 1000, 60 * 1000 * (2 ** Math.min(attempt - 1, 20)));
  const minimumRetryAt = nowMs + backoffMs;
  if (!rateLimited) return minimumRetryAt;

  const retryAfterAt = parseRetryAfter(error?.retryAfter, nowMs);
  const resetSeconds = Number(error?.rateReset);
  const resetAt = Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : 0;
  return Math.max(minimumRetryAt, retryAfterAt, resetAt);
}

export class GitHubProviderError extends Error {
  constructor(code, message, { status = 0, retryAfter = "", rateRemaining = "", rateReset = "" } = {}) {
    super(message);
    this.name = "GitHubProviderError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.rateRemaining = rateRemaining;
    this.rateReset = rateReset;
  }
}

function safeRepositoryName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") throw new Error("github_invalid_repository_name");
  return name;
}

function statusCode(status) {
  if (status === 401) return "github_auth_required";
  if (status === 403) return "github_permission_or_rate_limit";
  if (status === 404) return "github_not_found";
  if (status === 409 || status === 412) return "github_conflict";
  if (status === 422) return "github_unprocessable";
  if (status === 429) return "github_rate_limit";
  if (status >= 500) return "github_server_error";
  return `github_http_${status}`;
}

function redactCredential(value, credential) {
  const text = String(value || "");
  const secret = String(credential || "");
  return secret ? text.split(secret).join("[redacted]") : text;
}

export class GitHubReleaseProvider {
  constructor({ token, owner = "", repository = "cherry-ai-connect-sync", fetchImpl = globalThis.fetch, timeoutMs = 15000, readCache = createGitHubReadCache() } = {}) {
    if (!token) throw new Error("github_token_required");
    if (typeof fetchImpl !== "function") throw new Error("github_fetch_required");
    this.token = String(token);
    this.owner = String(owner || "");
    this.repository = safeRepositoryName(repository);
    this.readCache = readCache;
    const state = cacheState(this.readCache);
    const scope = crypto.createHash("sha256").update(JSON.stringify([this.token, this.owner, this.repository])).digest("hex");
    if (state.scope && state.scope !== scope) throw new Error("github_read_cache_scope_mismatch");
    state.scope = scope;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.account = null;
    this.release = null;
    // 中文：资产清单只在当前同步轮次内复用；调用方可用 refresh 强制重新读取远端。
    // English: Reuse the asset catalog only for the current sync round; refresh forces a remote read.
    this.assetCache = null;
  }

  async #request(pathname, { method = "GET", body, raw = false, upload = false, contentType = "application/vnd.github+json", skipEtag = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const root = upload ? UPLOAD_ROOT : API_ROOT;
    const state = cacheState(this.readCache);
    const cacheableJsonGet = method === "GET" && !raw;
    const jsonCacheKey = `${root}${pathname}`;
    const cachedJson = cacheableJsonGet ? state.json.get(jsonCacheKey) : null;
    const headers = {
      accept: raw ? "application/octet-stream" : "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "user-agent": "Cherry-AI-Connect",
      "x-github-api-version": "2022-11-28",
    };
    if (cacheableJsonGet && !skipEtag && cachedJson?.etag) headers["if-none-match"] = cachedJson.etag;
    let payload;
    if (body !== undefined) {
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        payload = Buffer.from(body);
        headers["content-type"] = contentType;
      } else {
        payload = JSON.stringify(body);
        headers["content-type"] = "application/json";
      }
    }
    try {
      const response = await this.fetch(`${root}${pathname}`, { method, headers, body: payload, signal: controller.signal, redirect: "follow" });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.status === 304 && cacheableJsonGet) {
        if (cachedJson && !skipEtag) return cloneJson(cachedJson.value);
        if (skipEtag) throw new GitHubProviderError("github_invalid_response", "GitHub returned 304 without a cached representation", { status: 304 });
        // 中文：缓存已被清除但服务端仍返回 304 时，去掉条件头重试一次。
        // English: If the local representation disappeared, retry once without the condition.
        return this.#request(pathname, { method, body, raw, upload, contentType, skipEtag: true });
      }
      if (!response.ok) {
        let detail = "";
        try { detail = String(JSON.parse(bytes.toString("utf8"))?.message || ""); }
        catch {
          // 中文：GitHub 可能返回非 JSON 错误页；使用稳定的 HTTP 错误文本继续处理。
          // English: GitHub may return a non-JSON error page; continue with stable HTTP error
          // text instead of exposing parser details.
        }
        throw new GitHubProviderError(statusCode(response.status), redactCredential(detail || `GitHub HTTP ${response.status}`, this.token), {
          status: response.status,
          retryAfter: response.headers.get("retry-after") || "",
          rateRemaining: response.headers.get("x-ratelimit-remaining") || "",
          rateReset: response.headers.get("x-ratelimit-reset") || "",
        });
      }
      if (raw) return bytes;
      if (!bytes.length) {
        if (cacheableJsonGet) {
          const etag = response.headers.get("etag") || "";
          if (etag) state.json.set(jsonCacheKey, { etag, value: null });
          else state.json.delete(jsonCacheKey);
        }
        return null;
      }
      try {
        const value = JSON.parse(bytes.toString("utf8"));
        if (cacheableJsonGet) {
          const etag = response.headers.get("etag") || "";
          if (etag) state.json.set(jsonCacheKey, { etag, value: cloneJson(value) });
          else state.json.delete(jsonCacheKey);
        }
        return value;
      } catch (error) {
        if (cacheableJsonGet) state.json.delete(jsonCacheKey);
        throw new GitHubProviderError("github_invalid_response", "GitHub returned invalid JSON", { status: response.status });
      }
    } catch (error) {
      if (error instanceof GitHubProviderError) throw error;
      if (error?.name === "AbortError") throw new GitHubProviderError("github_timeout", "GitHub request timed out");
      throw new GitHubProviderError("github_network_error", redactCredential(error?.message || "GitHub network error", this.token));
    } finally { clearTimeout(timer); }
  }

  async getAuthenticatedUser() {
    const user = await this.#request("/user");
    if (!user?.login || !Number.isSafeInteger(user.id)) throw new GitHubProviderError("github_invalid_account", "GitHub account response is incomplete");
    this.account = { id: String(user.id), login: String(user.login), avatarUrl: String(user.avatar_url || "") };
    if (!this.owner) this.owner = this.account.login;
    return { ...this.account };
  }

  async #getRepository() {
    try { return await this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}`); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }

  async #ensureRepository() {
    let repository = await this.#getRepository();
    if (!repository) {
      if (!this.account || this.owner !== this.account.login) throw new GitHubProviderError("github_repository_missing", "The selected repository does not exist and cannot be auto-created for this owner");
      repository = await this.#request("/user/repos", {
        method: "POST",
        body: {
          name: this.repository,
          description: "Private synchronization storage for Cherry AI Connect. Do not edit or delete assets manually.",
          private: true,
          auto_init: true,
        },
      });
    }
    if (repository.private !== true) throw new GitHubProviderError("github_repository_public", "Sync is blocked because the repository is public", { status: 403 });
    if (repository.archived || repository.disabled) throw new GitHubProviderError("github_repository_read_only", "The sync repository is archived or disabled", { status: 403 });
    return repository;
  }

  async #ensureRelease() {
    try {
      this.release = await this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases/tags/${RELEASE_TAG}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      this.release = await this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases`, {
        method: "POST",
        body: {
          tag_name: RELEASE_TAG,
          name: "Cherry AI Connect private sync data",
          body: "Managed automatically by Cherry AI Connect. Do not edit or delete individual assets.",
          draft: false,
          prerelease: false,
        },
      });
    }
    if (!Number.isSafeInteger(this.release?.id)) throw new GitHubProviderError("github_release_invalid", "GitHub Release is unavailable");
    return this.release;
  }

  async ensureReady() {
    await this.getAuthenticatedUser();
    const repository = await this.#ensureRepository();
    await this.#ensureRelease();
    return {
      account: { ...this.account },
      owner: this.owner,
      repository: this.repository,
      repositoryId: String(repository.id || ""),
      private: true,
      releaseId: String(this.release.id),
      releaseTag: RELEASE_TAG,
      htmlUrl: String(repository.html_url || ""),
    };
  }

  async #readyRelease() {
    if (!this.release?.id) await this.ensureReady();
    const repository = await this.#getRepository();
    if (!repository || repository.private !== true) throw new GitHubProviderError("github_repository_public", "Sync repository is missing or public", { status: 403 });
    return this.release;
  }

  async listAssets({ refresh = false } = {}) {
    if (!refresh && this.assetCache) return this.assetCache.map((item) => ({ ...item }));
    const release = await this.#readyRelease();
    const assets = [];
    for (let page = 1; page <= 100; page += 1) {
      const items = await this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases/${release.id}/assets?per_page=100&page=${page}`);
      for (const item of items || []) assets.push({ id: item.id, name: String(item.name), size: Number(item.size || 0), createdAt: String(item.created_at || ""), updatedAt: String(item.updated_at || "") });
      if (!Array.isArray(items) || items.length < 100) break;
      // Never hand GC an incomplete catalog: unknown manifests may protect files.
      if (page === 100) throw new GitHubProviderError("github_asset_listing_limit", "Sync asset catalog is too large to inspect safely");
    }
    refreshRawAssetMetadata(cacheState(this.readCache), assets);
    this.assetCache = assets;
    return assets.map((item) => ({ ...item }));
  }

  async downloadAsset(asset) {
    if (!Number.isSafeInteger(Number(asset?.id))) throw new Error("github_invalid_asset");
    const key = rawAssetKey(asset);
    const state = cacheState(this.readCache);
    const cached = state.raw.get(key);
    if (cached) {
      state.raw.delete(key);
      state.raw.set(key, cached);
      return Buffer.from(cached.bytes);
    }
    const bytes = await this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases/assets/${Number(asset.id)}`, { raw: true });
    cacheRawAsset(state, key, asset.id, bytes);
    state.assets.set(String(asset.id), key);
    return Buffer.from(bytes);
  }

  async uploadAsset(name, bytes) {
    const release = await this.#readyRelease();
    const safeName = String(name || "");
    if (!/^[A-Za-z0-9._-]{1,240}$/.test(safeName)) throw new Error("github_invalid_asset_name");
    if ((await this.listAssets()).some((item) => item.name === safeName)) throw new GitHubProviderError("github_immutable_asset_exists", "An immutable asset with this name already exists", { status: 422 });
    const result = await this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases/${release.id}/assets?name=${encodeURIComponent(safeName)}`, {
      method: "POST",
      body: Buffer.from(bytes),
      upload: true,
      contentType: "application/octet-stream",
    });
    const uploaded = { id: result.id, name: String(result.name), size: Number(result.size || 0), createdAt: String(result.created_at || "") };
    // 中文：上传资产首次仍由同步引擎下载验证；这里只维护目录，不预填原始字节缓存。
    // English: The engine must perform the first post-upload download verification; never prefill raw bytes.
    cacheState(this.readCache).assets.set(String(uploaded.id), rawAssetKey(uploaded));
    this.assetCache = [...(this.assetCache || []), uploaded];
    return { ...uploaded };
  }

  async deleteAsset(asset) {
    if (!Number.isSafeInteger(Number(asset?.id))) throw new Error("github_invalid_asset");
    await this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases/assets/${Number(asset.id)}`, { method: "DELETE" });
    if (this.assetCache) this.assetCache = this.assetCache.filter((item) => Number(item.id) !== Number(asset.id));
    const state = cacheState(this.readCache);
    const oldKey = state.assets.get(String(asset.id));
    if (oldKey) evictRaw(state, oldKey);
    state.assets.delete(String(asset.id));
  }
}

export const githubSyncReleaseTag = RELEASE_TAG;
