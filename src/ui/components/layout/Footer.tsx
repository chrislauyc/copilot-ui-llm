import React from 'react';
import { ShieldCheck } from 'lucide-react';

interface FooterProps {
  setIsDiagnosticsModalOpen: (open: boolean) => void;
}

export function Footer({ setIsDiagnosticsModalOpen }: FooterProps) {
  return (
    <footer className="bg-[#131314] border-t border-zinc-800/80 py-3 shrink-0 select-none">
      <div className="max-w-7xl mx-auto px-4 text-center text-[11px] text-zinc-500 dark:text-zinc-400 flex flex-col sm:flex-row items-center justify-between gap-2.5">
        <div>
          <span>© 2026 Developer Laboratory Team. All rights reserved. Read-Only Diagnostics mode.</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            id="btn-diagnostics-modal"
            onClick={() => setIsDiagnosticsModalOpen(true)}
            className="px-2.5 py-1 text-xs bg-zinc-800/50 hover:bg-zinc-800 dark:bg-zinc-900/60 dark:hover:bg-zinc-800/60 text-emerald-600 dark:text-emerald-400 font-bold rounded-lg border border-zinc-700/60 transition-all flex items-center gap-1 cursor-pointer"
          >
            <ShieldCheck size={13} />
            <span>Sandbox Diagnostics</span>
          </button>
          <span className="font-medium hidden xs:inline">Secure Sandbox Viewer</span>
        </div>
      </div>
    </footer>
  );
}
