import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release version, installer name, and isolated build output agree", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));

  assert.equal(pkg.version, "1.40.2");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(pkg.build.win.artifactName, "Cherry-AI-Connect-Setup-${version}.${ext}");
  assert.equal(pkg.build.directories.output, "dist/current-build");
});

test("prepare-dist preserves existing release assets and clears only isolated build output", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-prepare-dist-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const dist = path.join(fixture, "dist");
  const build = path.join(dist, "current-build");
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, "stale-installer.exe"), "stale");
  fs.writeFileSync(path.join(dist, "Cherry-AI-Connect-Setup-1.37.exe"), "historical");
  fs.writeFileSync(path.join(dist, "Cherry-AI-Connect-Web-Demo-1.37.zip"), "historical");

  const result = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "prepare-dist.mjs")], {
    cwd: fixture,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(build, "stale-installer.exe")), false);
  assert.equal(fs.readFileSync(path.join(dist, "Cherry-AI-Connect-Setup-1.37.exe"), "utf8"), "historical");
  assert.equal(fs.readFileSync(path.join(dist, "Cherry-AI-Connect-Web-Demo-1.37.zip"), "utf8"), "historical");
});
