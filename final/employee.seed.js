require('dotenv/config')

const { PrismaClient, Prisma } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { hashPassword } = require('../services/auth.service')

const fs = require('fs')
const path = require('path')

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
})

const prisma = new PrismaClient({
  adapter,
})

const DATA_PATH = path.join(__dirname, 'employee_data.json')

const EMAIL_DOMAIN = 'ibex.com'
const DEFAULT_PASSWORD = '12345678'

const q = (name) => `"${name}"`

/**
 * Bulk upsert helper
 *
 * createdAt / updatedAt are handled automatically here.
 * You do NOT need them in employee_data.json.
 */
async function bulkUpsert(
  table,
  columns,
  rows,
  conflictCols,
) {
  if (!rows || rows.length === 0) {
    return
  }

  const conflictArr = Array.isArray(conflictCols)
    ? conflictCols
    : [conflictCols]

  // Columns that should be updated when a conflict occurs.
  const updateCols = columns.filter(
    (column) =>
      column !== 'id' &&
      !conflictArr.includes(column) &&
      column !== 'createdAt' &&
      column !== 'updatedAt',
  )

  const insertColumns = [
    ...columns,
    'createdAt',
    'updatedAt',
  ]

  const colList = Prisma.raw(
    insertColumns.map(q).join(', '),
  )

  const now = new Date()

  const valuesSql = Prisma.join(
    rows.map((row) => {
      const values = columns.map(
        (column) => row[column] ?? null,
      )

      return Prisma.sql`(
        ${Prisma.join(values)},
        ${now},
        ${now}
      )`
    }),
  )

  const conflictSql = Prisma.raw(
    conflictArr.map(q).join(', '),
  )

  const setParts = updateCols.map(
    (column) =>
      Prisma.sql`
        ${Prisma.raw(q(column))}
        = EXCLUDED.${Prisma.raw(q(column))}
      `,
  )

  // Update updatedAt automatically on existing records.
  setParts.push(
    Prisma.sql`
      "updatedAt" = NOW()
    `,
  )

  const query =
    setParts.length > 0
      ? Prisma.sql`
          INSERT INTO ${Prisma.raw(q(table))}
          (${colList})
          VALUES ${valuesSql}
          ON CONFLICT (${conflictSql})
          DO UPDATE SET
          ${Prisma.join(setParts, ', ')}
        `
      : Prisma.sql`
          INSERT INTO ${Prisma.raw(q(table))}
          (${colList})
          VALUES ${valuesSql}
          ON CONFLICT (${conflictSql})
          DO NOTHING
        `

  await prisma.$executeRaw(query)
}

async function main() {
  // --------------------------------------------------
  // Read employee data
  // --------------------------------------------------

  const data = JSON.parse(
    fs.readFileSync(DATA_PATH, 'utf8'),
  )

  const {
    departments = [],
    areas = [],
    subAreas = [],
    blocks = [],
    employees = [],
  } = data

  console.log('')
  console.log('==========================================')
  console.log('        EMPLOYEE DATA SEED')
  console.log('==========================================')
  console.log('')

  console.log(
    `Seeding ${departments.length} departments, ` +
      `${areas.length} areas, ` +
      `${subAreas.length} sub-areas, ` +
      `${blocks.length} blocks, ` +
      `${employees.length} employees...`,
  )

  console.log('')

  // --------------------------------------------------
  // 1. Departments + Areas
  // --------------------------------------------------
  //
  // These don't depend on each other.
  // So they can be inserted together.
  //

  await Promise.all([
    bulkUpsert(
      'Department',
      [
        'id',
        'name',
      ],
      departments,
      'name',
    ),

    bulkUpsert(
      'Area',
      [
        'id',
        'name',
        'city',
      ],
      areas.map((area) => ({
        ...area,
        city: area.city || 'Karachi',
      })),
      'name',
    ),
  ])

  console.log(
    `  Departments ready: ${departments.length}`,
  )

  console.log(
    `  Areas ready: ${areas.length}`,
  )

  // --------------------------------------------------
  // 2. SubAreas
  // --------------------------------------------------
  //
  // SubArea depends on Area.
  //

  await bulkUpsert(
    'SubArea',
    [
      'id',
      'name',
      'areaId',
    ],
    subAreas,
    [
      'name',
      'areaId',
    ],
  )

  console.log(
    `  SubAreas ready: ${subAreas.length}`,
  )

  // --------------------------------------------------
  // 3. Blocks
  // --------------------------------------------------
  //
  // Block depends on SubArea.
  //

  await bulkUpsert(
    'Block',
    [
      'id',
      'name',
      'subAreaId',
    ],
    blocks,
    [
      'name',
      'subAreaId',
    ],
  )

  console.log(
    `  Blocks ready: ${blocks.length}`,
  )

  // --------------------------------------------------
  // 4. Employees
  // --------------------------------------------------
  //
  // Employee references:
  // - Department
  // - Area
  // - SubArea
  // - Block
  //

  await bulkUpsert(
    'Employee',
    [
      'id',
      'employeeCode',
      'name',
      'contactNumber',
      'entity',
      'officeLocation',
      'departmentId',
      'areaId',
      'subAreaId',
      'blockId',
      'address',
      'serviceType',
      'status',
    ],
    employees,
    'employeeCode',
  )

  console.log(
    `  Employees ready: ${employees.length}`,
  )

  // --------------------------------------------------
  // 5. Employee Login Creation
  // --------------------------------------------------

  const employeeCodes = employees
    .map((employee) => employee.employeeCode)
    .filter(Boolean)

  if (employeeCodes.length === 0) {
    console.log(
      '  No employee codes found. Skipping login creation.',
    )
  } else {
    const withoutUser =
      await prisma.employee.findMany({
        where: {
          userId: null,
          employeeCode: {
            in: employeeCodes,
          },
        },
        select: {
          employeeCode: true,
          name: true,
        },
      })

    if (withoutUser.length === 0) {
      console.log(
        '  Logins ready: all employees already had one',
      )
    } else {
      // Hash password only once.
      const passwordHash =
        await hashPassword(DEFAULT_PASSWORD)

      await prisma.user.createMany({
        data: withoutUser.map((employee) => ({
          email: `${employee.employeeCode}@${EMAIL_DOMAIN}`,
          name: employee.name,
          passwordHash,
          role: 'EMPLOYEE',
        })),
        skipDuplicates: true,
      })

      // Link users to employees in one query.
      const count = await prisma.$executeRaw`
        UPDATE "Employee" e
        SET "userId" = u.id
        FROM "User" u
        WHERE e."userId" IS NULL
          AND u.email =
            e."employeeCode" || '@' || ${EMAIL_DOMAIN}
      `

      console.log(
        `  Logins ready: ${count} linked ` +
          `(${withoutUser.length} employees needed one)`,
      )
    }
  }

  console.log('')
  console.log('==========================================')
  console.log('          SEED COMPLETE')
  console.log('==========================================')
  console.log('')
}

main()
  .catch((error) => {
    console.error('')
    console.error('==========================================')
    console.error('             SEED FAILED')
    console.error('==========================================')
    console.error('')
    console.error(error)
    console.error('')
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })