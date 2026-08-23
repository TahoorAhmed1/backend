require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

// Safety switch. Defaults to a dry run (read-only, prints a plan).
// Run `APPLY=true node merge-and-seed.js` to actually write.
const APPLY = process.env.APPLY === 'true'

// ────────────────────────────────────────────────────────────────────────
// STEP 0: normalization helper — used to match old messy names against
// the canonical list / alias table below.
// ────────────────────────────────────────────────────────────────────────
function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\bkarachi\.?\b/g, '')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ────────────────────────────────────────────────────────────────────────
// STEP 1: the canonical structure you just sent — this is what SHOULD
// exist. Upserting it is safe: if an Area/SubArea/Block with that exact
// name already exists, its id is preserved (update branch); nothing new
// is created for it.
// ────────────────────────────────────────────────────────────────────────
const AREAS = [
  { name: 'P.E.C.H.S', subAreas: [
    { name: 'PECHS', blocks: ['Block 1','Block 2','Block 3','Block 4','Block 5','Block 6','Block 7','Block 8','Block 9'] },
  ]},
  { name: 'Garden West', subAreas: [
    { name: 'Garden West', blocks: ['Block A','Block B','Block C','Block D','Block E','Block F','Block G','Block H'] },
  ]},
  { name: 'Garden East', subAreas: [
    { name: 'Garden East', blocks: ['Block B','G-3'] },
  ]},
  { name: 'Nazimabad', subAreas: [
    { name: 'Nazimabad', blocks: ['No. 1','No. 2','No. 3','No. 4 (A to G)','No. 5'] },
  ]},
  { name: 'North Nazimabad', subAreas: [
    { name: 'North Nazimabad', blocks: [
      'Block A','Block B','Block C','Block D','Block E','Block F','Block G','Block H','Block I','Block J',
      'Block K','Block L','Block M','Block N','Block P','Block Q','Block R','Block S','Block T','Block U',
    ]},
  ]},
  { name: 'Bhutto Colony', subAreas: [
    { name: 'Shah Nawaz Bhutto Colony', blocks: ['Sector 11-D','Sector 11-E','Sector 11-F'] },
  ]},
  { name: 'Buffer Zone', subAreas: [
    { name: 'Buffer Zone', blocks: ['Sector 15-A-1','Sector 15-A-2','Sector 15-A-3','Sector 15-A-4','Sector 15-A-5','Sector 15-B','Sector 16-A'] },
  ]},
  { name: '2 Min Chowrangi', subAreas: [
    { name: '2 Minute Chowrangi', blocks: [] },
  ]},
  { name: 'North Karachi', subAreas: [
    { name: 'North Karachi', blocks: [
      'Sector 1','Sector 2','Sector 3','Sector 4','Sector 5-A','Sector 5-B','Sector 5-C','Sector 5-K',
      'Sector 7-D','Sector 8','Sector 9','Sector 10','Sector 11-A','Sector 11-B','Sector 11-C','Sector 11-E','Sector 11-K','Sector 11-L',
    ]},
  ]},
  { name: 'F.B Area', subAreas: [
    { name: 'FB Area', blocks: [
      'Block 1','Block 2','Block 3','Block 4','Block 5','Block 6','Block 7','Block 8','Block 9',
      'Block 10','Block 11','Block 12','Block 13','Block 14','Block 15','Block 16','Block 17','Block 18','Block 19','Block 20','Block 21',
    ]},
  ]},
  { name: 'Liaquatabad', subAreas: [
    { name: 'Liaquatabad Town', blocks: ['Block 1','Block 2','Block 3','Block 4','Block 5','Block 6','Block 7','Block 8','Block 9','Block 10','C1 Area'] },
  ]},
  { name: 'Teen Hatti', subAreas: [
    { name: 'Teen Hatti', blocks: [] },
  ]},
  { name: 'Gulistan-e-Jauhar', subAreas: [
    { name: 'Gulistan-e-Jauhar', blocks: [
      'Block 1','Block 2','Block 3','Block 3-A','Block 4','Block 5','Block 6','Block 7','Block 8','Block 9','Block 10',
      'Block 11','Block 12','Block 13','Block 14','Block 15','Block 16','Block 17','Block 18','Block 19','Block 20',
    ]},
    { name: 'Scheme 33 (Jauhar side)', blocks: [] },
    { name: 'Safoora Chowrangi', blocks: [] },
  ]},
  { name: 'Gulshan-e-Iqbal', subAreas: [
    { name: 'Gulshan-e-Iqbal', blocks: [
      'Block 1','Block 2','Block 3','Block 4','Block 4-A','Block 5','Block 6','Block 7','Block 8','Block 9','Block 10','Block 10-A',
      'Block 11','Block 12','Block 13','Block 13-A','Block 13-B','Block 13-C','Block 13-D','Block 13-G','Block 14','Block 15',
      'Block 16','Block 17','Block 18','Block 19',
    ]},
  ]},
  { name: 'Karachi University', subAreas: [
    { name: 'KU Campus', blocks: ['Staff Town','PG Township','Main Campus'] },
  ]},
  { name: 'Moosumiyat', subAreas: [
    { name: 'Moosumiyat Chowrangi', blocks: ['Main University Road'] },
  ]},
  { name: 'Shah Faisal Colony', subAreas: [
    { name: 'Shah Faisal', blocks: ['No. 1','No. 2','No. 3','No. 4','No. 5'] },
    { name: 'Green Town', blocks: [] },
    { name: 'Drigh Colony', blocks: [] },
    { name: 'Natha Khan Goth', blocks: [] },
  ]},
  { name: 'Al Falah Society', subAreas: [
    { name: 'Al Falah Society', blocks: ['Block A','Block B','Block C'] },
    { name: 'Millat Town', blocks: [] },
  ]},
  { name: 'Malir City', subAreas: [
    { name: 'Malir Town', blocks: ['Malir 15','Malir Halt','Malir City'] },
  ]},
  { name: 'Saudabad', subAreas: [
    { name: 'Saudabad', blocks: [] },
    { name: 'Town Khokharapar', blocks: ['Malir Extension'] },
  ]},
  { name: 'Malir Cantt', subAreas: [
    { name: 'Malir Cantt', blocks: ['Sector H','Sector J'] },
    { name: 'Askari 4', blocks: [] },
    { name: 'Askari 5', blocks: [] },
  ]},
  { name: 'Mehmoodabad', subAreas: [
    { name: 'Mehmoodabad', blocks: ['No. 1','No. 2 (TP2)','No. 3','No. 4','No. 5','No. 6'] },
  ]},
  { name: 'Gulzar-e-Hijri', subAreas: [
    { name: 'Gulzar-e-Hijri, Scheme 33', blocks: ['Sector 15-A','Sector 16-A','Sector 20-A','Sector 21-A','Sector 24-A','Sector 25-A','Sector 26-A','Sector 27-A'] },
    { name: 'Societies', blocks: ['Kaneez Fatima Society','Amroha Society','Sachal Sarmast','Saadi Town'] },
  ]},
  { name: 'Defence (DHA)', subAreas: [
    { name: 'Phase 1', blocks: [] },
    { name: 'Phase 2', blocks: ['Phase 2 Ext'] },
    { name: 'Phase 3', blocks: [] },
    { name: 'Phase 4', blocks: [] },
    { name: 'Phase 5', blocks: ['Badar Commercial','Saba Commercial','Tauheed Commercial','Zamzama Commercial'] },
    { name: 'Phase 6', blocks: ['Khayaban-e-Bukhari','Khayaban-e-Rahat','Khayaban-e-Ittehad','Shahbaz Commercial'] },
    { name: 'Phase 7', blocks: ['Khayaban-e-Sehar','Jami Commercial','Phase 7 Ext'] },
    { name: 'Phase 8', blocks: ['Khayaban-e-Iqbal','Khayaban-e-Khyber','Saba Avenue','Zulfiqar Commercial'] },
  ]},
  { name: 'Clifton', subAreas: [
    { name: 'Clifton Blocks', blocks: ['Block 1','Block 2','Block 3','Block 4','Block 5','Block 6','Block 7','Block 8','Block 9'] },
    { name: 'Bath Island', blocks: [] },
    { name: 'Boat Basin', blocks: [] },
    { name: 'Shireen Jinnah Colony', blocks: [] },
  ]},
  { name: 'Sea View', subAreas: [
    { name: 'Sea View Apartments', blocks: ['Phase 5 Ext','Darakhshan Villas'] },
  ]},
  { name: 'Korangi', subAreas: [
    { name: 'Korangi Town', blocks: ['Sector 31','Sector 32','Sector 33-A','Sector 33-B','Sector 33-C'] },
    { name: 'Korangi Industrial Area', blocks: ['Sector 14','Sector 15','Sector 16','Sector 24'] },
    { name: 'Korangi Crossing', blocks: [] },
    { name: 'Bhittai Colony', blocks: [] },
    { name: 'Allah Wala Town', blocks: [] },
  ]},
  { name: 'Old City Area', subAreas: [
    { name: 'Commercial Markets', blocks: ['Kharadar','Mithadar','Jodia Bazar','Sarafa Bazar'] },
    { name: 'Central Saddar', blocks: ['Denso Hall','M.A Jinnah Road','Tibet Center','Ranchore Line'] },
  ]},
  { name: 'Scheme 33', subAreas: [
    { name: 'Scheme 33', blocks: ['Madrass Chowk','Safoora Chowrangi'] },
  ]},
  { name: 'Kaneez Fatima', subAreas: [
    { name: 'Kaneez Fatima Society', blocks: ['Block 1','Block 2'] },
  ]},
  { name: 'Gulshan-e-Maymar', subAreas: [
    { name: 'Gulshan-e-Maymar', blocks: ['Sector Q','Sector R','Sector S','Sector T','Sector U','Sector V','Sector W','Sector X','Sector Y','Sector Z','Sector 52-A'] },
  ]},
  { name: 'Cantt', subAreas: [
    { name: 'Cantt Station', blocks: ['Cantt Bazar'] },
  ]},
  { name: 'PIB Colony', subAreas: [
    { name: 'PIB Colony', blocks: [] },
    { name: 'Amynabad Colony', blocks: [] },
  ]},
  { name: 'Jamshed Road', subAreas: [
    { name: 'Jamshed Road', blocks: ['No. 1','No. 2','No. 3'] },
    { name: 'Fatima Jinnah Colony', blocks: [] },
    { name: 'Hyderabad Colony', blocks: [] },
  ]},
  { name: 'Jail Road', subAreas: [
    { name: 'Jail Road', blocks: ['Jail Chowrangi'] },
  ]},
  { name: 'Numaish', subAreas: [
    { name: 'Numaish Chowrangi', blocks: ['Sector 2-A'] },
  ]},
  { name: 'Soldier Bazar', subAreas: [
    { name: 'Soldier Bazar', blocks: ['No. 1','No. 2','No. 3'] },
    { name: 'Parsi Colony', blocks: [] },
  ]},
  { name: 'Akhtar Colony', subAreas: [
    { name: 'Akhtar Colony', blocks: ['Sector A','Sector B','Sector C','Sector D','Sector E'] },
    { name: 'Kashmir Colony', blocks: ['Sector A','Sector B'] },
  ]},
  { name: 'Qayyumabad', subAreas: [
    { name: 'Qayyumabad', blocks: ['Sector A','Sector B','Sector C','Sector D'] },
  ]},
  { name: 'Bahadurabad', subAreas: [
    { name: 'Bahadurabad', blocks: ['Block 3'] },
    { name: 'Sharfabad', blocks: [] },
  ]},
  { name: 'Azam Town', subAreas: [
    { name: 'Azam Town', blocks: [] },
    { name: 'Azam Basti', blocks: [] },
  ]},
  { name: 'Dalmia', subAreas: [
    { name: 'Dalmia / Mujahid Colony', blocks: ['National Stadium Road'] },
  ]},
  { name: 'Airport', subAreas: [
    { name: 'Airport', blocks: ['Block B','Star Gate','Jinnah Terminal'] },
  ]},
]

