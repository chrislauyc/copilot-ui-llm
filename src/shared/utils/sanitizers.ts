/**
 * Utilities for cleaning and sanitizing log data and terminal output.
 */

export function sanitizeSensitives(text: string, sensitiveValues: Set<string> = new Set()): string {
  if (!text || typeof text !== 'string') return text;
  
  let sanitized = text;

  // Mask specific sensitive values provided in the set
  for (const val of sensitiveValues) {
    if (!val || val.length < 3) continue; // Avoid masking extremely short strings
    const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'g');
    sanitized = sanitized.replace(regex, '[REDACTED_SECRET]');
  }

  // Generic pattern-based masking
  return sanitized
    .replace(/(api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-\.]{8,})["']?/gi, '$1: [REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9\-\._~+/]+=*/gi, 'Bearer [REDACTED]');
}
