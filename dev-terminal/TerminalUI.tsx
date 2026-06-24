/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { Terminal as TerminalIcon, ShieldAlert, Cpu, HardDrive, Network } from 'lucide-react';
import { motion } from 'framer-motion';

interface TerminalUIProps {
  onClose?: () => void;
}

export default function TerminalUI({ onClose }: TerminalUIProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [cwd, setCwd] = useState('~/workspace');
  const [isExecuting, setIsExecuting] = useState(false);
  const isExecutingRef = useRef(false);
  const cwdRef = useRef('~/workspace');
  const sessionId = useRef(Math.random().toString(36).substring(7));

  useEffect(() => {
    isExecutingRef.current = isExecuting;
  }, [isExecuting]);

  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", monospace',
      theme: {
        background: '#0C0C0C',
        foreground: '#00FF41',
        cursor: '#00FF41',
        selectionBackground: 'rgba(0, 255, 65, 0.3)',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Safety wrapper for fit
    const safeFit = () => {
      try {
        if (terminalRef.current && terminalRef.current.clientWidth > 0 && fitAddonRef.current) {
          fitAddon.fit();
        }
      } catch (e) {
        console.warn('Fit failed', e);
      }
    };

    setTimeout(safeFit, 100);

    term.writeln('\x1b[1;32mWorkspace Terminal v1.0.0\x1b[0m');
    term.writeln('\x1b[33mWarning: Direct Backend Execution Enabled. No security filters.\x1b[0m');
    term.writeln('---------------------------------------------------------');
    term.write('\r\n\x1b[1;34m' + cwdRef.current + '\x1b[0m $ ');

    let currentLine = '';

    const dataListener = term.onData(async (data) => {
      if (isExecutingRef.current) return;

      const code = data.charCodeAt(0);
      if (code === 13) { // Enter
        term.write('\r\n');
        const cmdToExec = currentLine.trim();
        if (cmdToExec) {
          setIsExecuting(true);
          try {
            const response = await fetch('/api/exec', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command: cmdToExec, sessionId: sessionId.current }),
            });
            const result = await response.json();
            
            if (result.stdout) term.write(result.stdout.replace(/\n/g, '\r\n'));
            if (result.stderr) term.write('\x1b[31m' + result.stderr.replace(/\n/g, '\r\n') + '\x1b[0m');
            
            if (result.currentCwd) {
               setCwd(result.currentCwd);
               cwdRef.current = result.currentCwd;
            }
          } catch (error) {
            term.write('\x1b[31mExecution error: ' + error + '\x1b[0m');
          }
          setIsExecuting(false);
        }
        currentLine = '';
        term.write('\x1b[1;34m' + cwdRef.current + '\x1b[0m $ ');
      } else if (code === 127) { // Backspace
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          term.write('\b \b');
        }
      } else if (code < 32) {
         // Ignore other control characters
      } else {
        currentLine += data;
        term.write(data);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      safeFit();
    });
    
    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    return () => {
      resizeObserver.disconnect();
      dataListener.dispose();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  return (
    <div className="h-screen bg-[#0C0C0C] flex flex-col font-mono text-[#E0E0E0] overflow-hidden">
      <header className="border-b border-[#333] p-4 flex items-center justify-between bg-[#111] z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#00FF41]/10 rounded border border-[#00FF41]/30">
            <TerminalIcon className="w-5 h-5 text-[#00FF41]" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight uppercase text-white">System Core Terminal</h1>
            <p className="text-[10px] text-[#00FF41]/60 font-medium">BACKEND_ACCESS: GRANTED</p>
          </div>
        </div>

        <div className="flex gap-6 items-center">
          <div className="hidden md:flex gap-4">
            <div className="flex items-center gap-2">
               <Cpu className="w-3 h-3 text-[#00FF41]" />
               <span className="text-[10px] opacity-60">CPU: STABLE</span>
            </div>
            <div className="flex items-center gap-2">
               <HardDrive className="w-3 h-3 text-[#00FF41]" />
               <span className="text-[10px] opacity-60">MEMORY: 64%</span>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 py-1 bg-red-950/30 border border-red-500/30 rounded-full">
            <ShieldAlert className="w-3 h-3 text-red-500" />
            <span className="text-[9px] font-bold text-red-500">UNSECURED_CHANNEL</span>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-[#222] hover:bg-[#333] border border-[#444] hover:border-[#666] text-[#00FF41] font-mono text-xs font-bold rounded cursor-pointer transition-all uppercase tracking-tight flex items-center gap-1.5"
            >
              [Exit_Terminal]
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 relative flex flex-col min-h-0">
        <div className="absolute inset-0 opacity-5 pointer-events-none overflow-hidden">
          <div className="w-full h-full" style={{ 
            backgroundImage: 'radial-gradient(#00FF41 1px, transparent 1px)', 
            backgroundSize: '24px 24px' 
          }} />
        </div>

        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex-1 relative z-10 flex flex-col bg-black/80 backdrop-blur-sm min-h-0"
        >
          <div className="bg-[#1a1a1a] border-b border-[#333] px-4 py-2 flex items-center justify-between">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-[#333]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#333]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#333]" />
            </div>
            <div className="text-[10px] text-[#00FF41]/40 flex items-center gap-2">
              <Network className="w-3 h-3" />
              SESSION: {sessionId.current}
            </div>
          </div>

          <div className="flex-1 p-2 bg-[#0C0C0C] relative min-h-0">
             <div ref={terminalRef} className="absolute inset-0" id="xterm-container" />
          </div>
          
          <div className="bg-[#111] border-t border-[#333] px-4 py-1.5 flex items-center space-x-4 shrink-0">
             <div className="text-[10px] opacity-40 uppercase">Connection: Localhost</div>
             <div className="w-1 h-1 rounded-full bg-[#00FF41] animate-pulse" />
             <div className="flex-1" />
             <div className="text-[10px] text-[#00FF41]/80 truncate max-w-md">{cwd}</div>
          </div>
        </motion.div>
        
        <div className="absolute inset-0 pointer-events-none opacity-[0.03] overflow-hidden">
          <div className="w-full h-[2px] bg-white animate-scanline" style={{ 
            animation: 'scanline 8s linear infinite',
            boxShadow: '0 0 20px 2px white'
          }} />
        </div>
      </main>

      <style>{`
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }
        .xterm-viewport::-webkit-scrollbar {
          width: 8px;
        }
        .xterm-viewport::-webkit-scrollbar-track {
          background: #0C0C0C;
        }
        .xterm-viewport::-webkit-scrollbar-thumb {
          background: #333;
          border-radius: 4px;
        }
        .xterm-viewport::-webkit-scrollbar-thumb:hover {
          background: #444;
        }
      `}</style>
    </div>
  );
}
