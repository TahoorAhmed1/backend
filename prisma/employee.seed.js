/**
 * prisma/seed-employees.js
 *
 * Seeds Area -> SubArea -> Block -> Employee from
 * prisma/employee-seed-data.json, generated from the "Main Sheet IBT,1 2,
 * 3, SKYT (2)" tab of the PD Master Sheet (1,615 active employees, 182
 * areas, 945 sub-areas, 1,215 blocks). Run this separately from
 * prisma/seed.js (the driver/vehicle/vendor seed) — they're independent
 * datasets from different source files.
 *
 * ----------------------------------------------------------------------
 * HOW TO RUN
 * ----------------------------------------------------------------------
 *   node prisma/seed-employees.js
 * (Not wired into `npx prisma db seed` by default since that only runs
 * one seed entrypoint — call this one directly, or chain both from a
 * small wrapper script/package.json script if you want one command.)
 *
 * ----------------------------------------------------------------------
 * IDEMPOTENCY (safe to re-run)
 * ----------------------------------------------------------------------
 * - Area: upserted by `name` (unique in schema).
 * - SubArea: upserted by (`name`, `areaId`) (unique in schema).
 * - Block: upserted by (`name`, `subAreaId`) (unique in schema).
 * - Employee: upserted by `employeeCode` (unique in schema).
 *
 * ----------------------------------------------------------------------
 * KNOWN DATA CAVEATS — decisions already baked into employee-seed-data.json
 * ----------------------------------------------------------------------
 * 1. 33 employees had no real employee code in the sheet — the code
 *    column instead held their onboarding batch label (e.g. "Batch
 *    3592"), meaning HR hasn't issued their real code yet. These are
 *    seeded with placeholder codes "PENDING-0001".."PENDING-0033" so
 *    they're not silently dropped — find them with:
 *      SELECT * FROM "Employee" WHERE "employeeCode" LIKE 'PENDING-%';
 *    and swap in the real code once HR assigns one (employeeCode is
 *    @unique, so just update it in place — no need to delete/recreate).
 * 2. 2 employee codes appeared twice in the sheet under the same name but
 *    with different address/phone (a stale row that wasn't cleaned up
 *    when the employee's details were updated) — the LATER row in the
 *    sheet was kept, matching how we handled reassigned vehicle plates
 *    in the driver/vehicle seed.
 * 3. One row had an implausible "Last Working Day" (Excel had formatted a
 *    stray value as the date 1900-01-25, decades before this company
 *    existed) — ignored, employee seeded as ACTIVE rather than TERMINATED.
 * 4. Only 1 row (out of 1615) had a real Last Working Day value, so only
 *    that one employee is seeded with status TERMINATED; everyone else is
 *    ACTIVE.
 * 5. One row's office location was "Payroll" (not one of IBT_1/IBT_2/
 *    IBT_3/SKY_TOWER) — left null rather than guessed.
 * 6. Columns with NO home in the current Employee model were intentionally
 *    NOT persisted (there's nowhere to put them without a schema change):
 *    onboarding batch/campaign label (e.g. "TPL", "Mercari", "DMC"),
 *    KM Per Day, NOD, KM Per Month, Date of Joining, and the "usual
 *    vehicle type" column. If you want any of these tracked, they're
 *    still sitting in the source columns and can be re-parsed once a
 *    field exists to hold them.
 * 7. gender, cnic, and departmentId aren't in this sheet at all — left
 *    null for every employee (all optional in the schema).
 * Full per-row detail for all of the above is in employee-seed-data.json's
 * `issues` array.
 */

require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const fs = require("fs");
const path = require("path");


const DATA_PATH = path.join(__dirname, "employee-data.json");

const subAreaKey = (area, sub) => `${area}\u0000${sub}`;
const blockKey = (area, sub, block) => `${area}\u0000${sub}\u0000${block}`;

async function main() {
  const { areas, subAreas, blocks, employees } = JSON.parse(
    fs.readFileSync(DATA_PATH, "utf8"),
  );

  console.log(
    `Seeding ${areas.length} areas, ${subAreas.length} sub-areas, ` +
      `${blocks.length} blocks, ${employees.length} employees...`,
  );

  // ---------- 1. Areas ----------
  const areaIdByName = new Map();
  for (const a of areas) {
    const area = await prisma.area.upsert({
      where: { name: a.name },
      update: {},
      create: { name: a.name },
    });
    areaIdByName.set(a.name, area.id);
  }
  console.log(`  Areas ready: ${areaIdByName.size}`);

  // ---------- 2. SubAreas ----------
  const subAreaIdByKey = new Map();
  for (const s of subAreas) {
    const areaId = areaIdByName.get(s.area);
    if (!areaId) continue; // shouldn't happen — every subArea's area was seeded above
    const subArea = await prisma.subArea.upsert({
      where: { name_areaId: { name: s.name, areaId } },
      update: {},
      create: { name: s.name, areaId },
    });
    subAreaIdByKey.set(subAreaKey(s.area, s.name), subArea.id);
  }
  console.log(`  SubAreas ready: ${subAreaIdByKey.size}`);

  // ---------- 3. Blocks ----------
  const blockIdByKey = new Map();
  for (const b of blocks) {
    const subAreaId = subAreaIdByKey.get(subAreaKey(b.area, b.subArea));
    if (!subAreaId) continue;
    const block = await prisma.block.upsert({
      where: { name_subAreaId: { name: b.name, subAreaId } },
      update: {},
      create: { name: b.name, subAreaId },
    });
    blockIdByKey.set(blockKey(b.area, b.subArea, b.name), block.id);
  }
  console.log(`  Blocks ready: ${blockIdByKey.size}`);

  // ---------- 4. Employees ----------
  let created = 0;
  let updated = 0;

  for (const e of employees) {
    const areaId = e.areaKey ? areaIdByName.get(e.areaKey) : undefined;
    const subAreaId = e.subAreaKey
      ? subAreaIdByKey.get(subAreaKey(e.subAreaKey[0], e.subAreaKey[1]))
      : undefined;
    const blockId = e.blockKey
      ? blockIdByKey.get(blockKey(e.blockKey[0], e.blockKey[1], e.blockKey[2]))
      : undefined;

    const data = {
      name: e.name,
      contactNumber: e.contactNumber || undefined,
      entity: e.entity || undefined,
      officeLocation: e.officeLocation || undefined,
      areaId: areaId || undefined,
      subAreaId: subAreaId || undefined,
      blockId: blockId || undefined,
      address: e.address || undefined,
      serviceType: e.serviceType || "PICK_AND_DROP",
      status: e.status || "ACTIVE",
    };

    const existing = await prisma.employee.findUnique({
      where: { employeeCode: e.employeeCode },
    });
    if (existing) {
      await prisma.employee.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.employee.create({
        data: { employeeCode: e.employeeCode, ...data },
      });
      created++;
    }
  }
  console.log(`  Employees ready: ${created} created, ${updated} updated`);

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });