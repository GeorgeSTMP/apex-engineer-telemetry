import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_BUNDLE_DOWNLOAD_URL,
  DESKTOP_BUNDLE_FILENAME,
  isNativeDesktopShell,
  isValidWindowsIcoHeader,
} from './desktopShell';

test('isNativeDesktopShell detects ApexEngineerDesktop UA and standalone mode', () => {
  assert.equal(
    isNativeDesktopShell('Mozilla/5.0 (Windows NT 10.0; Win64; x64) ApexEngineerDesktop/1.0', false),
    true
  );
  assert.equal(
    isNativeDesktopShell('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/132.0.0.0', true),
    true
  );
  assert.equal(
    isNativeDesktopShell('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/132.0.0.0', false),
    false
  );
});

test('desktop download constants target portable Windows zip with ApexEngineer.exe', () => {
  assert.equal(DESKTOP_BUNDLE_DOWNLOAD_URL, '/api/download-desktop-bundle');
  assert.equal(DESKTOP_BUNDLE_FILENAME, 'ApexEngineer-Windows.zip');
});

test('generated public/apex-engineer.ico has valid multi-resolution ICO header', () => {
  const icoPath = path.join(process.cwd(), 'public', 'apex-engineer.ico');
  const buf = fs.readFileSync(icoPath);
  const parsed = isValidWindowsIcoHeader(buf);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.frameCount, 6);
});
