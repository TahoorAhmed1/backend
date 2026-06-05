-- ============================================================
-- seed_fixes.sql
-- Fixes for 6 data-quality issues in seed.sql
-- Generated automatically — apply AFTER seed.sql
-- ============================================================

BEGIN;

-- ============================================================
-- FIX 1: vehicles — deduplicate registrations
-- ============================================================
-- 46 vehicle rows are exact-registration duplicates (case/space
-- variants or cross-vendor entries for the same physical vehicle).
-- Strategy:
--   a) Any FK in employee_route_assignments pointing to a dup ID
--      is redirected to the canonical (first-seen) ID.
--   b) Then the duplicate rows are deleted.
-- Cross-vendor duplicates (vehicles released from one vendor and
-- re-registered with another) are consolidated under the first
-- canonical ID; the vendor_id on the canonical row is left as-is
-- because that vendor held it first.  Admins should update the
-- canonical row's vendor_id if the vehicle has fully transferred.

-- 1a. Redirect FK references in employee_route_assignments

UPDATE employee_route_assignments SET vehicle_id = 1 WHERE vehicle_id = 22;
UPDATE employee_route_assignments SET vehicle_id = 13 WHERE vehicle_id = 36;
UPDATE employee_route_assignments SET vehicle_id = 10 WHERE vehicle_id = 40;
UPDATE employee_route_assignments SET vehicle_id = 31 WHERE vehicle_id = 61;
UPDATE employee_route_assignments SET vehicle_id = 64 WHERE vehicle_id = 69;
UPDATE employee_route_assignments SET vehicle_id = 65 WHERE vehicle_id = 70;
UPDATE employee_route_assignments SET vehicle_id = 30 WHERE vehicle_id = 77;
UPDATE employee_route_assignments SET vehicle_id = 71 WHERE vehicle_id = 78;
UPDATE employee_route_assignments SET vehicle_id = 64 WHERE vehicle_id = 82;
UPDATE employee_route_assignments SET vehicle_id = 29 WHERE vehicle_id = 89;
UPDATE employee_route_assignments SET vehicle_id = 46 WHERE vehicle_id = 92;
UPDATE employee_route_assignments SET vehicle_id = 3 WHERE vehicle_id = 95;
UPDATE employee_route_assignments SET vehicle_id = 1 WHERE vehicle_id = 127;
UPDATE employee_route_assignments SET vehicle_id = 73 WHERE vehicle_id = 138;
UPDATE employee_route_assignments SET vehicle_id = 53 WHERE vehicle_id = 140;
UPDATE employee_route_assignments SET vehicle_id = 18 WHERE vehicle_id = 143;
UPDATE employee_route_assignments SET vehicle_id = 85 WHERE vehicle_id = 144;
UPDATE employee_route_assignments SET vehicle_id = 73 WHERE vehicle_id = 150;
UPDATE employee_route_assignments SET vehicle_id = 58 WHERE vehicle_id = 153;
UPDATE employee_route_assignments SET vehicle_id = 35 WHERE vehicle_id = 156;
UPDATE employee_route_assignments SET vehicle_id = 13 WHERE vehicle_id = 157;
UPDATE employee_route_assignments SET vehicle_id = 37 WHERE vehicle_id = 158;
UPDATE employee_route_assignments SET vehicle_id = 38 WHERE vehicle_id = 159;
UPDATE employee_route_assignments SET vehicle_id = 171 WHERE vehicle_id = 176;
UPDATE employee_route_assignments SET vehicle_id = 162 WHERE vehicle_id = 177;
UPDATE employee_route_assignments SET vehicle_id = 171 WHERE vehicle_id = 178;
UPDATE employee_route_assignments SET vehicle_id = 175 WHERE vehicle_id = 180;
UPDATE employee_route_assignments SET vehicle_id = 174 WHERE vehicle_id = 181;
UPDATE employee_route_assignments SET vehicle_id = 167 WHERE vehicle_id = 185;
UPDATE employee_route_assignments SET vehicle_id = 160 WHERE vehicle_id = 191;
UPDATE employee_route_assignments SET vehicle_id = 167 WHERE vehicle_id = 193;
UPDATE employee_route_assignments SET vehicle_id = 194 WHERE vehicle_id = 195;
UPDATE employee_route_assignments SET vehicle_id = 160 WHERE vehicle_id = 196;
UPDATE employee_route_assignments SET vehicle_id = 192 WHERE vehicle_id = 197;
UPDATE employee_route_assignments SET vehicle_id = 39 WHERE vehicle_id = 199;
UPDATE employee_route_assignments SET vehicle_id = 183 WHERE vehicle_id = 202;
UPDATE employee_route_assignments SET vehicle_id = 11 WHERE vehicle_id = 203;
UPDATE employee_route_assignments SET vehicle_id = 163 WHERE vehicle_id = 204;
UPDATE employee_route_assignments SET vehicle_id = 166 WHERE vehicle_id = 206;
UPDATE employee_route_assignments SET vehicle_id = 26 WHERE vehicle_id = 209;
UPDATE employee_route_assignments SET vehicle_id = 118 WHERE vehicle_id = 218;
UPDATE employee_route_assignments SET vehicle_id = 103 WHERE vehicle_id = 229;
UPDATE employee_route_assignments SET vehicle_id = 222 WHERE vehicle_id = 231;
UPDATE employee_route_assignments SET vehicle_id = 225 WHERE vehicle_id = 232;
UPDATE employee_route_assignments SET vehicle_id = 247 WHERE vehicle_id = 249;
UPDATE employee_route_assignments SET vehicle_id = 226 WHERE vehicle_id = 252;

