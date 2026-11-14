// PM2: pm2 start deploy/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'reshis-avia',
      script: 'dist/node/server/index.js',
      cwd: __dirname + '/..',
      node_args: '--disable-warning=ExperimentalWarning',
      instances: 1, // SQLite и проверка файлов рассчитаны на один процесс
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        TRUST_PROXY: 'loopback',
        COOKIE_SECURE: 'auto',
      },
    },
  ],
};
