export const DESKTOP_BUNDLE_DOWNLOAD_URL = '/api/download-desktop-bundle';
export const DESKTOP_BUNDLE_FILENAME = 'ApexEngineer-Windows.zip';

/**
 * Returns true when running inside the native ApexEngineer.exe WebView2 desktop window
 * (which appends `ApexEngineerDesktop/1.0` to the User-Agent string) or standalone PWA mode.
 */
export function isNativeDesktopShell(userAgent?: string, isStandaloneDisplay?: boolean): boolean {
  const ua =
    userAgent ?? (typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '');
  if (/ApexEngineerDesktop\/\d+/i.test(ua)) {
    return true;
  }
  if (typeof isStandaloneDisplay === 'boolean') {
    return isStandaloneDisplay;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(display-mode: standalone)').matches;
  }
  return false;
}

/**
 * Validates that a binary buffer begins with a valid Windows ICO header (reserved=0, type=1, count>=1).
 */
export function isValidWindowsIcoHeader(bytes: Uint8Array): { valid: boolean; frameCount: number } {
  if (bytes.length < 22) {
    return { valid: false, frameCount: 0 };
  }
  const reserved = bytes[0] | (bytes[1] << 8);
  const type = bytes[2] | (bytes[3] << 8);
  const frameCount = bytes[4] | (bytes[5] << 8);
  return {
    valid: reserved === 0 && type === 1 && frameCount >= 1,
    frameCount,
  };
}
