import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export const deploymentPaths = [
  "package.json", "package-lock.json", "vercel.json", ".vercelignore",
  "index.html", "styles.css", "app.js", "document-preview.js", "upload-limits.js",
  "template-store.js", "library-ui.js", "library-proxy.mjs",
  "server.mjs", "settings-model.js", "settings-analyzer.mjs", "hwpx-generator.mjs", "hwpx-validation.mjs",
  "api/index.mjs", "scripts/build-web.mjs", "assets/hwpx/basic-report.hwpx",
];
if (process.argv[1]?.endsWith("deployment-files.mjs")) {
  const index = Number(process.argv[2]);
  const file = deploymentPaths[index];
  if (!file) throw new Error("Invalid deployment file index");
  const bytes = await readFile(new URL(`../${file}`, import.meta.url));
  console.log(JSON.stringify({ file, sha: createHash("sha1").update(bytes).digest("hex"), size: bytes.length, data: bytes.toString("base64") }));
}
