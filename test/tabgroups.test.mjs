// groupTab against a fake chrome: reuses the chat's group, makes a new titled
// one when that group is gone, and never throws.
import assert from "node:assert/strict";

const calls = [];
let live = new Set([7]);
let fail = false;
globalThis.chrome = {
  debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
  tabs: {
    async group({ tabIds, groupId }) {
      if (fail) throw new Error("no tab");
      if (groupId != null && !live.has(groupId)) throw new Error("No group with id");
      const id = groupId ?? 9;
      live.add(id);
      calls.push(["group", tabIds[0], id]);
      return id;
    },
  },
  tabGroups: {
    async update(id, props) {
      calls.push(["update", id, props.title]);
    },
  },
};
const { groupTab } = await import("../src/background/tools.js");

assert.equal(await groupTab(1, 7), 7);
assert.deepEqual(calls, [["group", 1, 7]], "an existing group is reused, not retitled");

calls.length = 0;
assert.equal(await groupTab(2, 5), 9);
assert.deepEqual(calls, [["group", 2, 9], ["update", 9, "OpenSidekick"]], "a gone group is replaced by a new OpenSidekick one");

calls.length = 0;
assert.equal(await groupTab(3, null), 9);

fail = true;
assert.equal(await groupTab(4, null), null, "failures return null instead of throwing");

console.log("ALL TAB GROUP CHECKS PASSED");

const { inReach } = await import("../src/background/tools.js");
assert.equal(inReach({ id: 1, groupId: 7 }, 7, 2), true, "a group tab is in reach");
assert.equal(inReach({ id: 2, groupId: -1 }, 7, 2), true, "the focused tab is in reach");
assert.equal(inReach({ id: 3, groupId: 4 }, 7, 2), false, "another group's tab is not");
assert.equal(inReach({ id: 3, groupId: -1 }, null, 2), false, "no group: only the focused tab");
console.log("ALL REACH CHECKS PASSED");
