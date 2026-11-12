/** V1.41 budgets 5 decimal MB for the bundled native protocol worker above
 * V1.40's 100 MB installer gate. Keep the increase explicit and bounded. */
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const artifact = path.resolve(projectRoot, "dist", "current-build", `Cherry-AI-Connect-Setup-${packageJson.version}.exe`);
const maxBytes = 105_000_000;
if (path.dirname(artifact) !== path.resolve(projectRoot, "dist", "current-build")) throw new Error("unsafe_installer_path");
if (!fs.existsSync(artifact)) throw new Error(`installer_missing:${artifact}`);
const size = fs.statSync(artifact).size;
if (size > maxBytes) throw new Error(`installer_size_limit_exceeded:${size}>${maxBytes}`);
console.log(`Verified installer size: ${size} bytes <= ${maxBytes} bytes (${artifact})`);