-- 1b. Delete duplicate vehicle rows

DELETE FROM vehicles WHERE id IN (22, 36, 40, 61, 69, 70, 77, 78, 82, 89, 92, 95, 127, 138, 140, 143, 144, 150, 153, 156, 157, 158, 159, 176, 177, 178, 180, 181, 185, 191, 193, 195, 196, 197, 199, 202, 203, 204, 206, 209, 218, 229, 231, 232, 249, 252);

-- ============================================================
-- FIX 2 & 3: Add driver_id FK to routes; add current_driver_id
--            FK to vehicles
-- ============================================================
-- Both columns were missing, making it impossible to query
-- "which driver runs route X" or "which driver is in vehicle Y"
-- without fragile string matching on route_name.

ALTER TABLE routes   ADD COLUMN IF NOT EXISTS primary_driver_id   INTEGER REFERENCES drivers(id);
ALTER TABLE routes   ADD COLUMN IF NOT EXISTS secondary_driver_id INTEGER REFERENCES drivers(id);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS current_driver_id   INTEGER REFERENCES drivers(id);

-- Populate routes.primary_driver_id / secondary_driver_id
-- (derived from the embedded name token in route_name)

UPDATE routes SET primary_driver_id = 260 WHERE id = 1;
UPDATE routes SET primary_driver_id = 114 WHERE id = 2;
UPDATE routes SET primary_driver_id = 114 WHERE id = 3;
UPDATE routes SET primary_driver_id = 114 WHERE id = 4;
UPDATE routes SET primary_driver_id = 114 WHERE id = 5;
UPDATE routes SET secondary_driver_id = 64 WHERE id = 5;
UPDATE routes SET primary_driver_id = 13 WHERE id = 6;
UPDATE routes SET primary_driver_id = 13 WHERE id = 7;
UPDATE routes SET primary_driver_id = 13 WHERE id = 8;
UPDATE routes SET primary_driver_id = 13 WHERE id = 9;
UPDATE routes SET primary_driver_id = 13 WHERE id = 10;
UPDATE routes SET primary_driver_id = 13 WHERE id = 11;
UPDATE routes SET primary_driver_id = 13 WHERE id = 12;
UPDATE routes SET primary_driver_id = 248 WHERE id = 13;
UPDATE routes SET primary_driver_id = 248 WHERE id = 14;
UPDATE routes SET primary_driver_id = 248 WHERE id = 15;
UPDATE routes SET primary_driver_id = 248 WHERE id = 16;
UPDATE routes SET primary_driver_id = 117 WHERE id = 17;
UPDATE routes SET primary_driver_id = 57 WHERE id = 18;
UPDATE routes SET primary_driver_id = 57 WHERE id = 19;
UPDATE routes SET primary_driver_id = 57 WHERE id = 20;
UPDATE routes SET primary_driver_id = 57 WHERE id = 21;
UPDATE routes SET primary_driver_id = 57 WHERE id = 22;
UPDATE routes SET primary_driver_id = 128 WHERE id = 23;
UPDATE routes SET primary_driver_id = 128 WHERE id = 24;
UPDATE routes SET primary_driver_id = 128 WHERE id = 25;
UPDATE routes SET primary_driver_id = 128 WHERE id = 26;
UPDATE routes SET primary_driver_id = 128 WHERE id = 27;
UPDATE routes SET primary_driver_id = 62 WHERE id = 28;
UPDATE routes SET primary_driver_id = 235 WHERE id = 29;
UPDATE routes SET primary_driver_id = 105 WHERE id = 30;
UPDATE routes SET secondary_driver_id = 135 WHERE id = 30;
UPDATE routes SET primary_driver_id = 105 WHERE id = 31;
UPDATE routes SET secondary_driver_id = 135 WHERE id = 31;
UPDATE routes SET primary_driver_id = 105 WHERE id = 32;
UPDATE routes SET secondary_driver_id = 135 WHERE id = 32;
UPDATE routes SET primary_driver_id = 105 WHERE id = 33;
UPDATE routes SET secondary_driver_id = 135 WHERE id = 33;
UPDATE routes SET primary_driver_id = 105 WHERE id = 34;
UPDATE routes SET secondary_driver_id = 135 WHERE id = 34;
UPDATE routes SET primary_driver_id = 135 WHERE id = 35;
UPDATE routes SET primary_driver_id = 135 WHERE id = 36;
UPDATE routes SET primary_driver_id = 135 WHERE id = 37;
UPDATE routes SET primary_driver_id = 135 WHERE id = 38;
UPDATE routes SET primary_driver_id = 135 WHERE id = 39;
UPDATE routes SET primary_driver_id = 135 WHERE id = 40;
UPDATE routes SET primary_driver_id = 135 WHERE id = 41;
UPDATE routes SET primary_driver_id = 135 WHERE id = 42;
UPDATE routes SET primary_driver_id = 135 WHERE id = 43;
UPDATE routes SET primary_driver_id = 135 WHERE id = 44;
UPDATE routes SET primary_driver_id = 135 WHERE id = 45;
UPDATE routes SET secondary_driver_id = 167 WHERE id = 45;
UPDATE routes SET primary_driver_id = 135 WHERE id = 46;
UPDATE routes SET secondary_driver_id = 166 WHERE id = 46;
UPDATE routes SET primary_driver_id = 244 WHERE id = 47;
UPDATE routes SET primary_driver_id = 44 WHERE id = 48;
UPDATE routes SET primary_driver_id = 44 WHERE id = 49;
UPDATE routes SET primary_driver_id = 155 WHERE id = 50;
UPDATE routes SET primary_driver_id = 155 WHERE id = 51;
UPDATE routes SET primary_driver_id = 155 WHERE id = 52;
UPDATE routes SET primary_driver_id = 155 WHERE id = 53;
UPDATE routes SET secondary_driver_id = 114 WHERE id = 53;
UPDATE routes SET primary_driver_id = 1 WHERE id = 54;
UPDATE routes SET primary_driver_id = 33 WHERE id = 55;
UPDATE routes SET primary_driver_id = 33 WHERE id = 56;
UPDATE routes SET primary_driver_id = 33 WHERE id = 57;
UPDATE routes SET primary_driver_id = 33 WHERE id = 58;
UPDATE routes SET primary_driver_id = 33 WHERE id = 59;
UPDATE routes SET primary_driver_id = 33 WHERE id = 60;
UPDATE routes SET primary_driver_id = 58 WHERE id = 61;
UPDATE routes SET primary_driver_id = 157 WHERE id = 62;
UPDATE routes SET primary_driver_id = 157 WHERE id = 63;
UPDATE routes SET primary_driver_id = 157 WHERE id = 64;
UPDATE routes SET primary_driver_id = 157 WHERE id = 65;
UPDATE routes SET primary_driver_id = 157 WHERE id = 66;
UPDATE routes SET primary_driver_id = 157 WHERE id = 67;
UPDATE routes SET primary_driver_id = 157 WHERE id = 68;
UPDATE routes SET primary_driver_id = 151 WHERE id = 69;
UPDATE routes SET primary_driver_id = 151 WHERE id = 70;
UPDATE routes SET primary_driver_id = 151 WHERE id = 71;
UPDATE routes SET secondary_driver_id = 130 WHERE id = 71;
UPDATE routes SET primary_driver_id = 246 WHERE id = 72;
UPDATE routes SET primary_driver_id = 246 WHERE id = 73;
UPDATE routes SET primary_driver_id = 242 WHERE id = 74;
UPDATE routes SET primary_driver_id = 246 WHERE id = 75;
UPDATE routes SET primary_driver_id = 246 WHERE id = 76;
UPDATE routes SET primary_driver_id = 246 WHERE id = 77;
UPDATE routes SET primary_driver_id = 237 WHERE id = 78;
UPDATE routes SET primary_driver_id = 3 WHERE id = 79;
UPDATE routes SET primary_driver_id = 3 WHERE id = 80;
UPDATE routes SET primary_driver_id = 3 WHERE id = 81;
UPDATE routes SET primary_driver_id = 3 WHERE id = 82;
UPDATE routes SET primary_driver_id = 3 WHERE id = 83;
UPDATE routes SET primary_driver_id = 3 WHERE id = 84;
UPDATE routes SET primary_driver_id = 3 WHERE id = 85;
UPDATE routes SET primary_driver_id = 233 WHERE id = 86;
UPDATE routes SET primary_driver_id = 233 WHERE id = 87;
UPDATE routes SET primary_driver_id = 149 WHERE id = 88;
UPDATE routes SET primary_driver_id = 149 WHERE id = 89;
UPDATE routes SET primary_driver_id = 149 WHERE id = 90;
UPDATE routes SET primary_driver_id = 231 WHERE id = 91;
UPDATE routes SET primary_driver_id = 231 WHERE id = 92;
UPDATE routes SET primary_driver_id = 231 WHERE id = 93;
UPDATE routes SET primary_driver_id = 231 WHERE id = 94;
UPDATE routes SET primary_driver_id = 156 WHERE id = 95;
UPDATE routes SET primary_driver_id = 258 WHERE id = 96;
UPDATE routes SET primary_driver_id = 195 WHERE id = 97;
UPDATE routes SET primary_driver_id = 195 WHERE id = 98;
UPDATE routes SET primary_driver_id = 195 WHERE id = 99;
UPDATE routes SET primary_driver_id = 195 WHERE id = 100;
UPDATE routes SET primary_driver_id = 77 WHERE id = 101;
UPDATE routes SET primary_driver_id = 83 WHERE id = 102;
UPDATE routes SET primary_driver_id = 83 WHERE id = 103;
UPDATE routes SET primary_driver_id = 83 WHERE id = 104;
UPDATE routes SET primary_driver_id = 20 WHERE id = 105;
UPDATE routes SET primary_driver_id = 20 WHERE id = 106;
UPDATE routes SET primary_driver_id = 54 WHERE id = 107;
UPDATE routes SET primary_driver_id = 54 WHERE id = 108;
UPDATE routes SET primary_driver_id = 54 WHERE id = 109;
UPDATE routes SET primary_driver_id = 54 WHERE id = 110;
UPDATE routes SET primary_driver_id = 241 WHERE id = 112;
UPDATE routes SET primary_driver_id = 259 WHERE id = 113;
UPDATE routes SET primary_driver_id = 226 WHERE id = 114;
UPDATE routes SET primary_driver_id = 226 WHERE id = 115;
UPDATE routes SET primary_driver_id = 226 WHERE id = 116;
UPDATE routes SET primary_driver_id = 160 WHERE id = 117;
UPDATE routes SET primary_driver_id = 24 WHERE id = 118;
UPDATE routes SET primary_driver_id = 24 WHERE id = 119;
UPDATE routes SET primary_driver_id = 24 WHERE id = 120;
UPDATE routes SET primary_driver_id = 223 WHERE id = 121;
UPDATE routes SET primary_driver_id = 223 WHERE id = 122;
UPDATE routes SET primary_driver_id = 223 WHERE id = 123;
UPDATE routes SET primary_driver_id = 223 WHERE id = 124;
UPDATE routes SET primary_driver_id = 137 WHERE id = 125;
UPDATE routes SET primary_driver_id = 238 WHERE id = 126;
UPDATE routes SET primary_driver_id = 247 WHERE id = 128;
UPDATE routes SET primary_driver_id = 247 WHERE id = 129;
UPDATE routes SET primary_driver_id = 56 WHERE id = 130;
UPDATE routes SET primary_driver_id = 56 WHERE id = 131;
UPDATE routes SET primary_driver_id = 56 WHERE id = 132;
UPDATE routes SET primary_driver_id = 230 WHERE id = 133;
UPDATE routes SET primary_driver_id = 230 WHERE id = 134;
UPDATE routes SET primary_driver_id = 230 WHERE id = 135;
UPDATE routes SET primary_driver_id = 230 WHERE id = 136;
UPDATE routes SET primary_driver_id = 50 WHERE id = 137;
UPDATE routes SET primary_driver_id = 240 WHERE id = 138;
UPDATE routes SET primary_driver_id = 236 WHERE id = 139;
UPDATE routes SET primary_driver_id = 25 WHERE id = 140;
UPDATE routes SET primary_driver_id = 25 WHERE id = 141;
UPDATE routes SET primary_driver_id = 25 WHERE id = 142;
UPDATE routes SET primary_driver_id = 25 WHERE id = 143;
UPDATE routes SET primary_driver_id = 225 WHERE id = 144;
UPDATE routes SET primary_driver_id = 225 WHERE id = 145;
UPDATE routes SET primary_driver_id = 225 WHERE id = 146;
UPDATE routes SET primary_driver_id = 225 WHERE id = 147;
UPDATE routes SET primary_driver_id = 163 WHERE id = 148;
UPDATE routes SET primary_driver_id = 163 WHERE id = 149;
UPDATE routes SET primary_driver_id = 163 WHERE id = 150;
UPDATE routes SET primary_driver_id = 163 WHERE id = 151;
UPDATE routes SET primary_driver_id = 232 WHERE id = 152;
UPDATE routes SET primary_driver_id = 228 WHERE id = 153;
UPDATE routes SET primary_driver_id = 228 WHERE id = 154;
UPDATE routes SET primary_driver_id = 228 WHERE id = 155;
UPDATE routes SET primary_driver_id = 228 WHERE id = 156;
UPDATE routes SET primary_driver_id = 171 WHERE id = 157;
UPDATE routes SET primary_driver_id = 181 WHERE id = 159;
UPDATE routes SET primary_driver_id = 181 WHERE id = 160;
UPDATE routes SET primary_driver_id = 36 WHERE id = 161;
UPDATE routes SET primary_driver_id = 36 WHERE id = 162;
UPDATE routes SET primary_driver_id = 36 WHERE id = 163;
UPDATE routes SET primary_driver_id = 36 WHERE id = 164;
UPDATE routes SET primary_driver_id = 245 WHERE id = 165;
UPDATE routes SET primary_driver_id = 255 WHERE id = 166;
UPDATE routes SET primary_driver_id = 167 WHERE id = 167;
UPDATE routes SET primary_driver_id = 167 WHERE id = 168;
UPDATE routes SET primary_driver_id = 167 WHERE id = 169;
UPDATE routes SET primary_driver_id = 167 WHERE id = 170;
UPDATE routes SET primary_driver_id = 19 WHERE id = 171;
UPDATE routes SET primary_driver_id = 19 WHERE id = 172;
UPDATE routes SET primary_driver_id = 37 WHERE id = 173;
UPDATE routes SET primary_driver_id = 145 WHERE id = 174;
UPDATE routes SET primary_driver_id = 145 WHERE id = 175;
UPDATE routes SET primary_driver_id = 145 WHERE id = 176;
UPDATE routes SET primary_driver_id = 145 WHERE id = 177;
UPDATE routes SET primary_driver_id = 26 WHERE id = 178;
UPDATE routes SET primary_driver_id = 26 WHERE id = 179;
UPDATE routes SET primary_driver_id = 12 WHERE id = 180;
UPDATE routes SET primary_driver_id = 90 WHERE id = 181;
UPDATE routes SET secondary_driver_id = 114 WHERE id = 181;
UPDATE routes SET primary_driver_id = 90 WHERE id = 182;
UPDATE routes SET secondary_driver_id = 28 WHERE id = 182;
UPDATE routes SET primary_driver_id = 90 WHERE id = 183;
UPDATE routes SET primary_driver_id = 90 WHERE id = 184;
UPDATE routes SET primary_driver_id = 136 WHERE id = 185;
UPDATE routes SET primary_driver_id = 136 WHERE id = 187;
UPDATE routes SET secondary_driver_id = 171 WHERE id = 187;
UPDATE routes SET primary_driver_id = 254 WHERE id = 188;
UPDATE routes SET primary_driver_id = 254 WHERE id = 189;
UPDATE routes SET primary_driver_id = 127 WHERE id = 190;
UPDATE routes SET primary_driver_id = 127 WHERE id = 191;
UPDATE routes SET primary_driver_id = 127 WHERE id = 192;
UPDATE routes SET primary_driver_id = 127 WHERE id = 193;
UPDATE routes SET primary_driver_id = 239 WHERE id = 194;
UPDATE routes SET primary_driver_id = 130 WHERE id = 195;
UPDATE routes SET secondary_driver_id = 155 WHERE id = 195;
UPDATE routes SET primary_driver_id = 130 WHERE id = 196;
UPDATE routes SET secondary_driver_id = 156 WHERE id = 196;
UPDATE routes SET primary_driver_id = 130 WHERE id = 197;
UPDATE routes SET primary_driver_id = 87 WHERE id = 198;
UPDATE routes SET primary_driver_id = 39 WHERE id = 199;
UPDATE routes SET primary_driver_id = 39 WHERE id = 200;
UPDATE routes SET primary_driver_id = 39 WHERE id = 201;
UPDATE routes SET primary_driver_id = 39 WHERE id = 202;
UPDATE routes SET primary_driver_id = 234 WHERE id = 203;
UPDATE routes SET primary_driver_id = 251 WHERE id = 204;
UPDATE routes SET primary_driver_id = 49 WHERE id = 205;
UPDATE routes SET primary_driver_id = 229 WHERE id = 206;
UPDATE routes SET primary_driver_id = 229 WHERE id = 207;
UPDATE routes SET primary_driver_id = 229 WHERE id = 208;
UPDATE routes SET primary_driver_id = 229 WHERE id = 209;
UPDATE routes SET primary_driver_id = 252 WHERE id = 210;
UPDATE routes SET primary_driver_id = 35 WHERE id = 215;
UPDATE routes SET primary_driver_id = 227 WHERE id = 216;
UPDATE routes SET primary_driver_id = 227 WHERE id = 217;
UPDATE routes SET primary_driver_id = 7 WHERE id = 218;
UPDATE routes SET primary_driver_id = 32 WHERE id = 219;
UPDATE routes SET primary_driver_id = 28 WHERE id = 220;
UPDATE routes SET primary_driver_id = 28 WHERE id = 221;
UPDATE routes SET primary_driver_id = 28 WHERE id = 222;
UPDATE routes SET primary_driver_id = 28 WHERE id = 223;
UPDATE routes SET primary_driver_id = 154 WHERE id = 224;
UPDATE routes SET primary_driver_id = 154 WHERE id = 225;
UPDATE routes SET primary_driver_id = 154 WHERE id = 226;
UPDATE routes SET primary_driver_id = 154 WHERE id = 227;
UPDATE routes SET primary_driver_id = 154 WHERE id = 228;
UPDATE routes SET primary_driver_id = 154 WHERE id = 229;
UPDATE routes SET primary_driver_id = 154 WHERE id = 230;
UPDATE routes SET primary_driver_id = 154 WHERE id = 231;
UPDATE routes SET primary_driver_id = 154 WHERE id = 232;
UPDATE routes SET primary_driver_id = 154 WHERE id = 233;
UPDATE routes SET primary_driver_id = 253 WHERE id = 234;
UPDATE routes SET primary_driver_id = 256 WHERE id = 235;
UPDATE routes SET secondary_driver_id = 114 WHERE id = 235;
UPDATE routes SET primary_driver_id = 148 WHERE id = 236;
UPDATE routes SET primary_driver_id = 148 WHERE id = 237;
UPDATE routes SET primary_driver_id = 1 WHERE id = 238;
UPDATE routes SET primary_driver_id = 1 WHERE id = 239;
UPDATE routes SET primary_driver_id = 1 WHERE id = 240;
UPDATE routes SET primary_driver_id = 171 WHERE id = 241;
UPDATE routes SET primary_driver_id = 90 WHERE id = 242;

-- ============================================================
-- FIX 4: Add vehicle_route_assignments bridge table
-- ============================================================
-- This replaces the implicit route_name string matching with a
-- proper many-to-many between vehicles, routes, and drivers.
-- Each row = one vehicle assigned to one route for one shift.

CREATE TABLE IF NOT EXISTS vehicle_route_assignments (
    id         SERIAL PRIMARY KEY,
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    route_id   INTEGER NOT NULL REFERENCES routes(id),
    driver_id  INTEGER          REFERENCES drivers(id),
    role       TEXT    NOT NULL DEFAULT 'PRIMARY',   -- PRIMARY / SECONDARY
    shift_timing TEXT,
    assigned_at TIMESTAMP DEFAULT NOW(),
    notes      TEXT,
    UNIQUE (vehicle_id, route_id, role)
);

COMMENT ON TABLE vehicle_route_assignments IS
  'Links each vehicle to the route(s) it serves and the driver(s) assigned.
   Replaces the implicit name-string matching that was the only way to join
   vehicles -> routes -> drivers before this fix.';


-- ============================================================
-- FIX 5: paired driver rows in employee_route_assignments
-- ============================================================
-- 16 routes have a "Driver A / Driver B" compound name.
-- The driver_name column is a free-text string so it works for
-- display, but cannot FK-join.  We add two nullable FK columns
-- (primary_driver_id, secondary_driver_id) to make joins possible
-- while keeping driver_name for backward compatibility.

