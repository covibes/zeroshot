const execFileAsync = require('node:util').promisify(require('node:child_process').execFile);

async function runNodeModule(script, env = {}, acceptFailureStdout) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, ...env } }
    );
    return stdout;
  } catch (error) {
    if (typeof error.stdout === 'string' && acceptFailureStdout?.(error.stdout)) {
      return error.stdout;
    }
    throw error;
  }
}

module.exports = {
  execFileAsync,
  fs: require('node:fs'),
  os: require('node:os'),
  path: require('node:path'),
  pathToFileURL: require('node:url').pathToFileURL,
  runNodeModule,
};
