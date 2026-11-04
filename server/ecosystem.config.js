module.exports = {
  apps: [{
    name: 'portfolio-api',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,          // presence + counters live in memory, keep a single process
    autorestart: true,
    max_memory_restart: '200M',
    env: { NODE_ENV: 'production' }
  }]
};
