import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = new URL("../", import.meta.url);
const output = new URL("dist/", root);
const files = ["index.html", "styles.css", "app.js", "settings-model.js", "document-preview.js", "upload-limits.js", "template-store.js", "library-ui.js"];
export function versionWebAssets(sources) {
  const hash=createHash('sha256');for(const [name,content] of sources)hash.update(name+'\0'+content+'\0');
  const version=hash.digest('hex').slice(0,16);
  const assets=new Map();
  for(const [name,content] of sources){
    let result=content;
    if(name.endsWith('.js'))result=result.replace(/(\bfrom\s*|\bimport\s*)(["'])(\.\/[A-Za-z0-9-]+\.js)\2/g,(match,prefix,quote,path)=>sources.has(path.slice(2))?`${prefix}${quote}${path}?v=${version}${quote}`:match);
    if(name==='index.html')result=result.replace(/(src|href)="(app\.js|styles\.css)"/g,`$1="$2?v=${version}"`).replace('</head>',`<meta name="hanform-build" content="${version}" />\n  </head>`);
    assets.set(name,result);
  }
  return {version,assets};
}

export async function buildWeb() {
await mkdir(output, { recursive: true });
// Remove the obsolete generated login bundle from earlier local builds.
await rm(new URL("auth.bundle.js", output), { force: true });
// Fail closed if an unrelated output exists; don't delete unknown user files.
for (const name of await readdir(output)) if (!files.includes(name)) throw new Error(`Unexpected public build output: ${name}`);
const sources=new Map(await Promise.all(files.map(async file=>[file,await readFile(new URL(file,root),'utf8')])));
const {version,assets}=versionWebAssets(sources);
await Promise.all([...assets].map(([file,content])=>writeFile(new URL(file,output),content)));
console.log(`Built ${files.length} allowlisted public files · ${version}. Documents, keys, server code and templates are not public.`);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildWeb();
