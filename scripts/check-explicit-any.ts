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

  const eslintDirectives: EslintDirective[] = [];
  
  for (let i = 0; i < fileLines.length; i++) {
    const lineText = fileLines[i] || '';
    const lineNum = i + 1;
    
    if (lineText.includes('eslint-disable') || lineText.includes('eslint-enable')) {
      let type: EslintDirective['type'] = 'disable';
      if (lineText.includes('eslint-disable-next-line')) {
        type = 'disable-next-line';
      } else if (lineText.includes('eslint-disable-line')) {
        type = 'disable-line';
      } else if (lineText.includes('eslint-enable')) {
        type = 'enable';
      }

      const directiveWord = type === 'disable-next-line' ? 'eslint-disable-next-line' :
                            type === 'disable-line' ? 'eslint-disable-line' :
                            type === 'disable' ? 'eslint-disable' : 'eslint-enable';

      const idx = lineText.indexOf(directiveWord);
      const remaining = lineText.substring(idx + directiveWord.length).trim();
      const firstLine = remaining;
      const cleanLine = firstLine ? firstLine.replace(/\*\//g, '').trim() : '';
      const rules = cleanLine ? (cleanLine.split('--')[0] || '').split(',').map(r => r.trim()).filter(Boolean) : [];

      eslintDirectives.push({ type, rules, line: lineNum });
    }
  }

  // Check for @ts-ignore / @ts-expect-error
  for (let i = 0; i < fileLines.length; i++) {
    const lineText = fileLines[i] || '';
    const lineNum = i + 1;
    if (/@ts-(?:ignore|expect-error)\b/.test(lineText)) {
      const rule = '@typescript-eslint/ban-ts-comment';
      if (!isViolationDisabled(lineNum, rule, eslintDirectives)) {
        violations.push({
          file: filePath,
          line: lineNum,
          lineContent: lineText.trim(),
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
