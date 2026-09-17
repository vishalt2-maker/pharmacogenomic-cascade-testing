import { migrate } from '../db/migrate.ts';
import { loadRulePack } from '../../db/seed/load.ts';
import { RULE_PACK } from '../../db/seed/rule-pack-2026.03.1.ts';
import { seedDemoOrganizations } from '../../db/seed/demo-org.ts';
import { closeDb } from '../db/client.ts';

try {
  await migrate({ log: (s) => console.log(s) });
  const report = await loadRulePack(RULE_PACK, { activate: true });
  console.log(`\nRule pack ${report.version} loaded${report.replacedExisting ? ' (replaced existing)' : ''}`);
  console.log(`  content hash  ${report.contentHash}`);
  for (const [k, v] of Object.entries(report.counts)) {
    console.log(`  ${k.padEnd(16)} ${v}`);
  }
  const orgs = await seedDemoOrganizations();
  console.log(`\nDemo organisations and users:`);
  for (const o of orgs) console.log(`  ${o.orgName}`);
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
