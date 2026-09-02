'use strict';

function log(level, message, meta) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console[level === 'error' ? 'error' : 'log'](`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${suffix}`);
}
module.exports = { info: (m, x) => log('info', m, x), warn: (m, x) => log('warn', m, x), error: (m, x) => log('error', m, x) };
