require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 30000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 60000),
})
const prisma = new PrismaClient({ adapter , })

const handlePrismaError = (error) => {
  if (error?.code && typeof error.code === "string" && error.code.startsWith("P")) {
    const code = error.code;
    const errorMessages = {
      P1000: "Authentication failed against the database server. The provided database credentials are not valid.",
      P1009: "The database already exists on the database server.",
      P1016: "Your raw query had an incorrect number of parameters.",
      P2000: "The provided value for the column is too long for the column's type.",
      P2003: `Foreign key constraint failed on the field: ${error.meta?.field_name || "unknown"}`,
      P2006: "The provided value for a field is not valid.",
      P2009: "Failed to validate the query.",
      P2021: "The table does not exist in the current database.",
      P2022: "The column does not exist in the current database.",
      P2025: "Record not found",
      P2026: "The current database provider doesn't support a feature that the query used.",
      P2027: "Multiple errors occurred on the database during query execution.",
      P3001: "Migration possible with destructive changes and possible data loss.",
      P3008: "The migration is already recorded as applied in the database.",
      P3010: "The name of the migration is too long.",
      P3012: "Migration cannot be rolled back because it is not in a failed state.",
      P4000: "Introspection operation failed to produce a schema file.",
      P5015: "Could not find Query Engine for the specified host and transaction ID.",
      P6004: "The global timeout of Accelerate has been exceeded.",
    };
    return errorMessages[code] || error;
  }
  if (error?.message && error.message.includes("Unknown")) {
    return "Something went wrong";
  }
  if (error?.message && error.message.includes("Cannot connect")) {
    return "Cannot connect to database";
  }
  return error;
};

module.exports = { prisma, handlePrismaError };