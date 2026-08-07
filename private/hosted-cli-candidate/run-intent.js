'use strict';

module.exports = {
  ...require('./run-intent-schema'),
  ...require('./run-intent-http'),
  ...require('./run-intent-observer'),
};
