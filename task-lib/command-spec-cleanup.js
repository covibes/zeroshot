import { createRequire } from 'module';

const require = createRequire(import.meta.url);
export const { createCommandSpecCleanup } = require('../src/command-cleanup-ownership');
