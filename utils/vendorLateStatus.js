const VENDOR_LATE_STATUS_VALUES = [
  "ON_TIME",
  "ON_TIME_LATE",
  "LATE",
  "ONLY_DROP",
  "UNCLASSIFIED",
];

const normalizeVendorLateStatus = (input) => {
  if (input === null || input === undefined) {
    return "UNCLASSIFIED";
  }

  let candidate = input;  

  if (typeof input === "object") {
    /*
     * IMPORTANT:
     * Vendor Late status is separate from AttendanceStatus.
     *
     * Example:
     * {
     *   status: "PRESENT",
     *   vendorLateStatus: "ON_TIME_LATE"
     * }
     *
     * Must resolve to ON_TIME_LATE.
     *
     * Therefore vendorLateStatus MUST have priority over
     * normal AttendanceStatus.
     */
    candidate =
      input.vendorLateStatus ??
      input.vendorStatus ??
      input.label ??
      input.value ??
      input.status ??
      "";
  }

  const normalizedText = String(candidate)
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (!normalizedText) {
    return "UNCLASSIFIED";
  }

  const aliasMap = {
    late: "LATE",
    "on time late": "ON_TIME_LATE",
    "on time": "ON_TIME",
    "only drop": "ONLY_DROP",
    unclassified: "UNCLASSIFIED",
  };

  return aliasMap[normalizedText] || "UNCLASSIFIED";
};

const parseDelayMinutes = (input) => {
  if (input === null || input === undefined || input === "") {
    return null;
  }

  const delay = Number(input);

  if (!Number.isFinite(delay)) {
    return null;
  }

  return delay;
};

function evaluateDelayWarnings(status, delayMinutes) {
  const warnings = [];

  const parsedDelay = parseDelayMinutes(delayMinutes);

  const hasPositiveDelay =
    parsedDelay !== null && parsedDelay > 0;

  const hasNoPositiveDelay =
    parsedDelay === null || parsedDelay <= 0;

  /*
   * IMPORTANT:
   * These are warnings only.
   *
   * We DO NOT change the operator-entered Vendor Late status.
   */

  if (status === "ON_TIME" && hasPositiveDelay) {
    warnings.push(
      "ON_TIME with positive delay is inconsistent; status is preserved as entered."
    );
  }

  if (
    (status === "LATE" || status === "ON_TIME_LATE") &&
    hasNoPositiveDelay
  ) {
    warnings.push(
      "Late-like status has no positive delay; status is preserved as entered."
    );
  }

  return warnings;
};

const calculateVendorLateStatus = (
  input,
  ride = null,
  passenger = null
) => {
  const status = normalizeVendorLateStatus(input);

  /*
   * Delay is independent from Vendor Late status.
   *
   * We never calculate:
   *   arrivalTime - officeArrivalTime
   *
   * We never apply a grace-period threshold.
   *
   * We only use the delay supplied by the caller/source record.
   */

  let delayMinutes = null;

  if (input && typeof input === "object") {
    delayMinutes = parseDelayMinutes(
      input.delayMinutes ??
      input.delay ??
      input.minutes
    );
  }

  if (delayMinutes === null && ride) {
    delayMinutes = parseDelayMinutes(
      ride.delayMinutes
    );
  }

  if (delayMinutes === null && passenger) {
    delayMinutes = parseDelayMinutes(
      passenger.delayMinutes
    );
  }

  const warnings = evaluateDelayWarnings(
    status,
    delayMinutes
  );

  return {
    status,
    delayMinutes,
    warnings,
  };
};

const buildVendorValidationSummary = (records = []) => {
  const summary = {
    late: 0,
    onTimeLate: 0,
    onTime: 0,
    onlyDrop: 0,
    grandTotal: 0,
    unclassified: 0,
    actualLostHours: 0,
    usersEffected: 0,
  };

  const statusMap = {
    LATE: "late",
    ON_TIME_LATE: "onTimeLate",
    ON_TIME: "onTime",
    ONLY_DROP: "onlyDrop",
  };

  const affectedEmployeeIds = new Set();

  for (const record of records) {
    /*
     * VendorLateStatus is the source of truth.
     *
     * Do NOT use record.status here because that normally
     * represents AttendanceStatus:
     *
     * PRESENT
     * LATE
     * ABSENT
     * NO_SHOW
     *
     * Vendor Late Check is a separate classification.
     */
    const status = normalizeVendorLateStatus(
      record?.vendorLateStatus ??
      record?.vendorStatus ??
      record?.label
    );

    if (status === "UNCLASSIFIED") {
      summary.unclassified += 1;
      continue;
    }

    const summaryField = statusMap[status];

    if (summaryField) {
      summary[summaryField] += 1;
    }

    /*
     * Lost hours are based on the stored/operator-provided
     * delayMinutes.
     *
     * No lateness threshold is applied here.
     */
    const delay = parseDelayMinutes(
      record?.delayMinutes ??
      record?.delay
    );

    if (delay !== null && delay > 0) {
      summary.actualLostHours += delay / 60;

      /*
       * Affected users are DISTINCT employees.
       *
       * Therefore pickup + drop for the same employee
       * counts as one affected user.
       */
      const employeeId =
        record?.employeeId ??
        record?.employee?.id ??
        null;

      if (employeeId) {
        affectedEmployeeIds.add(
          String(employeeId)
        );
      }
    }
  }

  /*
   * Grand Total intentionally excludes UNCLASSIFIED.
   */
  summary.grandTotal =
    summary.late +
    summary.onTimeLate +
    summary.onTime +
    summary.onlyDrop;

  summary.usersEffected =
    affectedEmployeeIds.size;

  return summary;
};

module.exports = {
  VENDOR_LATE_STATUS_VALUES,
  normalizeVendorLateStatus,
  calculateVendorLateStatus,
  buildVendorValidationSummary,
  evaluateDelayWarnings,
  parseDelayMinutes,
};