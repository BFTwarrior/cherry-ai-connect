// Stream one already-verified release asset; never print or persist the GitHub credential.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const [releaseId, file] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!/^\d+$/.test(releaseId || "") || !file || !token) {
  throw new Error("Usage: GITHUB_TOKEN=<credential> node scripts/upload-release-asset.mjs <release-id> <file>");
}

const size = fs.statSync(file).size;
const name = path.basename(file);
const url = new URL(`https://uploads.github.com/repos/BFTwarrior/cherry-ai-connect/releases/${releaseId}/assets`);
url.searchParams.set("name", name);
const request = https.request(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Cherry-AI-Connect-Release",
    "Content-Type": "application/octet-stream",
    "Content-Length": size,
    "X-GitHub-Api-Version": "2022-11-28",
  },
}, (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    if (response.statusCode !== 201) {
      console.error(`UPLOAD_FAILED HTTP=${response.statusCode} BODY=${body.slice(0, 500)}`);
      process.exitCode = 1;
      return;
    }
    const asset = JSON.parse(body);
    console.log(`UPLOADED=${asset.name} SIZE=${asset.size} STATE=${asset.state} DIGEST=${asset.digest || "pending"}`);
  });
});

request.setTimeout(900000, () => request.destroy(new Error("upload_timeout")));
request.on("error", (error) => { console.error(`UPLOAD_ERROR=${error.message}`); process.exitCode = 1; });
const stream = fs.createReadStream(file);
let reported = 0;
stream.on("data", (chunk) => {
  reported += chunk.length;
  if (reported - (stream.lastProgress || 0) >= 10_000_000) {
    stream.lastProgress = reported;
    console.log(`UPLOADING=${name} BYTES=${reported}/${size}`);
  }
});
stream.on("error", (error) => request.destroy(error));
stream.pipe(request);