ALTER TABLE employee_route_assignments
    ADD COLUMN IF NOT EXISTS primary_driver_id   INTEGER REFERENCES drivers(id),
    ADD COLUMN IF NOT EXISTS secondary_driver_id INTEGER REFERENCES drivers(id);

-- Back-fill primary_driver_id from routes.primary_driver_id
UPDATE employee_route_assignments era
SET    primary_driver_id   = r.primary_driver_id,
       secondary_driver_id = r.secondary_driver_id
FROM   routes r
WHERE  era.route_id = r.id;

-- ============================================================
-- FIX 6: pd_historical_records — add FK reference to employees
-- ============================================================
-- emp_id is stored as a raw integer (the employee code) with no
-- FK constraint, making cross-month joins rely on implicit type
-- coercion and preventing the query planner from using indexes on
-- the employees table.

ALTER TABLE pd_historical_records
    ADD COLUMN IF NOT EXISTS employee_fk_id INTEGER REFERENCES employees(id);

-- Populate using the emp_id → employees.emp_id join
-- (employees.emp_id is the business key matching pd_historical_records.emp_id)
UPDATE pd_historical_records h
SET    employee_fk_id = e.id
FROM   employees e
WHERE  e.emp_id = h.emp_id::TEXT
   AND h.employee_fk_id IS NULL;

