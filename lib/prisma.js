require("dotenv/config");

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,

  max: Number(process.env.DB_POOL_MAX || 10),

  // Don't wait indefinitely for a database connection.
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 30000),

  // FIX: was 30s. After 30s of quiet the pool dropped every connection and the next
  // request paid for a new TCP + TLS + auth handshake (seconds on a remote DB).
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 300000),

  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

const prisma = new PrismaClient({
  adapter,
  // Uncomment to see the exact SQL while debugging:
  // log: ["query", "warn", "error"],
});

// Warm the pool at startup so the first real request isn't the one that connects.
prisma.$connect().catch((e) => console.error("[prisma] initial connect failed:", e.message));

// Light heartbeat keeps at least one connection hot (and helps against DB auto-suspend).
// Set DB_HEARTBEAT_MS=0 to disable.
const HEARTBEAT_MS = Number(process.env.DB_HEARTBEAT_MS ?? 60000);
if (HEARTBEAT_MS > 0) {
  const timer = setInterval(() => {
    prisma.$queryRaw`SELECT 1`.catch(() => {});
  }, HEARTBEAT_MS);
  timer.unref(); // never keeps the process alive
}

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

  if (error?.message && error.message.includes("Unknown")) return "Something went wrong";
  if (error?.message && error.message.includes("Cannot connect")) return "Cannot connect to database";

  return error;
};

module.exports = { prisma, handlePrismaError };