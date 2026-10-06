const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeVendorLateStatus,
  calculateVendorLateStatus,
  buildVendorValidationSummary,
} = require("../utils/vendorLateStatus");

test("normalizeVendorLateStatus handles all vendor statuses", () => {
  assert.equal(normalizeVendorLateStatus("Late"), "LATE");
  assert.equal(normalizeVendorLateStatus("On time late"), "ON_TIME_LATE");
  assert.equal(normalizeVendorLateStatus("On Time"), "ON_TIME");
  assert.equal(normalizeVendorLateStatus("only drop"), "ONLY_DROP");
  assert.equal(normalizeVendorLateStatus("unknown"), "UNCLASSIFIED");
});

test("operator status stays authoritative and cannot be auto-rewritten from service type", () => {
  assert.equal(calculateVendorLateStatus("LATE", null, null), "LATE");
  assert.equal(calculateVendorLateStatus("On Time", null, null), "ON_TIME");
  assert.equal(calculateVendorLateStatus("DROP_ONLY", null, null), "UNCLASSIFIED");
  assert.equal(calculateVendorLateStatus("only drop", null, null), "ONLY_DROP");
});

test("positive delay and blank delay produce warnings without changing status", () => {
  const onTime = calculateVendorLateStatus({ status: "On Time", delayMinutes: 15 }, null, null);
  assert.equal(onTime, "ON_TIME");
  assert.ok(calculateVendorLateStatus.lastResult.warnings.length > 0);

  const late = calculateVendorLateStatus({ status: "LATE", delayMinutes: null }, null, null);
  assert.equal(late, "LATE");
  assert.ok(calculateVendorLateStatus.lastResult.warnings.length > 0);
});

test("summary matches the required totals model", () => {
  const summary = buildVendorValidationSummary([
    { employeeId: "e1", vendorLateStatus: "LATE", delayMinutes: 10 },
    { employeeId: "e1", vendorLateStatus: "ON_TIME_LATE", delayMinutes: 15 },
    { employeeId: "e2", vendorLateStatus: "ON_TIME", delayMinutes: 0 },
    { employeeId: "e3", vendorLateStatus: "ONLY_DROP", delayMinutes: 0 },
    { employeeId: "e4", vendorLateStatus: "UNCLASSIFIED", delayMinutes: 0 },
  ]);

  assert.equal(summary.late, 1);
  assert.equal(summary.onTimeLate, 1);
  assert.equal(summary.onTime, 1);
  assert.equal(summary.onlyDrop, 1);
  assert.equal(summary.grandTotal, 4);
  assert.equal(summary.unclassified, 1);
  assert.ok(Math.abs(summary.actualLostHours - 25 / 60) < 1e-12);
  assert.equal(summary.usersEffected, 1);
});
