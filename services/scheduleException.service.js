// ---------- Exception queue ----------

const logScheduleException = async (
  client,
  { weekStart, employeeCode, rowNumber, reason, rawData },
) => {
  try {
    await client.scheduleException.create({
      data: {
        weekStart,
        employeeCode: employeeCode || undefined,
        rowNumber: rowNumber ?? undefined,
        reason,
        rawData: rawData ? JSON.parse(JSON.stringify(rawData)) : undefined,
      },
    });
  } catch (exceptionLogError) {
    // Never let exception logging break the actual upload/reassign.
  }
};

module.exports = {
  logScheduleException,
};
