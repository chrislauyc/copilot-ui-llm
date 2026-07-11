import { execSync } from 'node:child_process';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const safeRefRegex = /^[a-zA-Z0-9._\-\/]+$/;

// Try to fetch the base branch if we are in a GitHub Actions environment
if (process.env.GITHUB_ACTIONS === 'true') {
  const baseRef = process.env.GITHUB_BASE_REF || 'main';
  if (safeRefRegex.test(baseRef)) {
    console.log(`GitHub Actions detected. Fetching base branch: ${baseRef}...`);
    try {
      // Attempt to unshallow the current repository clone first so git has history
      try {
        execSync('git fetch --unshallow', { stdio: 'ignore' });
      } catch {
        // already unshallow or failed
      }
      execSync(`git fetch origin ${baseRef} --depth=100`, { stdio: 'inherit' });
    } catch (err) {
      console.warn(`Failed to fetch origin ${baseRef}:`, err);
    }
  } else {
    console.warn(`Invalid GITHUB_BASE_REF: "${baseRef}"`);
  }
}

function getBaseRef(): string | null {
  if (process.env.GITHUB_BASE_REF) {
    const baseRef = process.env.GITHUB_BASE_REF;
    if (safeRefRegex.test(baseRef)) {
      const prBase = `origin/${baseRef}`;
      try {
        execSync(`git rev-parse --verify ${prBase}`, { stdio: 'ignore' });
        return prBase;
      } catch {}
    }
  }
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      execSync(`git rev-parse --verify ${ref}`, { stdio: 'ignore' });
      return ref;
    } catch {
      // ignore
    }
  }
  return null;
}

interface EslintDirective {
  type: 'disable' | 'enable' | 'disable-next-line' | 'disable-line';
  rules: string[];
  line: number;
}

interface Violation {
  file: string;
  line: number;
  lineContent: string;
  reason: string;
}

function getAddedLines(diffOutput: string): Record<string, Set<number>> {
  const addedLinesPerFile: Record<string, Set<number>> = {};
  const lines = diffOutput.split('\n');
  let currentFile = 'unknown';
  let currentLineNumber = 0;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      addedLinesPerFile[currentFile] = new Set<number>();
      continue;
    }
    if (line.startsWith('@@ ')) {
      // Hunk header: @@ -oldStart,oldLength +newStart,newLength @@
      const match = line.match(/^\s*@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (match && match[1]) {
        currentLineNumber = parseInt(match[1], 10);
      }
      continue;
    }
    if (line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('+')) {
      const currentSet = currentFile ? addedLinesPerFile[currentFile] : undefined;
      if (currentSet) {
        currentSet.add(currentLineNumber);
      }
      currentLineNumber++;
    } else if (line.startsWith(' ')) {
      currentLineNumber++;
    }
  }

  return addedLinesPerFile;
}

function isViolationDisabled(line: number, rule: string, directives: EslintDirective[]): boolean {
  let isBlockDisabled = false;
  const sortedDirectives = [...directives].sort((a, b) => a.line - b.line);

  for (const dir of sortedDirectives) {
    if (dir.line > line) {
      break;
    }

    const coversRule = dir.rules.length === 0 || dir.rules.includes(rule);

    if (dir.type === 'disable') {
      if (coversRule) {
        isBlockDisabled = true;
      }
    } else if (dir.type === 'enable') {
      if (coversRule) {
        isBlockDisabled = false;
      }
    }
  }

  if (isBlockDisabled) {
    return true;
  }

  const hasDisableNextLine = directives.some(dir =>
    dir.type === 'disable-next-line' &&
    dir.line === line - 1 &&
    (dir.rules.length === 0 || dir.rules.includes(rule))
  );

  if (hasDisableNextLine) {
    return true;
  }

  const hasDisableLine = directives.some(dir =>
    dir.type === 'disable-line' &&
    dir.line === line &&
    (dir.rules.length === 0 || dir.rules.includes(rule))
  );

  if (hasDisableLine) {
    return true;
  }

  return false;
}

