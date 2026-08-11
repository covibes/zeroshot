const assert = require('assert');

const guidanceTopics = require('../../src/guidance-topics');

describe('guidance topics TypeScript runtime contract', function () {
  it('preserves the CommonJS export surface and topic order', function () {
    assert.deepStrictEqual(Reflect.ownKeys(guidanceTopics), [
      'USER_GUIDANCE_CLUSTER',
      'USER_GUIDANCE_AGENT',
      'GUIDANCE_TOPICS',
    ]);
    assert.strictEqual(guidanceTopics.USER_GUIDANCE_CLUSTER, 'USER_GUIDANCE_CLUSTER');
    assert.strictEqual(guidanceTopics.USER_GUIDANCE_AGENT, 'USER_GUIDANCE_AGENT');
    assert.deepStrictEqual(guidanceTopics.GUIDANCE_TOPICS, [
      'USER_GUIDANCE_CLUSTER',
      'USER_GUIDANCE_AGENT',
    ]);
  });
});