-- Report how many rows were resolved
DO $$
DECLARE
    total   INT;
    linked  INT;
    missing INT;
BEGIN
    SELECT COUNT(*) INTO total  FROM pd_historical_records;
    SELECT COUNT(*) INTO linked FROM pd_historical_records WHERE employee_fk_id IS NOT NULL;
    missing := total - linked;
    RAISE NOTICE 'pd_historical_records: % / % rows linked to employees (% unresolved — employees added after March snapshot)',
        linked, total, missing;
END $$;

-- ============================================================
-- FIX 7 (bonus): normalise vehicle status values
-- ============================================================
-- The status column has inconsistent free-text values such as
-- 'In-Acive', 'IN- Active', 'In-Acive-2023', 'Black List', '4', '1'.
-- Normalise to: Active | Inactive | Blacklisted | Released | Unknown

UPDATE vehicles SET status = 'Active'      WHERE LOWER(TRIM(status)) IN ('active', '1');
UPDATE vehicles SET status = 'Inactive'    WHERE LOWER(TRIM(status)) LIKE 'in%activ%'
                                              AND LOWER(TRIM(status)) NOT LIKE '%black%'
                                              AND LOWER(TRIM(status)) NOT LIKE 'releas%';
UPDATE vehicles SET status = 'Blacklisted' WHERE LOWER(TRIM(status)) LIKE '%black%';
UPDATE vehicles SET status = 'Released'    WHERE LOWER(TRIM(status)) LIKE 'releas%'
                                              OR  TRIM(status) = '4';
