'use strict';

const fs = require('node:fs');
const path = require('node:path');

const esmDir = path.join(__dirname, '..', 'lib', 'cluster', 'esm');

if (!fs.existsSync(esmDir)) {
  throw new Error(`cluster ESM build output missing: ${esmDir} (run build:cluster-client first)`);
}

fs.writeFileSync(
  path.join(esmDir, 'package.json'),
  `${JSON.stringify({ type: 'module' }, null, 2)}\n`
);