// ────────────────────────────────────────────────────────────────────────
// STEP 2: alias map — normalized old spelling -> canonical Area.name.
// This is NOT exhaustive. Anything not covered here (and not matching a
// canonical name after normalization) is reported as UNMATCHED and left
// completely untouched — it will never be silently merged or deleted.
// ────────────────────────────────────────────────────────────────────────
const AREA_ALIASES = {
  'pechs': 'P.E.C.H.S', 'pechs,': 'P.E.C.H.S', '6 pechs': 'P.E.C.H.S',
  'garden': 'Garden East', 'garden headquarters': 'Garden East',
  'garden east': 'Garden East', 'garden east.': 'Garden East', 'garden east k': 'Garden East',
  'garden west': 'Garden West', 'garden west,': 'Garden West',
  'nazimabad': 'Nazimabad', 'nazimabad karachi': 'Nazimabad', 'naizamabad': 'Nazimabad',
  'naizmabad': 'Nazimabad', 'nazimbad': 'Nazimabad', 'nazaimabad': 'Nazimabad', 'nazaimabad no 4': 'Nazimabad',
  'north nazimabad': 'North Nazimabad', 'n nazimabad': 'North Nazimabad', 'north nazimbad': 'North Nazimabad',
  'north naizamabad': 'North Nazimabad', 'north naizamabad.': 'North Nazimabad', 'north naizmabad': 'North Nazimabad',
  'north nazimbad': 'North Nazimabad',
  'bufferzone': 'Buffer Zone', 'bufferzone,': 'Buffer Zone', 'buffer zone': 'Buffer Zone', 'buffer zone.': 'Buffer Zone',
  '2 minutes chowrangi': '2 Min Chowrangi', '2 minute chowrangi': '2 Min Chowrangi',
  'north karachi': 'North Karachi', 'north karach': 'North Karachi', 'north karachi.': 'North Karachi', 'noth karachi': 'North Karachi',
  'fb area': 'F.B Area', 'f.b area': 'F.B Area', 'fb area.': 'F.B Area', 'federal b area': 'F.B Area',
  'liaqatabad': 'Liaquatabad',
  'teen hatthi': 'Teen Hatti', 'teenhati': 'Teen Hatti', 'teenhatti': 'Teen Hatti',
  'gulistan e johar': 'Gulistan-e-Jauhar', 'gulistan-e-johar': 'Gulistan-e-Jauhar',
  'johar': 'Gulistan-e-Jauhar', 'jauhar': 'Gulistan-e-Jauhar', 'jauhar chowrangi': 'Gulistan-e-Jauhar',
  'gulshan -e-iqbal': 'Gulshan-e-Iqbal', 'gulshan e iqbal': 'Gulshan-e-Iqbal', 'gulshan': 'Gulshan-e-Iqbal',
  'shah faisal': 'Shah Faisal Colony', 'shah faisal colony': 'Shah Faisal Colony', 'shah faisa': 'Shah Faisal Colony',
  'shahfaisal': 'Shah Faisal Colony', 'mlir': 'Shah Faisal Colony',
  'malir': 'Malir City', 'malir cantt': 'Malir Cantt', 'malir cantt.': 'Malir Cantt', 'malir cant': 'Malir Cantt',
  'malir count': 'Malir Cantt', 'malir cattle': 'Malir Cantt',
  'saudabad': 'Saudabad',
  'mehoodabad': 'Mehmoodabad', 'mehmoodabad': 'Mehmoodabad', 'mehmmodabad': 'Mehmoodabad',
  'mehmodabad': 'Mehmoodabad', 'mehmoodabad,': 'Mehmoodabad', 'mehmdabad': 'Mehmoodabad', 'mehmoodbad': 'Mehmoodabad',
  'gulzar e hijr': 'Gulzar-e-Hijri', 'gulzar e hijri': 'Gulzar-e-Hijri', 'gulazar-e-hijri': 'Gulzar-e-Hijri',
  'gulzar-e-hijr': 'Gulzar-e-Hijri', 'gulzar hijri': 'Gulzar-e-Hijri', 'gulzar e hijri,': 'Gulzar-e-Hijri',
  'madrass chowrangi': 'Gulzar-e-Hijri', 'gulazar-e-hijri': 'Gulzar-e-Hijri',
  'dha': 'Defence (DHA)', 'dha phase 8': 'Defence (DHA)', 'dha phase 2': 'Defence (DHA)',
  'defense view': 'Defence (DHA)', 'defence view': 'Defence (DHA)', 'defense': 'Defence (DHA)', 'defence': 'Defence (DHA)',
  'phase 2': 'Defence (DHA)', 'phase 2 ext': 'Defence (DHA)', 'defence view.': 'Defence (DHA)',
  'clifton': 'Clifton', 'clifton,': 'Clifton',
  'korangi crossing': 'Korangi', 'crossing': 'Korangi',
  'khalid bin waleed road': 'Old City Area', 'saddar': 'Old City Area', 'saddar,': 'Old City Area',
  'tibet center': 'Old City Area', 'm a jinnah road': 'Old City Area', 'ma jinnah road': 'Old City Area', 'm.a.jinnah road': 'Old City Area',
  'scheme 33': 'Scheme 33',
  'kaneez fatima': 'Kaneez Fatima',
  'maymaar': 'Gulshan-e-Maymar',
  'cantt': 'Cantt', 'cant station': 'Cantt',
  'pib colony': 'PIB Colony', 'pib': 'PIB Colony',
  'jamshed road': 'Jamshed Road', 'jhamshed road': 'Jamshed Road', 'jamshad road': 'Jamshed Road', 'jamshad rd': 'Jamshed Road',
  'jail road': 'Jail Road',
  'numaish': 'Numaish', 'numish': 'Numaish', 'nomaish': 'Numaish',
  'soldier bazar': 'Soldier Bazar', 'soldier bazar no 2': 'Soldier Bazar', 'soldier bazar #1': 'Soldier Bazar', 'soldeir bazar # 1': 'Soldier Bazar',
  'akhtar colony': 'Akhtar Colony', 'aktar clony': 'Akhtar Colony',
  'qayyumabad': 'Qayyumabad', 'qayummabad': 'Qayyumabad', 'qaiyumabad': 'Qayyumabad', 'qyummabad': 'Qayyumabad',
  'bahadurabad': 'Bahadurabad', 'bahadarabad': 'Bahadurabad', 'bahadrubad': 'Bahadurabad', 'bahardurabad': 'Bahadurabad',
  'azam town': 'Azam Town', 'azam basti': 'Azam Town', 'azam basti,': 'Azam Town',
  'dalmia': 'Dalmia',
  'airport': 'Airport', 'khi airport': 'Airport',
}

