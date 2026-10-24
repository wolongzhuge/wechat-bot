"use strict";
// 轮询循环的健壮性断言：一条消息处理崩了不能连累同批其余消息，
// ContinueFlag=1（服务端说明白还有货没取完）时必须立刻续拉而不是干等 interval。
const fs = require("fs");
const path = require("path");
const { WeChatClient } = require("../wechat/client");

const ROOM = "12345678901@chatroom";
const BOT = "wxid_self_0001";
process.env.trigger_prefix = "cc";

function msg(wxid, text, msgId, room) {
    return {
        MsgId: msgId,
        FromUserName: { string: room || ROOM },
        ToUserName: { string: BOT },
        MsgType: 1,
        Content: { string: wxid + ":\n" + text },
        CreateTime: Math.floor(Date.now() / 1000),
        MsgSource: "",
        NewMsgId: 1000000 + msgId,
    };
}

function payload(addMsgs, continueFlag) {
    return { Code: 0, Success: true, Message: "成功", Data: { AddMsgs: addMsgs, ContinueFlag: continueFlag || 0 } };
}

const client = new WeChatClient({ baseUrl: "http://127.0.0.1:1", wxid: BOT, timeout: 500 });

const got = [];
const syncAt = [];
const batches = [
    payload([msg("wxid_p1", "崩之前", 1), msg("wxid_p2", "会崩的一条", 2), msg("wxid_p3", "崩之后", 3)], 1),
    payload([msg("wxid_p1", "第二批", 4)], 0),
    new Promise(() => {}),   // 之后永远挂住，测完直接 exit
];

client.syncMessages = async () => {
    syncAt.push(Date.now());
    const next = batches.shift();
    if (!next) return new Promise(() => {});
    return next;
};

// 收到新群 id 会后台补昵称，测试里不能真去连那个假地址
client.getRoomMemberList = async () => [];
client.namesOf = async () => new Map();

// 启动时先 newinit 唤醒会话，重启期间积压的消息一并捞回来。
// 这条是十分钟前的，属于上个进程已经回过的，必须跳过而不是再回一遍。
const reinitAt = [];
client.reinitSync = async () => {
    reinitAt.push(Date.now());
    return [Object.assign(msg("wxid_old", "重启前就回过的旧命令", 77), { CreateTime: Math.floor(Date.now() / 1000) - 600 })];
};

client.on("message.group", (event) => {
    const text = event.message[0].text;
    if (text === "会崩的一条") throw new Error("故意抛的 handler 异常");
    got.push(text);
});

let failed = 0;
function check(label, cond, extra) {
    if (!cond) failed++;
    console.log((cond ? "  ok   " : "  FAIL ") + label + (cond ? "" : "  → " + extra));
}

client.startPolling({ interval: 600 });

// 场景二：一条消息都没有、同步却完全不报错 —— 这就是「旧 SyncKey 不被微信认账」
// 那种卡死（实测空轮询的回包里 KeyBuf 每次都在变，服务端只在非空分支才写回），
// newsync 自己等不回来，轮询必须主动 newinit，并且把捞回的消息派发出去。
const stalled = new WeChatClient({ baseUrl: "http://127.0.0.1:1", wxid: BOT, timeout: 500 });
stalled.getRoomMemberList = async () => [];
stalled.namesOf = async () => new Map();
const got2 = [];
let reinitCount = 0;
stalled.syncMessages = async () => payload([], 0);
stalled.reinitSync = async () => {
    reinitCount++;
    // 第一次是启动唤醒（返回空），第二次才是卡死重试：捞回的是十分钟前发的，
    // 卡死期间用户一直在等这条，不能当成过期丢掉
    if (reinitCount !== 2) return [];
    return [Object.assign(msg("wxid_p9", "cc状态（卡住时发的）", 99), { CreateTime: Math.floor(Date.now() / 1000) - 600 })];
};
stalled.on("message.group", (event) => got2.push(event.message[0].text));

setTimeout(() => {
    stalled.startPolling({ interval: 100, stallFirstMs: 150 });
}, 300);

