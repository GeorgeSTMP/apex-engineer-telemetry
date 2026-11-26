import { useState } from 'react';
import { MonitorDown } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export function PWAInstallButton() {
  const { canPrompt, isInstalled, isIOS, promptInstall } = usePWAInstall();
  const [showTip, setShowTip] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (!canPrompt && !isIOS) {
    return null;
  }

  const handleClick = async () => {
    if (canPrompt) {
      await promptInstall();
      return;
    }
    setShowTip((v) => !v);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        data-testid="pwa-install-btn"
        title="Install as a standalone desktop application"
        className="inline-flex items-center gap-1.5 rounded-md border border-[#273145] bg-[#10141D] px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-200 cursor-pointer whitespace-nowrap shrink-0"
      >
        <MonitorDown className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
        <span>Install App</span>
      </button>

      {showTip && isIOS && (
        <div
          role="dialog"
          className="absolute right-0 top-full z-50 mt-2 w-64 rounded-md border border-[#273145] bg-[#0B0E15] p-3 text-xs text-slate-200 shadow-xl"
        >
          <p className="leading-relaxed">
            Tap Share in Safari and select &quot;Add to Home Screen&quot; to install.
          </p>
        </div>
      )}
    </div>
  );
}
