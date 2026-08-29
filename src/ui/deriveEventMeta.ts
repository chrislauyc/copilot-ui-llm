
export function deriveEventMeta(typeStr: string, data?: any): { 
  category: 'system' | 'user' | 'assistant' | 'tool' | 'permission' | 'error', 
  title: string 
} {
  let category: 'system' | 'user' | 'assistant' | 'tool' | 'permission' | 'error' = 'system';
  
  if (typeStr === 'user.message') {
    category = 'user';
  } else if (typeStr === 'assistant.message' || typeStr === 'assistant.reasoning' || typeStr === 'assistant.message_delta' || typeStr === 'assistant.reasoning_delta' || typeStr === 'assistant.streaming_delta') {
    category = 'assistant';
  } else if (typeStr.startsWith('tool.')) {
    category = 'tool';
  } else if (typeStr.startsWith('permission.')) {
    category = 'permission';
  } else if (typeStr === 'session.error' || typeStr === 'loop.escalate_human' || typeStr === 'loop.clarity_check_failed') {
    category = 'error';
  } else if (typeStr.startsWith('system.') || typeStr.startsWith('session.') || typeStr === 'loop.retry' || typeStr === 'loop.complete' || typeStr === 'composer.plan' || typeStr === 'composer.plan_mutated' || typeStr === 'TURN_COMPLETED') {
    category = 'system';
  } else if (typeStr === 'gate.result' || typeStr === 'gate.legacyAudit' || typeStr === 'gate.start') {
    category = 'tool';
  }
  
  let title = `Event (${typeStr || 'unknown'})`;
  if (typeStr === 'session.start') title = 'Session Initialized';
  else if (typeStr === 'user.message') title = 'User Query Received';
  else if (typeStr === 'assistant.message') title = 'Assistant Response Ready';
  else if (typeStr === 'assistant.reasoning') title = 'Thought Chain Planning';
  else if (typeStr === 'tool.execution_start') title = `Tool Execution Started`;
  else if (typeStr === 'tool.execution_complete') title = `Tool Execution Completed`;
  else if (typeStr === 'permission.requested') title = 'Permission Request';
  else if (typeStr === 'permission.completed') title = 'Permission Response';
  else if (typeStr === 'session.error') title = 'Pipeline Error occurred';
  else if (typeStr === 'session.shutdown') title = 'Session Concluded';
  else if (typeStr === 'system.message') title = 'System Directive Registered';
  else if (typeStr === 'session.tools_updated') title = 'Model Tools Registered';
  else if (typeStr === 'assistant.turn_start') title = 'Assistant Turn Initiated';
  else if (typeStr === 'assistant.turn_end') title = 'Assistant Turn Completed';
  else if (typeStr === 'session.usage_info') title = 'Token Usage Telemetry';
  else if (typeStr === 'session.title_changed') title = 'Auto Session Title Set';
  else if (typeStr === 'assistant.usage') title = 'LLM Tokens & Performance';
  else if (typeStr === 'session.idle') title = 'Copilot Session Standby';
  else if (typeStr === 'pending_messages.modified') title = 'Context Buffer Prepped';
  else if (typeStr === 'gate.result') title = data ? `Gate: ${data.gateName}` : 'Gate Verification Result';
  else if (typeStr === 'loop.retry') title = data ? `Retry ${data.retryCount}/${data.maxRetries}` : 'Self-Corrector Loop Retry';
  else if (typeStr === 'loop.complete') title = 'Verification Loop Complete';
  else if (typeStr === 'loop.escalate_human') title = 'Human Review Required';
  else if (typeStr === 'loop.clarity_check_failed') title = 'Ambiguity Block Applied';
  else if (typeStr === 'composer.plan') title = 'Orchestrator Plan Resolved';
  else if (typeStr === 'composer.plan_mutated') title = 'Blueprint Healed Mid-Flight';
  else if (typeStr === 'TURN_COMPLETED') title = 'Project Milestone Snapshotted';
  else if (typeStr === 'gate.legacyAudit') title = 'Verification Strategy Logged';
  else if (typeStr === 'gate.start') title = data ? `Starting Gate: ${data.gateName}` : 'Verification Gate Started';

  return { category, title };
}