// 场景三：积压回放不许逐条回。卡死攒下来的几千条横跨几小时，
// 一条一条回等于机器人诈尸刷屏；回放结束后每个群只补「冲机器人说的」最后那一句，
// 群里后来的闲聊不能把命令挤掉，别的群的命令也不能被这一个群吃掉。
// 但这一句本身过时十几分钟就不算了——牌局早散了，回它才是诈尸。
process.env.trigger_prefix = "cc";
const replay = new WeChatClient({ baseUrl: "http://127.0.0.1:1", wxid: BOT, timeout: 500 });
replay.getRoomMemberList = async () => [];
replay.namesOf = async () => new Map();
replay.reinitSync = async () => [];
const got3 = [];
const aged = (wxid, text, id, secondsAgo, room) =>
    Object.assign(msg(wxid, text, id, room), { CreateTime: Math.floor(Date.now() / 1000) - secondsAgo });
const ROOM2 = "44699859849@chatroom";
const ROOM3 = "55699859850@chatroom";
const replayBatches = [
    payload([aged("wxid_a", "cc斗地主", 111, 7200), aged("wxid_b", "cc上桌", 112, 3600)], 1),
    payload([aged("wxid_d", "半小时前的一句闲聊", 113, 1800), aged("wxid_e", "cc状态", 114, 600),
        aged("wxid_f", "cc#帮助", 115, 300, ROOM2), aged("wxid_g2", "cc胜率榜", 117, 2400, ROOM3)], 0),
    payload([msg("wxid_g", "回放结束后来的实时消息", 116)], 0),
];
let replayTick = 0;
replay.syncMessages = async () => replayBatches[Math.min(replayTick++, replayBatches.length - 1)];
replay.on("message.group", (event) => got3.push(event.message[0].text));
replay.startPolling({ interval: 80 });

// 场景四：只有 Msg/Sync 一个拉取通道，所以响应延迟的下限就是轮询间隔。
// 有人在说话时必须压到 hotInterval，闲下来才退回大间隔，不然每条命令先白等一秒
const speedy = new WeChatClient({ baseUrl: "http://127.0.0.1:1", wxid: BOT, timeout: 500 });
speedy.getRoomMemberList = async () => [];
speedy.namesOf = async () => new Map();
speedy.reinitSync = async () => [];
const at4 = [];
let tick4 = 0;
speedy.syncMessages = async () => {
    at4.push(Date.now());
    tick4++;
    return tick4 === 3 ? payload([msg("wxid_h", "cc状态", 121)], 0) : payload([], 0);
};
speedy.on("message.group", () => {});
speedy.startPolling({ interval: 3000, hotInterval: 200 });

// 场景五：去重表要能跨进程活下来。newinit 会把积压重发一遍，
// 内存里的去重表一重启就空了，机器人于是把几小时前答过的命令再答一次
const seenFile = path.join(__dirname, "..", "data", "seen-test.json");
try { fs.unlinkSync(seenFile); } catch (e) { /* 首次跑没有这个文件 */ }
const first = new WeChatClient({ baseUrl: "http://127.0.0.1:1", wxid: BOT, timeout: 500, seenFile: seenFile });
const oldCmd = msg("wxid_i", "cc状态（重启前已经答过）", 131);
const seenOnce = !!first.toEvent(oldCmd);
first._saveSeen();
const second = new WeChatClient({ baseUrl: "http://127.0.0.1:1", wxid: BOT, timeout: 500, seenFile: seenFile });
const seenTwice = !!second.toEvent(oldCmd);
try { fs.unlinkSync(seenFile); } catch (e) { /* 测完就删掉 */ }

// 场景六：机器人自己发完一句后，对方往往马上回。热态只按「收到消息」算的话，
// 这段对话期里轮询已经退回空闲档，白白多等一个来回
const chatty = new WeChatClient({ baseUrl: "http://127.0.0.1:1", wxid: BOT, timeout: 500 });
chatty.getRoomMemberList = async () => [];
chatty.namesOf = async () => new Map();
chatty.reinitSync = async () => [];
chatty._request = async () => ({ Code: 0, Success: true });
const at6 = [];
chatty.syncMessages = async () => { at6.push(Date.now()); return payload([], 0); };
chatty.startPolling({ interval: 3000, hotInterval: 200 });
let sentAt6 = 0;
setTimeout(() => { sentAt6 = Date.now(); chatty.sendText(ROOM, "我回话了"); }, 1000);