function checkFileForViolations(filePath: string, addedLines: Set<number>): Violation[] {
  const violations: Violation[] = [];

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const fileLines = content.split('\n');

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  function getLineNumber(pos: number): number {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  // 1. Gather all unique comment ranges in the file using leading/trailing trivia
  interface CommentRangeInfo {
    text: string;
    pos: number;
    end: number;
    line: number;
  }

  const commentKeys = new Set<string>();
  const commentRanges: CommentRangeInfo[] = [];

  function visitComments(node: ts.Node) {
    const leading = ts.getLeadingCommentRanges(content, node.pos);
    if (leading) {
      for (const r of leading) {
        const key = `${r.pos}-${r.end}`;
        if (!commentKeys.has(key)) {
          commentKeys.add(key);
          commentRanges.push({
            text: content.substring(r.pos, r.end),
            pos: r.pos,
            end: r.end,
            line: getLineNumber(r.pos)
          });
        }
      }
    }

    const trailing = ts.getTrailingCommentRanges(content, node.end);
    if (trailing) {
      for (const r of trailing) {
        const key = `${r.pos}-${r.end}`;
        if (!commentKeys.has(key)) {
          commentKeys.add(key);
          commentRanges.push({
            text: content.substring(r.pos, r.end),
            pos: r.pos,
            end: r.end,
            line: getLineNumber(r.pos)
          });
        }
      }
    }

    ts.forEachChild(node, visitComments);
  }

  visitComments(sourceFile);

  // 2. Parse eslint directives from the gathered comments
  const eslintDirectives: EslintDirective[] = [];
  for (const comment of commentRanges) {
    const commentText = comment.text;
    if (commentText.includes('eslint-disable') || commentText.includes('eslint-enable')) {
      let type: EslintDirective['type'] = 'disable';
      if (commentText.includes('eslint-disable-next-line')) {
        type = 'disable-next-line';
      } else if (commentText.includes('eslint-disable-line')) {
        type = 'disable-line';
      } else if (commentText.includes('eslint-enable')) {
        type = 'enable';
      }

      const directiveWord = type === 'disable-next-line' ? 'eslint-disable-next-line' :
                            type === 'disable-line' ? 'eslint-disable-line' :
                            type === 'disable' ? 'eslint-disable' : 'eslint-enable';

      const idx = commentText.indexOf(directiveWord);
      const remaining = commentText.substring(idx + directiveWord.length).trim();
      const firstLine = remaining.split('\n')[0];
      const cleanLine = firstLine ? firstLine.replace(/\*\//g, '').trim() : '';
      const rules = cleanLine ? cleanLine.split(',').map(r => r.trim()).filter(Boolean) : [];

      eslintDirectives.push({ type, rules, line: comment.line });
    }
  }

  // 3. Check gathered comments for @ts-ignore / @ts-expect-error
  for (const comment of commentRanges) {
    const commentText = comment.text;
    if (/@ts-(?:ignore|expect-error)\b/.test(commentText)) {
      if (addedLines.has(comment.line)) {
        const rule = '@typescript-eslint/ban-ts-comment';
        if (!isViolationDisabled(comment.line, rule, eslintDirectives)) {
          violations.push({
            file: filePath,
            line: comment.line,
            lineContent: fileLines[comment.line - 1]?.trim() || '',
            reason: 'Usage of @ts-ignore or @ts-expect-error is forbidden by the type discipline guide.'
          });
        }
      }
    }
  }

  // 4. Traverse AST to find explicit 'any' (AnyKeyword nodes)
  function visitAny(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const startPos = node.getStart(sourceFile);
      const line = getLineNumber(startPos);

      if (addedLines.has(line)) {
        const rule = '@typescript-eslint/no-explicit-any';
        if (!isViolationDisabled(line, rule, eslintDirectives)) {
          violations.push({
            file: filePath,
            line,
            lineContent: fileLines[line - 1]?.trim() || '',
            reason: 'New explicit "any" type usage is forbidden in orchestrator/SDK paths.'
          });
        }
      }
    }
    ts.forEachChild(node, visitAny);
  }

  visitAny(sourceFile);

  return violations;
}

function main() {
  console.log('=== Checking for new explicit "any", @ts-ignore, or @ts-expect-error in src/orchestrator or src/copilotSdk ===');

  let diff = '';
  const baseRef = getBaseRef();

  if (baseRef) {
    try {
      console.log(`Finding merge base between ${baseRef} and HEAD...`);
      const mergeBase = execSync(`git merge-base ${baseRef} HEAD`, { encoding: 'utf8' }).trim();
      console.log(`Comparing current state against merge base ${mergeBase} (from ${baseRef})...`);
      diff = execSync(`git diff ${mergeBase} -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
    } catch {
      console.warn('Failed to get diff against merge base, trying direct diff against base ref...');
      try {
        diff = execSync(`git diff ${baseRef} -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
      } catch {
        console.warn('Failed to get diff against base ref, falling back to local diff against HEAD.');
        try {
          diff = execSync(`git diff HEAD -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
        } catch {
          // ignore
        }
      }
    }
  } else {
    console.log('No base branch found. Checking uncommitted/local changes against HEAD.');
    try {
      diff = execSync(`git diff HEAD -- 'src/orchestrator' 'src/copilotSdk'`, { encoding: 'utf8' });
    } catch {
      // ignore
    }
  }

  if (!diff.trim()) {
    console.log('✅ No changes detected in target paths.');
    process.exit(0);
  }

  const addedLinesPerFile = getAddedLines(diff);
  const violations: Violation[] = [];

  for (const [file, addedLines] of Object.entries(addedLinesPerFile)) {
    if (addedLines.size === 0) {
      continue;
    }
    const fileViolations = checkFileForViolations(file, addedLines);
    violations.push(...fileViolations);
  }

  if (violations.length > 0) {
    console.error('\n❌ ERROR: Type discipline violations introduced in src/orchestrator or src/copilotSdk paths:\n');
    for (const violation of violations) {
      console.error(`  File: ${violation.file}`);
      console.error(`  Line ${violation.line}: ${violation.lineContent}`);
      console.error(`  Reason: ${violation.reason}\n`);
    }
    console.error('Please specify a more specific type instead of "any", or use "unknown" or "eslint-disable-next-line @typescript-eslint/no-explicit-any" if absolutely necessary.\n');
    process.exit(1);
  }

  console.log('✅ No new explicit "any" or banned TS comments detected in target paths.');
  process.exit(0);
}

main();
