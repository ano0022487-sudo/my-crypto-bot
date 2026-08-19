'use strict';

/*
  OKX Event Contract launcher.
  runtime-diagnostics.js is loaded first so failures in the dynamically
  compiled event-bot.js are visible in Render logs.
*/

require('./runtime-diagnostics.js');
require('./event-bot-runner.js');