// 场景七：回放批次里混着刚到的新命令。老代码按「整批最老那条」判这是不是回放，
// 于是一条两小时前的陈年消息能把同批的新命令一起压掉 —— 就是「cc 发了没反应，过一会儿才好」。
const mixed = new WeChatClient({ baseUrl: "http://127.0.0.1:1", wxid: BOT, timeout: 500 });
mixed.getRoomMemberList = async () => [];
mixed.namesOf = async () => new Map();
mixed.reinitSync = async () => [];
const got7 = [];
let tick7 = 0;
mixed.syncMessages = async () => {
    tick7++;
    if (tick7 === 1) return payload([aged("wxid_j", "cc状态", 141, 7200), msg("wxid_k", "cc上桌", 142)], 0);
    return payload([], 0);
};
mixed.on("message.group", (event) => got7.push(event.message[0].text));
mixed.startPolling({ interval: 200 });

setTimeout(() => {
    check("重启前处理过的消息，重启后不会再成事件", seenOnce && !seenTwice,
        "首启成事件=" + seenOnce + " 重启后成事件=" + seenTwice);
    check("机器人自己刚发过言，轮询也要保持热态（下一句通常几秒内就到）",
        (function () {
            const i = at6.findIndex((t) => t >= sentAt6);
            return i > 0 && i < at6.length - 1 && at6[i + 1] - at6[i] < 900;
        })(),
        "发送时刻 " + sentAt6 + "，之后的轮询间隔 " + JSON.stringify(at6.slice(-4)) + "（idle=3000ms）");
    check("handler 抛异常后，同批后面的消息照样收到", got.includes("崩之前") && got.includes("崩之后"), JSON.stringify(got));
    check("抛异常的那条自己没被算成收到", !got.includes("会崩的一条"), JSON.stringify(got));
    check("ContinueFlag=1 时第二轮立刻续拉",
        syncAt.length >= 2 && syncAt[1] - syncAt[0] < 300,
        "间隔 " + (syncAt.length > 1 ? syncAt[1] - syncAt[0] : "无") + "ms，interval=600ms");
    check("续拉真的把第二批取回来了", got.includes("第二批"), JSON.stringify(got));
    check("启动时先 newinit 唤醒再开始轮询",
        reinitAt.length === 1 && syncAt.length > 0 && reinitAt[0] <= syncAt[0],
        "reinit@ " + JSON.stringify(reinitAt) + " 首次sync@ " + JSON.stringify(syncAt.slice(0, 2)));
    check("静默超过阈值会自己 newinit", reinitCount >= 2, "只调了 " + reinitCount + " 次");
    check("卡死期间捞回的消息照样派发（哪怕看着像过期）", got2.includes("cc状态（卡住时发的）"), JSON.stringify(got2));
    check("回放里每个群只补冲机器人说的最后那句，闲聊和更早的命令不回",
        got3.includes("cc状态") && got3.includes("cc#帮助") &&
        !got3.includes("cc斗地主") && !got3.includes("cc上桌") && !got3.includes("半小时前的一句闲聊"),
        JSON.stringify(got3));
    check("攒下的那句如果本身已过时十几分钟，宁可不回（对着散了的牌局喊人才是怪）",
        !got3.includes("cc胜率榜"), JSON.stringify(got3));
    check("回放结束后实时消息照常处理", got3.includes("回放结束后来的实时消息"), JSON.stringify(got3));
    const gaps4 = at4.slice(1).map((t, i) => t - at4[i]);
    check("刚收到消息时轮询压到 hotInterval（不是等 idle 间隔）",
        at4.length > 5 && gaps4.slice(0, 4).every((g) => g < 900),
        "前几个间隔 " + JSON.stringify(gaps4.slice(0, 4)) + "ms，idle=3000ms hot=200ms");
    check("静默超过 8 秒会退回空闲间隔，不空转打爆服务端",
        Math.max(0, ...gaps4) >= 1500,
        "最大间隔 " + Math.max(0, ...gaps4) + "ms，共 " + at4.length + " 次轮询");
    check("陈年回放和新命令混在一批时，新命令当场处理、陈年那句不补回",
        got7.includes("cc上桌") && !got7.includes("cc状态"), JSON.stringify(got7));
    console.log(failed ? "\n" + failed + " 条失败" : "\n全部通过");
    process.exit(failed ? 1 : 0);
}, 13000);
