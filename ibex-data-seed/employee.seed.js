require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { hashPassword } = require('../services/auth.service')

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "employee-data.json");

const EMAIL_DOMAIN = "ibex.com";
const DEFAULT_PASSWORD =  "12345678";

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
  // Skipped — only Employee + User (login) are being (re)seeded this run.
  // Kept as an empty Map so the Employee loop below still resolves
  // areaId/subAreaId/blockId to undefined instead of throwing, on the
  // assumption Area/SubArea/Block already exist in the DB from a prior run.
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

  // ---------- 4. Employees + logins ----------
  // Hashed once up front: every generated login shares the same plaintext
  // starting password, so there's no reason to hash it 1,615 times.
  const defaultPasswordHash = await hashPassword(DEFAULT_PASSWORD);

  let created = 0;
  let updated = 0;
  let usersCreated = 0;
  let usersSkipped = 0;
  let userErrors = 0;

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
      include: { user: true },
    });

    let employeeRecord;
    if (existing) {
      employeeRecord = await prisma.employee.update({
        where: { id: existing.id },
        data,
        include: { user: true },
      });
      updated++;
    } else {
      employeeRecord = await prisma.employee.create({
        data: { employeeCode: e.employeeCode, ...data },
        include: { user: true },
      });
      created++;
    }

    // Attach a login for anyone who doesn't have one yet — covers both
    // employees just created above and pre-existing ones that were
    // seeded before user accounts existed.
    if (!employeeRecord.user) {
      const email = `${employeeRecord.employeeCode}@${EMAIL_DOMAIN}`;

      try {
        const user = await prisma.user.upsert({
          where: { email },
          update: {},
          create: {
            email,
            name: employeeRecord.name,
            passwordHash: defaultPasswordHash,
            role: "EMPLOYEE",
          },
        });

        console.log('user', user)

        await prisma.employee.update({
          where: { id: employeeRecord.id },
          data: { userId: user.id },
        });

        usersCreated++;
      } catch (err) {
        // Don't let one bad row (e.g. an email collision) abort the
        // whole 1,615-row run — log it and keep going.
        userErrors++;
        console.error(
          `  Login setup failed for employeeCode=${employeeRecord.employeeCode} (${email}):`,
          err.message,
        );
      }
    } else {
      usersSkipped++;
    }
  }

  console.log(`  Employees ready: ${created} created, ${updated} updated`);
  console.log(
    `  Logins ready: ${usersCreated} created, ${usersSkipped} already had one, ${userErrors} failed`,
  );

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