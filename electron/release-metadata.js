/**
 * 中文：从 GitHub Release 页面提取更新器所需的公开元数据。
 * 这里不负责下载或信任安装包；它只负责找到官方资产地址和发布者公开的 SHA-256。
 * English: Extract public metadata required by the updater from a GitHub Release page.
 * This module never downloads or trusts an installer; it only locates the official asset
 * and the SHA-256 published by the release owner.
 */

const INSTALLER_NAME_PATTERN = /^Cherry-AI-Connect-Setup-[0-9.]+\.exe$/i;

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(html) {
  return decodeHtml(String(html || "").replace(/<[^>]*>/g, " "));
}

function releaseBodySha256(body) {
  // 中文：兼容 Release 正文、页面 HTML 和常见的 SHA-256 / SHA256 写法。
  // English: Accept release Markdown, rendered HTML, and common SHA-256 / SHA256 forms.
  const text = htmlToText(body);
  return text.match(/SHA\s*-?\s*256\s*[:：]\s*`?([a-f0-9]{64})/i)?.[1]?.toLowerCase() || "";
}

function releasePageMetadata(html) {
  const source = String(html || "");
  const expandedAssetsUrl = source.match(/<include-fragment[^>]*\ssrc=["']([^"']+\/releases\/expanded_assets\/[^"']+)["']/i)?.[1] || "";
  const publishedAt = source.match(/<relative-time[^>]*\sdatetime=["']([^"']+)["']/i)?.[1] || "";
  return {
    expandedAssetsUrl: decodeHtml(expandedAssetsUrl),
    publishedAt,
    sha256: releaseBodySha256(source),
  };
}

function expandedReleaseAsset(html, fallbackSha256 = "") {
  const source = String(html || "");
  const href = source.match(/href=["'](\/BFTwarrior\/cherry-ai-connect\/releases\/download\/[^"']+\/(Cherry-AI-Connect-Setup-[0-9.]+\.exe))["']/i);
  if (!href) return null;
  const name = decodeHtml(href[2]);
  if (!INSTALLER_NAME_PATTERN.test(name)) return null;
  const digest = source.match(/sha256\s*:\s*([a-f0-9]{64})/i)?.[1]?.toLowerCase() || fallbackSha256;
  const url = new URL(decodeHtml(href[1]), "https://github.com");
  if (url.origin !== "https://github.com" || !url.pathname.startsWith("/BFTwarrior/cherry-ai-connect/releases/download/")) return null;
  return {
    name,
    url: url.toString(),
    size: 0,
    sha256: digest,
  };
}

module.exports = {
  expandedReleaseAsset,
  releaseBodySha256,
  releasePageMetadata,
};
