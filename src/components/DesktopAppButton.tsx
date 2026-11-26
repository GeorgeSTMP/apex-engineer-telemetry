import { MonitorDown } from 'lucide-react';
import {
  DESKTOP_BUNDLE_DOWNLOAD_URL,
  DESKTOP_BUNDLE_FILENAME,
  isNativeDesktopShell,
} from '../utils/desktopShell';

export function DesktopAppButton() {
  if (isNativeDesktopShell()) {
    return null;
  }

  return (
    <a
      href={DESKTOP_BUNDLE_DOWNLOAD_URL}
      download={DESKTOP_BUNDLE_FILENAME}
      data-testid="desktop-app-download-btn"
      title="Download native Windows ApexEngineer.exe (fast launch, no Chrome window)"
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#273145] bg-[#0F1420] px-2 sm:px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-300 cursor-pointer whitespace-nowrap shrink-0"
    >
      <MonitorDown className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
      <span className="hidden sm:inline">Get .exe App</span>
      <span className="sm:hidden">.exe</span>
    </a>
  );
}