UPDATE vehicles SET status = 'Unknown'     WHERE status NOT IN ('Active','Inactive','Blacklisted','Released');

-- ============================================================
-- Indexes to support the new FK columns
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_routes_primary_driver     ON routes(primary_driver_id);
CREATE INDEX IF NOT EXISTS idx_routes_secondary_driver   ON routes(secondary_driver_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_current_driver   ON vehicles(current_driver_id);
CREATE INDEX IF NOT EXISTS idx_era_primary_driver        ON employee_route_assignments(primary_driver_id);
CREATE INDEX IF NOT EXISTS idx_era_secondary_driver      ON employee_route_assignments(secondary_driver_id);
CREATE INDEX IF NOT EXISTS idx_pd_hist_employee_fk       ON pd_historical_records(employee_fk_id);
CREATE INDEX IF NOT EXISTS idx_vra_vehicle               ON vehicle_route_assignments(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vra_route                 ON vehicle_route_assignments(route_id);
CREATE INDEX IF NOT EXISTS idx_vra_driver                ON vehicle_route_assignments(driver_id);

COMMIT;

-- ============================================================
-- Verification queries (run after applying fixes)
-- ============================================================
/*
-- Check no duplicate registrations remain
SELECT registration_number, COUNT(*) n
FROM vehicles
GROUP BY LOWER(REPLACE(REPLACE(registration_number,' ',''),'-',''))
HAVING COUNT(*) > 1;

-- Check routes have driver FKs populated
SELECT COUNT(*) total,
       SUM(CASE WHEN primary_driver_id IS NOT NULL THEN 1 END) with_driver
FROM routes;

-- Check ERA driver FKs
SELECT COUNT(*) total,
       SUM(CASE WHEN primary_driver_id IS NOT NULL THEN 1 END) linked
FROM employee_route_assignments;

-- Check pd_historical FK resolution rate
SELECT COUNT(*) total,
       SUM(CASE WHEN employee_fk_id IS NOT NULL THEN 1 END) linked
FROM pd_historical_records;
*/
