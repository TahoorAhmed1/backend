/**
 * prisma/reset-driver-logins.js
 *
 * One-off cleanup: removes every driver's login (User row + the
 * Driver.userId link) and deletes the previously-generated QR badge
 * PNGs, so that re-running seed.js creates ALL-NEW driver Users with
 * the fixed seedId-based emails, fresh qrCode tokens, and fresh badge
 * images — instead of the old name-based emails some drivers already
 * have.
 *
 * This does NOT touch Driver, Vehicle, Vendor, Ride, or Attendance
 * rows — only User rows that are linked to a Driver, and the
 * Driver.userId column pointing at them.
 *
 * ----------------------------------------------------------------------
 * HOW TO RUN
 * ----------------------------------------------------------------------
 * 1. Put this file at prisma/reset-driver-logins.js (same folder as
 *    seed.js).
 * 2. node prisma/reset-driver-logins.js
 * 3. Then re-run the seed as usual: npx prisma db seed
 *    (or node prisma/seed.js)
 *
 * ----------------------------------------------------------------------
 * WHY THE ORDER MATTERS (unlink before delete)
 * ----------------------------------------------------------------------
 * Driver.userId is a foreign key pointing at User.id. Deleting a User
 * row that a Driver still points to will fail (or, worse, cascade and
 * take the Driver with it, depending on how onDelete is configured in
 * schema.prisma) unless the Driver->User link is cleared first. So
 * this script always does:
 *   1. driver.updateMany({ userId: null })   -- unlink every driver
 *   2. user.deleteMany({ role: "DRIVER" })   -- now safe to delete
 *
 * ----------------------------------------------------------------------
 * WHAT DRIVER LOGINS WILL LOOK LIKE AFTER THE NEXT SEED RUN
 * ----------------------------------------------------------------------
 * Every driver goes through the `if (!driver.user)` branch in seed.js
 * again (since userId is now null), so every driver gets:
 *   - a brand-new User row, email <seedId>@drivers.ibex.com
 *   - the same shared default password (12345678)
 *   - a brand-new qrCode token (crypto.randomUUID())
 *   - a freshly rendered badge PNG at prisma/qrcodes/drivers/
 *
 * Any physically printed badges from before this reset are now
 * invalid (their QR token no longer matches any User.qrCode) —
 * they'll need reprinting from the new PNGs.
 */

require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const fs = require('fs')
const path = require('path')

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const QR_DIR = path.join(__dirname, 'qrcodes', 'drivers')

async function main() {
  console.log('Resetting all driver logins...')

  // 1. Unlink every driver from its User first (see header comment on
  //    why this has to happen before the User rows are deleted).
  const unlinked = await prisma.driver.updateMany({
    where: { userId: { not: null } },
    data: { userId: null },
  })
  console.log(`  Unlinked ${unlinked.count} driver(s) from their User row.`)

  // 2. Now safe to delete every driver User row.
  const deletedUsers = await prisma.user.deleteMany({
    where: { role: 'DRIVER' },
  })
  console.log(`  Deleted ${deletedUsers.count} driver User row(s).`)

  // 3. Wipe the old badge PNGs so nothing stale is left sitting next
  //    to the freshly generated ones after the next seed run.
  if (fs.existsSync(QR_DIR)) {
    const files = fs.readdirSync(QR_DIR).filter((f) => f.endsWith('.png'))
    for (const file of files) {
      fs.unlinkSync(path.join(QR_DIR, file))
    }
    console.log(`  Deleted ${files.length} old QR badge PNG(s) from ${QR_DIR}.`)
  } else {
    console.log(`  ${QR_DIR} doesn't exist yet — nothing to delete.`)
  }

  console.log('Reset complete. Now re-run the seed script to recreate everything fresh.')
}

main()
  .catch((err) => {
    console.error('Reset failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })