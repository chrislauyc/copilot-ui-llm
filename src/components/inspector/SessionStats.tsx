import React, { useMemo } from 'react';
import { Activity } from 'lucide-react';
import { CopilotEvent } from '../../mockEvents';

// Helper to recursively find totalNanoAiu in any nested config/payload
function findTotalNanoAiu(obj: any): number {
  if (!obj || typeof obj !== 'object') return 0;
  
  if (obj.totalNanoAiu !== undefined && (typeof obj.totalNanoAiu === 'number' || typeof obj.totalNanoAiu === 'string')) {
    const val = typeof obj.totalNanoAiu === 'number' ? obj.totalNanoAiu : parseFloat(obj.totalNanoAiu);
    if (!isNaN(val)) return val;
  }

  if (obj.copilotUsage?.totalNanoAiu !== undefined) {
    const val = typeof obj.copilotUsage.totalNanoAiu === 'number' 
      ? obj.copilotUsage.totalNanoAiu 
      : parseFloat(obj.copilotUsage.totalNanoAiu);
    if (!isNaN(val)) return val;
  }

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        const res = findTotalNanoAiu(obj[key]);
        if (res > 0) return res;
      }
    }
  }
  return 0;
}

interface SessionStatsProps {
  bundledEvents: CopilotEvent[];
}

export function SessionStats({ bundledEvents }: SessionStatsProps) {
  const stats = useMemo(() => {
    const events = bundledEvents;
    const toolsCount = events.filter(e => e.sessionEvent.type === 'tool.execution_start').length;
    const errorsCount = events.filter(e => e.sessionEvent.type === 'session.error').length;
    const permissionsCount = events.filter(e => e.sessionEvent.type === 'permission.requested').length;
    
    let totalLatency = 0;
    let totalNanoAiu = 0;
    events.forEach(e => {
      if (e.sessionEvent.type === 'tool.execution_complete' && 'toolTelemetry' in e.sessionEvent.data && typeof e.sessionEvent.data.toolTelemetry === 'object' && e.sessionEvent.data.toolTelemetry !== null) {
        const telemetry = (e.sessionEvent.data.toolTelemetry as { executionTimeMs?: number });
        if (telemetry.executionTimeMs) totalLatency += telemetry.executionTimeMs;
      }
      
      const eventNano = findTotalNanoAiu(e);
      totalNanoAiu += eventNano;
    });

    const creditUsed = totalNanoAiu * 1e-9;

    return {
      total: events.length,
      tools: toolsCount,
      errors: errorsCount,
      permissions: permissionsCount,
      latency: totalLatency || 580,
      totalNanoAiu,
      creditUsed
    };
  }, [bundledEvents]);

  return (
    <div className="bg-[#1e1e20] rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col gap-3">
      <h3 className="text-xs font-bold text-zinc-300 dark:text-zinc-200 uppercase font-sans tracking-wider border-b border-zinc-800 pb-2 flex items-center gap-1.5">
        <Activity size={15} className="text-sky-500" />
        <span>Session Analytics</span>
      </h3>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-zinc-950/30 rounded-xl p-3 border border-zinc-800/80">
          <span className="text-[9px] text-zinc-500 dark:text-zinc-400 uppercase font-bold font-sans tracking-wide">Total Trace logs</span>
          <div className="text-sm font-bold text-zinc-200 mt-0.5 font-mono">{stats.total} entries</div>
        </div>
        <div className="bg-zinc-950/30 rounded-xl p-3 border border-zinc-800/80">
          <span className="text-[9px] text-zinc-500 dark:text-zinc-400 uppercase font-bold font-sans tracking-wide">Tool Invocations</span>
          <div className="text-sm font-bold text-sky-400 mt-0.5 font-mono">{stats.tools} runs</div>
        </div>
        <div className="bg-zinc-950/30 rounded-xl p-3 border border-zinc-800/80">
          <span className="text-[9px] text-zinc-500 dark:text-zinc-400 uppercase font-bold font-sans tracking-wide">Pipeline Alerts</span>
          <div className="text-sm font-bold text-rose-500 mt-0.5 font-mono">{stats.errors} exceptions</div>
        </div>
        <div className="bg-zinc-950/30 rounded-xl p-3 border border-zinc-800/80">
          <span className="text-[9px] text-zinc-500 dark:text-zinc-400 uppercase font-bold font-sans tracking-wide">Permissions requested</span>
          <div className="text-sm font-bold text-purple-400 mt-0.5 font-mono">{stats.permissions} triggers</div>
        </div>

        <div className="bg-zinc-950/30 rounded-xl p-3 border border-zinc-800/80 col-span-2 flex justify-between items-center">
          <div>
            <span className="text-[9px] text-zinc-500 dark:text-zinc-400 uppercase font-bold font-sans tracking-wide">Estimated Credit Used</span>
            <div className="text-sm font-bold text-emerald-500 dark:text-emerald-400 mt-0.5 font-mono">{stats.creditUsed.toFixed(1)} credits</div>
          </div>
          <div className="text-[10px] text-zinc-400 font-bold font-mono text-right bg-zinc-900/60 px-2 py-1 rounded border border-zinc-800/50">
            {stats.totalNanoAiu.toLocaleString()} nAiu
          </div>
        </div>
      </div>

      <div className="bg-zinc-950/30 rounded-xl px-3 py-2 border border-zinc-800/80 flex justify-between items-center text-[10.5px] font-sans">
        <span className="text-zinc-500 dark:text-zinc-400 font-medium">Avg Execution Latency:</span>
        <span className="font-bold text-zinc-300">{stats.latency}ms</span>
      </div>
    </div>
  );
}
