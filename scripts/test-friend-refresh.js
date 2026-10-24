"use strict";
// 好友名单缓存不能「一次查完用到天荒地老」：新加的好友要能上桌。
// 只测 isFriend 的缓存/重拉逻辑，不起轮询、不发消息。
//
// 跑法：node scripts/test-friend-refresh.js

const { WeChatClient } = require("../wechat/client");

let failed = 0;
let checks = 0;
function check(label, cond, extra) {
    checks++;
    if (cond) { console.log("ok   " + label); return; }
    failed++;
    console.log("FAIL " + label + (extra ? "  <" + extra + ">" : ""));
}

async function main() {
    const friends = ["wxid_old"];
    let calls = 0;
    const c = Object.create(WeChatClient.prototype);
    c._friendIds = null;
    c._friendFetchedAt = 0;
    c.getFriendList = async () => { calls++; return friends.slice(); };

    check("第一次查名单：老好友在", (await c.isFriend("wxid_old")) === true);
    check("第一次查名单：陌生人不在", (await c.isFriend("wxid_new")) === false);
    check("查过一次之后走缓存，没重复拉名单", calls === 1, "calls=" + calls);

    // 刚通过好友申请：名单里多了一个人（隔了几秒再上桌）
    friends.push("wxid_new");
    c._friendFetchedAt -= 5000;
    check("新加的好友能被认出来（会重新拉名单）", (await c.isFriend("wxid_new")) === true, "calls=" + calls);
    check("确实重新拉了一次名单", calls === 2, "calls=" + calls);

    // 真不是好友的人连着来，不能每次都打通讯录接口
    c._friendFetchedAt = Date.now();
    check("陌生人还是进不来", (await c.isFriend("wxid_stranger")) === false);
    check("冷却期内不重复拉名单", calls === 2, "calls=" + calls);

    // 接口挂了也不能把所有人当成好友，更不能抛出去卡死上桌
    c._friendIds = null;
    c.getFriendList = async () => { throw new Error("socket hang up"); };
    check("拉名单失败时不抛异常", (await c.isFriend("wxid_old")) === false);
    console.log("\n" + checks + " 项检查，" + (failed ? failed + " 项失败" : "全部通过"));
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
