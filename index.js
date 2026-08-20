'use strict';

/*
  Stable Render entrypoint.
  Keep the HTTP server and strategy boot path in event-bot-runner.js.
  No runtime source rewriting is performed here.
*/

require('./runtime-diagnostics.js');
require('./event-bot-runner.js');
