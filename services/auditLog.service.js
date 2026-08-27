// ---------- Historical assignment tracking ----------

const recordAssignmentHistory = async (
  client,
  action,
  weeklyScheduleId,
  before,
  after,
  changedBy,
) => {
  try {
    await client.auditLog.create({
      data: {
        action,
        model: "WeeklySchedule",
        recordId: weeklyScheduleId,
        before: before ? JSON.parse(JSON.stringify(before)) : undefined,
        after: after ? JSON.parse(JSON.stringify(after)) : undefined,
        userId: changedBy || undefined,
      },
    });
  } catch (historyError) {
    // Never let audit logging break the actual assignment operation.
  }
};

module.exports = {
  recordAssignmentHistory,
};
