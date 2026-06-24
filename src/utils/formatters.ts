/**
 * Utilities for formatting terminal output and log messages.
 */

export function truncateOutput(text: string, maxLength: number = 20000): string {
  if (!text || typeof text !== 'string') return text;
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "\n\n... [Output truncated for performance logs]";
}

/**
 * Strips ANSI escape codes from a string.
 */
export function stripAnsi(text: string): string {
  if (!text) return text;
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}
