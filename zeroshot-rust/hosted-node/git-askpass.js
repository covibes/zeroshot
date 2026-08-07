#!/usr/bin/env node
'use strict';

const prompt = process.argv[2] || '';
if (/username/i.test(prompt)) {
  process.stdout.write('x-access-token');
} else if (/password/i.test(prompt) && process.env.GH_TOKEN) {
  process.stdout.write(process.env.GH_TOKEN);
} else {
  process.exitCode = 1;
}