function canonicalAreaName(rawName) {
  const key = norm(rawName)
  if (AREA_ALIASES[key]) return AREA_ALIASES[key]
  const exact = AREAS.find((a) => norm(a.name) === key)
  return exact ? exact.name : null
}

// ────────────────────────────────────────────────────────────────────────
// mutation wrapper — no-ops (just logs) unless APPLY=true
// ────────────────────────────────────────────────────────────────────────
async function write(label, fn) {
  if (!APPLY) {
    console.log(`  [dry-run] would run: ${label}`)
    return null
  }
  return fn()
}

async function upsertCanonicalStructure() {
  const map = {}
  for (const area of AREAS) {
    let a
    if (APPLY) {
      a = await prisma.area.upsert({
        where: { name: area.name },
        update: { city: 'Karachi' },
        create: { name: area.name, city: 'Karachi' },
      })
    } else {
      a = (await prisma.area.findUnique({ where: { name: area.name } })) || { id: `PENDING:${area.name}` }
    }
    map[area.name] = { id: a.id, subAreas: {} }

    for (const sub of area.subAreas) {
      let s
      if (APPLY) {
        s = await prisma.subArea.upsert({
          where: { name_areaId: { name: sub.name, areaId: a.id } },
          update: {},
          create: { name: sub.name, areaId: a.id },
        })
      } else {
        s = a.id.startsWith?.('PENDING')
          ? { id: `PENDING:${area.name}/${sub.name}` }
          : (await prisma.subArea.findUnique({ where: { name_areaId: { name: sub.name, areaId: a.id } } })) || { id: `PENDING:${area.name}/${sub.name}` }
      }
      map[area.name].subAreas[norm(sub.name)] = { id: s.id, blocks: {} }

      for (const blockName of sub.blocks) {
        let b
        if (APPLY) {
          b = await prisma.block.upsert({
            where: { name_subAreaId: { name: blockName, subAreaId: s.id } },
            update: {},
            create: { name: blockName, subAreaId: s.id },
          })
        } else {
          b = { id: `PENDING:${area.name}/${sub.name}/${blockName}` }
        }
        map[area.name].subAreas[norm(sub.name)].blocks[norm(blockName)] = b.id
      }
    }
  }
  return map
}

