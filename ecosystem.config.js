module.exports = {
  apps: [
    {
      name: "myapp",
      script: "./server.js",
      exec_mode: "fork",
      instances: 1,
      wait_ready: true,
      autorestart: true,
      max_memory_restart: "500M",
      kill_timeout: 15 * 60 * 1000,
      listen_timeout: 15 * 60 * 1000,
      source_map_support: false,
    },

    {
      name: "myapp-bulk-upload-worker",
      script: "./worker/bulkupload.process.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "600M",
      kill_timeout: 15 * 60 * 1000,
      source_map_support: false,
    },
  ],
};