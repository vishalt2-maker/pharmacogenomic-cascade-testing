/**
 * Registry export from the command line.
 *
 * Defaults to a DRY RUN. Committing an export writes de-identified rows and
 * is recorded as an export run, so `--commit` has to be asked for explicitly.
 *
 *   node src/cli/registry-export.ts                 dry run, threshold 5
 *   node src/cli/registry-export.ts --commit        write the rows
 *   node src/cli/registry-export.ts --threshold 10  raise the suppression floor
 *   node src/cli/registry-export.ts --group state,suspect_drug
 */
import os from 'node:os';
import { migrate } from '../db/migrate.ts';
import { closeDb } from '../db/client.ts';
import { exportToRegistry, publishAggregate, pilotEndpoints } from '../registry/export.ts';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const commit = process.argv.includes('--commit');
const threshold = Number(arg('threshold', '5'));
const groupBy = (arg('group', 'state,suspect_drug,phenotype') as string)
  .split(',').map((s) => s.trim()).filter(Boolean);

try {
  await migrate();

  const out = await exportToRegistry({
    runBy: `${os.userInfo().username}@cli`,
    suppressionThreshold: threshold,
    dryRun: !commit,
  });

  console.log(`\n${commit ? 'EXPORTED' : 'DRY RUN'}`);
  console.log(`  rows considered            ${out.rowsConsidered}`);
  console.log(`  rows exported              ${out.rowsExported}`);
  console.log(`  withheld, no active consent ${out.rowsWithheldNoConsent}`);
  if (out.runId) console.log(`  export run                 ${out.runId}`);

  if (commit) {
    const agg = await publishAggregate(groupBy as never, { threshold });
    console.log(`\nAGGREGATE grouped by ${agg.groupedBy.join(', ')} (suppressed below ${agg.threshold})`);
    for (const cell of agg.cells) {
      const dims = agg.groupedBy.map((g) => cell.dimensions[g] ?? '—').join('  ');
      console.log(`  ${dims.padEnd(64)} ${cell.suppressed ? 'withheld' : String(cell.count).padStart(6)}`);
    }
    console.log(`\n  ${agg.cellsSuppressed} of ${agg.cells.length} cells withheld.`);
    console.log('  A count below the threshold re-identifies. Publish the suppressed table, not this one.');

    const e = await pilotEndpoints({ threshold });
    console.log('\nPILOT ENDPOINTS');
    const pct = (v: number | null) => v === null ? 'withheld (denominator too small)' : `${(v * 100).toFixed(1)}%`;
    console.log(`  index cases evaluated            ${e.indexCasesEvaluated}`);
    console.log(`  index genotyping rate            ${pct(e.indexGenotypingRate)}`);
    console.log(`  advisories issued                ${e.advisoriesIssued}`);
    console.log(`  relative testing uptake          ${pct(e.relativeUptakeRate)}`);
    console.log(`  carrier yield in tested relatives ${pct(e.carrierYieldInTestedRelatives)}`);
    console.log(`  PREDICTED carrier yield          ${pct(e.predictedCarrierYield)}`);
    console.log('\n  If the observed yield returns at population baseline rather than near the');
    console.log('  prediction, the thesis is wrong. That is the point of measuring it.');
  } else {
    console.log('\n  Nothing was written. Re-run with --commit to write the rows.');
  }
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
