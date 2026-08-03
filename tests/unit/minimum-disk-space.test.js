const assert = require('node:assert');

const { minimumDiskGigabytes } = require('../../src/isolation-manager');

describe('minimum disk space configuration', function () {
  it('preserves the 10 GB production default', function () {
    assert.strictEqual(minimumDiskGigabytes({}), 10);
  });

  it('accepts a bounded positive integer override', function () {
    assert.strictEqual(minimumDiskGigabytes({ ZEROSHOT_MIN_DISK_GB: '1' }), 1);
    assert.strictEqual(minimumDiskGigabytes({ ZEROSHOT_MIN_DISK_GB: '1000' }), 1000);
  });

  for (const invalid of ['', '0', '-1', '1.5', '1e2', '1001', 'unlimited']) {
    it(`rejects invalid value ${JSON.stringify(invalid)}`, function () {
      assert.throws(
        () => minimumDiskGigabytes({ ZEROSHOT_MIN_DISK_GB: invalid }),
        /must be an integer between 1 and 1000/
      );
    });
  }
});
