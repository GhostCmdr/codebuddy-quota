const { test } = require('node:test');
const assert = require('node:assert');
const claim = require('../out/claim.js');
const AUTH = { mode: 'auto', token: 't' };
test('未签到时自动签', async () => {
  const api = { status: async () => 'unclaimed', checkin: async () => ({ state: 'claimed', credit: 5, freshlyClaimed: true }) };
  const r = await claim.ensureCheckin(AUTH, api);
  assert.strictEqual(r.state, 'claimed');
  assert.strictEqual(r.freshlyClaimed, true);
  assert.strictEqual(r.credit, 5);
});
test('已签到不重复签', async () => {
  let n = 0;
  const api = { status: async () => 'claimed', checkin: async () => { n++; return { state: 'claimed' }; } };
  await claim.ensureCheckin(AUTH, api);
  assert.strictEqual(n, 0);
});
test('关闭返回 undefined', async () => { assert.strictEqual(await claim.ensureBuddy(AUTH, undefined, false), undefined); });
test('旅行结束领取并再出发', async () => {
  const calls = { claim: 0, depart: 0 };
  const api = { status: async () => ({ state: 'arrived', departAt: 111, arriveAt: 222, dailyLimitReached: false }), claim: async () => { calls.claim++; return { claimed: true, credit: 8 }; }, depart: async () => { calls.depart++; return { hours: 4 }; }, rewardCredit: async () => undefined };
  claim.resetBuddyState();
  const r = await claim.ensureBuddy(AUTH, api, true);
  assert.strictEqual(calls.claim, 1);
  assert.strictEqual(calls.depart, 1);
  assert.strictEqual(r.claimedCredit, 8);
});
test('达上限不出发但仍领取', async () => {
  const calls = { claim: 0, depart: 0 };
  const api = { status: async () => ({ state: 'arrived', departAt: 333, dailyLimitReached: true }), claim: async () => { calls.claim++; return { claimed: true, credit: 0 }; }, depart: async () => { calls.depart++; return { hours: 1 }; }, rewardCredit: async () => 6 };
  claim.resetBuddyState();
  const r = await claim.ensureBuddy(AUTH, api, true);
  assert.strictEqual(calls.claim, 1);
  assert.strictEqual(calls.depart, 0);
  assert.strictEqual(r.claimedCredit, 6);
});
