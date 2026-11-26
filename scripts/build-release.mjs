import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();
const releaseDir = path.join(rootDir, 'release', 'ApexEngineer');

console.log('1/4 Generating crisp multi-resolution app icons...');
execSync('node scripts/generate-icons.mjs', { stdio: 'inherit', cwd: rootDir });

console.log('2/4 Building frontend production bundle (Vite + PWA)...');
execSync('npx vite build', { stdio: 'inherit', cwd: rootDir });

console.log('3/4 Bundling standalone server (dist-server/server.cjs)...');
fs.mkdirSync(path.join(rootDir, 'dist-server'), { recursive: true });
execSync(
  'npx esbuild server.ts --bundle --platform=node --format=cjs --target=node20 --external:vite --outfile=dist-server/server.cjs',
  { stdio: 'inherit', cwd: rootDir }
);

console.log('4/4 Assembling clean release folder (release/ApexEngineer)...');
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

const filesToCopy = [
  '00_ADD_API_KEY_HERE.txt',
  '01_START_HERE.txt',
  'Create_Desktop_Shortcut.bat',
  '02_START_APEX_ENGINEER.bat',
  '03_START_LMU_BRIDGE.bat',
  '.env.example',
];

for (const file of filesToCopy) {
  const src = path.join(rootDir, file);
  const dest = path.join(releaseDir, file);
  if (fs.existsSync(src)) {
    if (file.endsWith('.bat') || file.endsWith('.txt')) {
      const content = fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n');
      fs.writeFileSync(dest, content, 'utf8');
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

// Copy native Windows desktop executable, WebView2 loader DLL, and .ico right at the root
const winArtifacts = [
  ['scripts/win/ApexEngineer.exe', 'ApexEngineer.exe'],
  ['scripts/win/webview2/WebView2Loader.dll', 'WebView2Loader.dll'],
  ['scripts/win/apex-engineer.ico', 'apex-engineer.ico'],
];

for (const [relSrc, destName] of winArtifacts) {
  const src = path.join(rootDir, relSrc);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(releaseDir, destName));
  } else {
    console.warn(`Warning: missing Windows artifact ${relSrc}`);
  }
}

for (const dir of ['dist', 'dist-server']) {
  const srcDir = path.join(rootDir, dir);
  if (fs.existsSync(srcDir)) {
    fs.cpSync(srcDir, path.join(releaseDir, dir), { recursive: true });
  }
}

// Copy only runtime helper scripts (exclude heavy C++ headers/sources from release ZIP)
const scriptsDest = path.join(releaseDir, 'scripts');
fs.mkdirSync(scriptsDest, { recursive: true });
for (const scriptFile of ['bootstrap-node.ps1', 'launch-desktop.ps1', 'lmu-bridge.mjs', 'win-sim-bridge.ps1']) {
  const src = path.join(rootDir, 'scripts', scriptFile);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(scriptsDest, scriptFile));
  }
}

console.log(`\nRelease ready at: ${releaseDir}`);
console.log('Launch directly with ApexEngineer.exe (no Chrome window, no npm install).');
