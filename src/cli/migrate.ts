import { migrate } from '../db/migrate.ts';
import { closeDb, dataDir } from '../db/client.ts';

console.log(`PCT migrate -> ${dataDir()}`);
try {
  const out = await migrate({ log: (s) => console.log(s) });
  const applied = out.filter((o) => o.status === 'applied').length;
  console.log(`\n${applied} applied, ${out.length - applied} already present or skipped.`);
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