async function mergeArea(oldArea, canonicalName, canonicalMap) {
  const target = canonicalMap[canonicalName]
  if (!target || oldArea.id === target.id) return

  console.log(`\nMerging Area "${oldArea.name}" -> "${canonicalName}"`)

  const oldSubAreas = await prisma.subArea.findMany({
    where: { areaId: oldArea.id },
    include: { blocks: true },
  })

  for (const oldSub of oldSubAreas) {
    const subKey = norm(oldSub.name)
    let targetSubId = target.subAreas[subKey]?.id

    if (!targetSubId) {
      // no canonical sub-area with this name -> keep the real data, just reparent it
      console.log(`  reparent SubArea "${oldSub.name}" under "${canonicalName}"`)
      const updated = await write(`subArea.update(${oldSub.id} -> areaId ${target.id})`, () =>
        prisma.subArea.update({ where: { id: oldSub.id }, data: { areaId: target.id } })
      )
      targetSubId = updated?.id || oldSub.id
      target.subAreas[subKey] = { id: targetSubId, blocks: {} }
      for (const b of oldSub.blocks) target.subAreas[subKey].blocks[norm(b.name)] = b.id
      continue
    }

    if (targetSubId === oldSub.id) continue

    for (const oldBlock of oldSub.blocks) {
      const blockKey = norm(oldBlock.name)
      let targetBlockId = target.subAreas[subKey].blocks[blockKey]

      if (!targetBlockId) {
        console.log(`  reparent Block "${oldBlock.name}" under canonical SubArea "${oldSub.name}"`)
        const updated = await write(`block.update(${oldBlock.id} -> subAreaId ${targetSubId})`, () =>
          prisma.block.update({ where: { id: oldBlock.id }, data: { subAreaId: targetSubId } })
        )
        target.subAreas[subKey].blocks[blockKey] = updated?.id || oldBlock.id
        continue
      }

      if (targetBlockId === oldBlock.id) continue

      console.log(`  merge duplicate Block "${oldBlock.name}" -> existing block ${targetBlockId}`)
      await write(`employee.updateMany(blockId ${oldBlock.id} -> ${targetBlockId})`, () =>
        prisma.employee.updateMany({ where: { blockId: oldBlock.id }, data: { blockId: targetBlockId } })
      )
      await write(`block.delete(${oldBlock.id})`, () => prisma.block.delete({ where: { id: oldBlock.id } }))
    }

    console.log(`  merge duplicate SubArea "${oldSub.name}" -> existing subArea ${targetSubId}`)
    await write(`employee.updateMany(subAreaId -> ${targetSubId})`, () =>
      prisma.employee.updateMany({ where: { subAreaId: oldSub.id }, data: { subAreaId: targetSubId } })
    )
    await write(`route.updateMany(subAreaId -> ${targetSubId})`, () =>
      prisma.route.updateMany({ where: { subAreaId: oldSub.id }, data: { subAreaId: targetSubId } })
    )
    await write(`ride.updateMany(subAreaId -> ${targetSubId})`, () =>
      prisma.ride.updateMany({ where: { subAreaId: oldSub.id }, data: { subAreaId: targetSubId } })
    )
    await write(`subArea.delete(${oldSub.id})`, () => prisma.subArea.delete({ where: { id: oldSub.id } }))
  }

  await write(`employee.updateMany(areaId -> ${target.id})`, () =>
    prisma.employee.updateMany({ where: { areaId: oldArea.id }, data: { areaId: target.id } })
  )
  await write(`route.updateMany(areaId -> ${target.id})`, () =>
    prisma.route.updateMany({ where: { areaId: oldArea.id }, data: { areaId: target.id } })
  )
  await write(`ride.updateMany(areaId -> ${target.id})`, () =>
    prisma.ride.updateMany({ where: { areaId: oldArea.id }, data: { areaId: target.id } })
  )
  await write(`area.delete(${oldArea.id})`, () => prisma.area.delete({ where: { id: oldArea.id } }))
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (will write to DB)' : 'DRY RUN (read-only, use APPLY=true to execute)'}\n`)

  console.log('Step 1/2: canonical structure (existing IDs preserved where names already match)...')
  const canonicalMap = await upsertCanonicalStructure()

  console.log('\nStep 2/2: scanning existing areas for duplicates to merge...')
  const allAreas = await prisma.area.findMany()
  const unmatched = []

  for (const area of allAreas) {
    const canonicalName = canonicalAreaName(area.name)
    if (!canonicalName) {
      unmatched.push(area.name)
      continue
    }
    await mergeArea(area, canonicalName, canonicalMap)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(APPLY ? 'APPLY run complete.' : 'DRY RUN complete — nothing was written.')
  if (unmatched.length) {
    console.log(`\n${unmatched.length} area name(s) had no canonical match — left completely untouched:`)
    unmatched.forEach((n) => console.log('  -', n))
    console.log('\nAdd these to AREA_ALIASES above if they\'re really duplicates, then re-run.')
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })