import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(join(desktopRoot, path), 'utf8');
const windowGlobals = new Set(['location', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'addEventListener', 'removeEventListener', 'document', 'console']);
const failures = [];

const preload = read('dist-electron/preload.js');
const bridgeKey = preload.match(/exposeInMainWorld\(\s*["']([^"']+)["']/)?.[1];
if (!bridgeKey) failures.push('dist-electron/preload.js has no contextBridge.exposeInMainWorld call');

const apiObject = preload.match(/const api\s*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
const apiMethods = new Set([...apiObject.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]));
if (apiMethods.size === 0) failures.push('dist-electron/preload.js exposes an API with no methods');

const mainProcess = read('dist-electron/main.js');
const splashScript = mainProcess.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
if (!splashScript) {
  failures.push('dist-electron/main.js has no startup splash script');
} else {
  for (const key of new Set([...splashScript.matchAll(/window\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))) {
    if (key !== bridgeKey && !windowGlobals.has(key)) {
      failures.push(`startup splash reads window.${key}, but the preload exposes window.${bridgeKey}`);
    }
  }
}

const renderer = read('dist-renderer/renderer.js');
const rendererWindowKeys = new Set([...renderer.matchAll(/window\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
if (bridgeKey && !rendererWindowKeys.has(bridgeKey)) failures.push(`renderer never reads window.${bridgeKey}`);
for (const key of rendererWindowKeys) {
  if (apiMethods.has(key)) failures.push(`renderer calls window.${key} directly instead of window.${bridgeKey}.${key}`);
}

const runtimeDirectory = JSON.parse(read('package.json')).build?.extraResources?.[0]?.to;
if (!runtimeDirectory) {
  failures.push('package.json build.extraResources has no runtime directory');
} else if (!mainProcess.includes('process.resourcesPath') || !mainProcess.includes(`'${runtimeDirectory}'`)) {
  failures.push(`main process does not resolve runtime binaries from ${runtimeDirectory}`);
}

const stagedBinaries = new Set(
  [...read('scripts/stage-runtime.mjs').matchAll(/'([a-z]+-(?:analyzer|adapter)(?:\.exe)?)'/g)].map((m) => m[1]),
);
if (stagedBinaries.size < 2) {
  failures.push('scripts/stage-runtime.mjs does not stage an analyzer and an adapter binary');
}
for (const name of stagedBinaries) {
  if (!mainProcess.includes(`'${name.replace(/\.exe$/, '')}'`)) failures.push(`main process does not resolve the staged binary ${name}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log(`Bridge window.${bridgeKey}, the startup splash, the renderer and the ${runtimeDirectory} binaries agree.`);
