/**
 * 中文：GitHub 私有仓库 + 固定 Release 的云端适配器。Token 只用于请求头，不写日志和对象。
 * English: Private-repository and fixed-Release GitHub adapter. Tokens never enter logs or cloud payloads.
 */
const API_ROOT = "https://api.github.com";
const UPLOAD_ROOT = "https://uploads.github.com";
const RELEASE_TAG = "cherry-sync";

export class GitHubProviderError extends Error {
  constructor(code, message, { status = 0, retryAfter = "", rateRemaining = "" } = {}) {
    super(message);
    this.name = "GitHubProviderError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.rateRemaining = rateRemaining;
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
  constructor({ token, owner = "", repository = "cherry-ai-connect-sync", fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (!token) throw new Error("github_token_required");
    if (typeof fetchImpl !== "function") throw new Error("github_fetch_required");
    this.token = String(token);
    this.owner = String(owner || "");
    this.repository = safeRepositoryName(repository);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.account = null;
    this.release = null;
  }

  async #request(pathname, { method = "GET", body, raw = false, upload = false, contentType = "application/vnd.github+json" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const root = upload ? UPLOAD_ROOT : API_ROOT;
    const headers = {
      accept: raw ? "application/octet-stream" : "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "user-agent": "Cherry-AI-Connect",
      "x-github-api-version": "2022-11-28",
    };
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
        });
      }
      if (raw) return bytes;
      if (!bytes.length) return null;
      try { return JSON.parse(bytes.toString("utf8")); }
      catch { throw new GitHubProviderError("github_invalid_response", "GitHub returned invalid JSON", { status: response.status }); }
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

  async listAssets() {
    const release = await this.#readyRelease();
    const assets = [];
    for (let page = 1; page <= 10; page += 1) {
      const items = await this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases/${release.id}/assets?per_page=100&page=${page}`);
      for (const item of items || []) assets.push({ id: item.id, name: String(item.name), size: Number(item.size || 0), createdAt: String(item.created_at || ""), updatedAt: String(item.updated_at || "") });
      if (!Array.isArray(items) || items.length < 100) break;
    }
    return assets;
  }

  async downloadAsset(asset) {
    if (!Number.isSafeInteger(Number(asset?.id))) throw new Error("github_invalid_asset");
    return this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases/assets/${Number(asset.id)}`, { raw: true });
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
    return { id: result.id, name: String(result.name), size: Number(result.size || 0), createdAt: String(result.created_at || "") };
  }

  async deleteAsset(asset) {
    if (!Number.isSafeInteger(Number(asset?.id))) throw new Error("github_invalid_asset");
    await this.#request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/releases/assets/${Number(asset.id)}`, { method: "DELETE" });
  }
}

export const githubSyncReleaseTag = RELEASE_TAG;
