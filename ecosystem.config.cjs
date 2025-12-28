module.exports = {
  apps: [
    {
      name: 'polyarb',
      script: 'dist/index.js',
      args: '--updown',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      // Restart if it crashes, with exponential backoff
      exp_backoff_restart_delay: 1000,
      // Log configuration
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Merge stdout and stderr
      merge_logs: true,
    },
  ],
};
