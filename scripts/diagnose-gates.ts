import { runGate } from '../src/gates/index';
import { normalizeGates } from '../src/config/gates';

async function main() {
  const args = process.argv.slice(2);
  // Default to lint and tests if no arguments are provided
  const gatesToRun = args.length > 0 ? args : ['lint', 'tests'];
  const gates = normalizeGates(gatesToRun);

  console.log('============= GATE LOOP DIAGNOSTICS =============');
  console.log(`Running gates:  ${gates.join(', ')}`);
  console.log(`Working Dir:    ${process.cwd()}\n`);

  for (const gate of gates) {
    console.log(`▶ Starting gate: ${gate}`);
    const result = await runGate(gate, process.cwd());

    if (!result.pass) {
      console.error(`\n❌ [FAILED] Gate '${gate}' encountered an issue.`);
      console.error(`Duration: ${result.durationMs}ms`);
      console.error('\n--- OUTPUT START ---');
      console.error(result.feedback?.trim() || '(No output provided)');
      console.error('--- OUTPUT END ---\n');
      console.error(`Stopping the diagnostic process immediately because '${gate}' failed.`);
      process.exit(1); 
    }

    console.log(`✅ [PASSED] Gate '${gate}' completed successfully in ${result.durationMs}ms.\n`);
  }

  console.log('🚀 All gates passed successfully! The gate loop is healthy.');
  process.exit(0);
}

main().catch(err => {
  console.error('\n💥 Unexpected error during diagnostic run:');
  console.error(err);
  process.exit(1);
});
