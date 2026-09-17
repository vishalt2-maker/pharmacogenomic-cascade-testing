/**
 * Demo organisations and users.
 *
 * TWO organisations, deliberately. A single-tenant demo cannot show that
 * row-level security works; the isolation test needs a second hospital whose
 * data the first one must fail to read.
 *
 * Identifiers are fixed so the demo script and the test suite can refer to
 * them without a lookup.
 */
import { asService } from '../../src/db/client.ts';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';

export const USERS = {
  /** Registered physician at org A. Can sign. */
  physicianA: 'aaaaaaaa-0000-4000-8000-000000000001',
  /** Registered clinical pharmacist at org A. Can sign. Enters genotypes. */
  pharmacistA: 'aaaaaaaa-0000-4000-8000-000000000002',
  /** Counsellor at org A. Cannot sign, whatever the application layer thinks. */
  counsellorA: 'aaaaaaaa-0000-4000-8000-000000000003',
  /** AMC coordinator at org A. Logs the ADR. Cannot sign. */
  coordinatorA: 'aaaaaaaa-0000-4000-8000-000000000004',
  /** Physician at org A with no registration number recorded. Cannot sign. */
  unregisteredA: 'aaaaaaaa-0000-4000-8000-000000000005',
  /** Physician at org B. Must not be able to see anything belonging to org A. */
  physicianB: 'bbbbbbbb-0000-4000-8000-000000000001',
} as const;

interface SeedUser {
  id: string; name: string; role: string;
  regNo: string | null; regBody: string | null; org: string; email: string;
}

const USER_ROWS: SeedUser[] = [
  { id: USERS.physicianA, name: 'Dr A. Narayanan', role: 'physician',
    regNo: 'NMC-DEMO-10001', regBody: 'NMC', org: ORG_A, email: 'physician.a@demo.invalid' },
  { id: USERS.pharmacistA, name: 'S. Iyer', role: 'clinical_pharmacist',
    regNo: 'PCI-DEMO-20002', regBody: 'PCI', org: ORG_A, email: 'pharmacist.a@demo.invalid' },
  { id: USERS.counsellorA, name: 'R. Bhatt', role: 'counsellor',
    regNo: null, regBody: null, org: ORG_A, email: 'counsellor.a@demo.invalid' },
  { id: USERS.coordinatorA, name: 'M. Kulkarni', role: 'amc_coordinator',
    regNo: null, regBody: null, org: ORG_A, email: 'coordinator.a@demo.invalid' },
  { id: USERS.unregisteredA, name: 'Dr T. Verma', role: 'physician',
    regNo: null, regBody: null, org: ORG_A, email: 'unregistered.a@demo.invalid' },
  { id: USERS.physicianB, name: 'Dr K. Pillai', role: 'physician',
    regNo: 'NMC-DEMO-30003', regBody: 'NMC', org: ORG_B, email: 'physician.b@demo.invalid' },
];

export interface OrgSummary { orgId: string; orgName: string; }

export async function seedDemoOrganizations(): Promise<OrgSummary[]> {
  return asService(async (db) => {
    await db.exec('begin');
    try {
      const orgs: Array<[string, string, string, string]> = [
        [ORG_A, 'Demo Teaching Hospital AMC (Pune)', 'AMC-DEMO-A', 'Maharashtra'],
        [ORG_B, 'Demo District Hospital AMC (Kochi)', 'AMC-DEMO-B', 'Kerala'],
      ];
      for (const [id, name, code, state] of orgs) {
        await db.query(
          `insert into clinical.organizations (id, name, amc_code, state, dpa_signed_at)
           values ($1,$2,$3,$4, now())
           on conflict (id) do update set name = excluded.name`,
          [id, name, code, state]);
      }
      for (const u of USER_ROWS) {
        await db.query(
          `insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`,
          [u.id, u.email]);
        await db.query(
          `insert into clinical.app_users
             (id, org_id, full_name, role, registration_no, registration_body)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (id) do update set
             full_name = excluded.full_name, role = excluded.role,
             registration_no = excluded.registration_no,
             registration_body = excluded.registration_body`,
          [u.id, u.org, u.name, u.role, u.regNo, u.regBody]);
      }
      await db.exec('commit');
      return orgs.map(([id, name]) => ({ orgId: id, orgName: name }));
    } catch (err) {
      try { await db.exec('rollback'); } catch { /* already unwound */ }
      throw err;
    }
  });
}
