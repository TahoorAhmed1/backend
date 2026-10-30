module.exports = {
  apps: [
    {
      name: "myapp",
      script: "./server.js",
      env_file: ".env",
      exec_mode: "cluster",
      instances: 2,
      autorestart: true,
      max_memory_restart: "500M",
      kill_timeout: 15 * 60 * 1000,
      listen_timeout: 15 * 60 * 1000,
      source_map_support: false,
      env: { NODE_ENV: "development" },
      env_production: { NODE_ENV: "production" },
    },
    ...[
      ["BULK_UPLOAD", "account-1"],
      ["UPDATE_SCHEDULE", "account-2"],
      ["RESYNC_PENDING_RIDES", "account-3"],
    ].map(([jobType, accountKey]) => ({
      name: `myapp-bulk-${accountKey}`,
      script: "./worker/bulkupload.process.js",
      env_file: ".env",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "600M",
      kill_timeout: 15 * 60 * 1000,
      listen_timeout: 15 * 60 * 1000,
      source_map_support: false,
      env: {
        NODE_ENV: "development",
        BULK_JOB_TYPE: jobType,
      },
      env_production: {
        NODE_ENV: "production",
        BULK_JOB_TYPE: jobType,
      },
    })),
  ],
};