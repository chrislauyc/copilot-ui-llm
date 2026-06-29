import { truncateOutput } from './formatters';
import { sanitizeSensitives } from './sanitizers';
import { getExecCommand } from '../workspace';


export function makeDockerToolHandler(
  secureWrite: Function,
  res: any,
  abortSignal: AbortSignal,
  writeLog: Function,
  sensitiveValuesCache: Set<string> | null,
  sessionId?: string
) {
  return async (args: any) => {
    const wd = args.workingDir || '';
    if (wd.includes('..')) {
      writeLog(`[run_terminal_docker] Traversal path attempt blocked: ${wd}`);
      return {
        stdout: "",
        stderr: "Error: Directory path traversal detected. Access denied outside workspace boundaries.",
        exitCode: 1
      };
    }

    writeLog(`[run_terminal_docker] Running command: "${args.command}" inside ${args.workingDir || '/workspace'}`);
    const execCommand = getExecCommand();
    const result = await execCommand(args.command, abortSignal);

    writeLog(`[run_terminal_docker] Completed with exit code ${result.exitCode}. Stdout length: ${result.stdout.length}, Stderr length: ${result.stderr.length}`);
    
    // Use the passed sensitivity cache
    const cleanStdout = truncateOutput(sanitizeSensitives(result.stdout, sensitiveValuesCache || new Set<string>()));
    const cleanStderr = truncateOutput(sanitizeSensitives(result.stderr, sensitiveValuesCache || new Set<string>()));

    // Stream standard tool output events back into the active SSE stream
    const streamEvent = {
      type: 'tool.result',
      data: {
        toolName: 'run_terminal_docker',
        stdout: cleanStdout,
        stderr: cleanStderr,
        exitCode: result.exitCode
      }
    };
    await secureWrite(res, `data: ${JSON.stringify(streamEvent)}\n\n`);

    return {
      stdout: cleanStdout,
      stderr: cleanStderr,
      exitCode: result.exitCode
    };
  };
}
