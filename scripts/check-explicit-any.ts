import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

interface Violation {
  file: string;
  line: number;
  lineContent: string;
  reason: string;
}

interface EslintDirective {
  type: 'disable' | 'enable' | 'disable-line' | 'disable-next-line';
  rules: string[];
  line: number;
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

function checkFileForViolations(filePath: string): Violation[] {
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
      const rules = cleanLine ? (cleanLine.split('--')[0] || '').split(',').map(r => r.trim()).filter(Boolean) : [];

      eslintDirectives.push({ type, rules, line: comment.line });
    }
  }

  // 3. Check gathered comments for @ts-ignore / @ts-expect-error
  for (const comment of commentRanges) {
    const commentText = comment.text;
    if (/@ts-(?:ignore|expect-error)\b/.test(commentText)) {
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

  // 4. Traverse AST to find explicit 'any' (AnyKeyword nodes)
  function visitAny(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const startPos = node.getStart(sourceFile);
      const line = getLineNumber(startPos);

      const rule = '@typescript-eslint/no-explicit-any';
      if (!isViolationDisabled(line, rule, eslintDirectives)) {
        violations.push({
          file: filePath,
          line,
          lineContent: fileLines[line - 1]?.trim() || '',
          reason: 'Explicit "any" type usage is forbidden in orchestrator/SDK paths.'
        });
      }
    }
    ts.forEachChild(node, visitAny);
  }

  visitAny(sourceFile);

  return violations;
}

function walkDir(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walkDir(filePath));
    } else if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      results.push(filePath);
    }
  }
  return results;
}

function main() {
  console.log('=== Checking for explicit "any", @ts-ignore, or @ts-expect-error in src/orchestrator or src/copilotSdk ===');

  const targetDirs = [
    path.join(process.cwd(), 'src', 'orchestrator'),
    path.join(process.cwd(), 'src', 'copilotSdk')
  ];

  const filesToCheck: string[] = [];
  for (const dir of targetDirs) {
    if (fs.existsSync(dir)) {
      filesToCheck.push(...walkDir(dir));
    }
  }

  if (filesToCheck.length === 0) {
    console.log('✅ No target files found.');
    process.exit(0);
  }

  const violations: Violation[] = [];

  for (const file of filesToCheck) {
    const fileViolations = checkFileForViolations(file);
    violations.push(...fileViolations);
  }

  if (violations.length > 0) {
    console.error('\n❌ ERROR: Type discipline violations found in src/orchestrator or src/copilotSdk paths:\n');
    for (const violation of violations) {
      const relPath = path.relative(process.cwd(), violation.file);
      console.error(`  File: ${relPath}`);
      console.error(`  Line ${violation.line}: ${violation.lineContent}`);
      console.error(`  Reason: ${violation.reason}\n`);
    }
    console.error('Please specify a more specific type instead of "any", or use "unknown" or "eslint-disable-next-line @typescript-eslint/no-explicit-any" if absolutely necessary.\n');
    process.exit(1);
  }

  console.log('✅ No explicit "any" or banned TS comments detected in target paths.');
  process.exit(0);
}

main();
