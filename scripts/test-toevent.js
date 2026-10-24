"use strict";
// 收消息路径的离线断言。
// 线上到现在只抓到过 MsgType=51（账号同步通知），没有真人发过一条文本，
// 所以这里按 data/raw/Sync.json 里真实抓到的字段结构（FromUserName/Content 都是
// {"string":"…"} 包装）复刻样本，保证 toEvent 的解析不靠猜。
const { WeChatClient } = require("../wechat/client");

const OUR = "wxid_self_0001";
const ROOM = "12345678901@chatroom";
const BUDDY = "wxid_buddy0001";

const client = new WeChatClient({
    baseUrl: "http://127.0.0.1:8058/api",
    wxid: OUR,
});
client.ourWxid = OUR;

// 协议原样：文本字段的 SKBuiltinStringT 包装
const S = (v) => ({ string: v });

function msgSeq() {
    msgSeq.n = (msgSeq.n || 1792711900) + 1;
    return msgSeq.n;
}

function addMsg(o) {
    return {
        MsgId: 100000 + o.MsgType,
        FromUserName: S(o.from),
        ToUserName: S(o.to),
        MsgType: o.MsgType,
        Content: S(o.content),
        Status: 2,
        ImgStatus: 0,
        ImgBuf: { string: "", iLen: 0 },
        CreateTime: msgSeq(),
        MsgSource: o.source ||
            "<msgsource>\n\t<signature>v1_test</signature>\n</msgsource>\n",
        NewMsgId: 8500000000000000000 + msgSeq(),
        MsgSeq: msgSeq(),
    };
}

let failed = 0;
function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log((ok ? "  ok   " : "  FAIL ") + label + (ok ? "" : "\n         got  " + JSON.stringify(got) + "\n         want " + JSON.stringify(want)));
}

const cases = [];

// 1 私聊文本
cases.push(["私聊文本", addMsg({ MsgType: 1, from: BUDDY, to: OUR, content: "在吗" }),
    { type: "private", group_id: BUDDY, sender: BUDDY, text: "在吗", atme: false }]);

// 2 群聊文本：协议不拆发送者，正文是 "发送者wxid:\n内容"
cases.push(["群聊文本（拆 wxid 前缀）", addMsg({ MsgType: 1, from: ROOM, to: OUR, content: BUDDY + ":\n今晚打牌吗" }),
    { type: "group", group_id: ROOM, sender: BUDDY, text: "今晚打牌吗", atme: false }]);

// 3 群聊 @ 机器人：atuserlist 用 ^ 连接，且常被 CDATA 包起来
cases.push(["群聊 cc 前缀 + atuserlist 含 CDATA", addMsg({
    MsgType: 1, from: ROOM, to: OUR, content: BUDDY + ":\ncc斗地主",
    source: "<msgsource>\n\t<atuserlist><![CDATA[" + OUR + "^" + BUDDY + "]]></atuserlist>\n</msgsource>\n",
}), { type: "group", group_id: ROOM, sender: BUDDY, text: "cc斗地主", atme: true }]);

// 4 机器人自己发的（群里发言回流）必须丢掉
cases.push(["自己发的群消息 → 丢弃", addMsg({ MsgType: 1, from: ROOM, to: OUR, content: OUR + ":\n我发的" }), null]);

// 5 MsgType=51 账号同步通知 → 丢弃
cases.push(["MsgType 51 通知 → 丢弃", addMsg({
    MsgType: 51, from: OUR, to: "25984984274915457@openim",
    content: "<msg>\n<op id='15'>\n<name>lastmsg 400</name>\n</op>\n</msg>",
}), null]);

// 6 服务号推送（线上真出现过 微信团队 MsgType=9999）→ 丢弃
cases.push(["MsgType 9999 服务号推送 → 丢弃", addMsg({
    MsgType: 9999, from: "wxid_weixinteams", to: OUR, content: "<msg><count>0</count></msg>",
}), null]);

// 7 同一条重推（Sync 游标偶尔会回吐）→ 第二次丢弃
const dup = addMsg({ MsgType: 1, from: BUDDY, to: OUR, content: "重推同一条" });
cases.push(["第一次到达", dup, { type: "private", group_id: BUDDY, sender: BUDDY, text: "重推同一条", atme: false }]);
cases.push(["同一条重推 → 丢弃", dup, null]);

// 7 图片消息也要成事件（斗地主用不到，但轮询不能丢）
// 群消息发送者只能从 Content 的 "wxid:\n" 前缀里拿，协议不给别的字段
cases.push(["群聊图片", addMsg({ MsgType: 3, from: ROOM, to: OUR, content: BUDDY + ":\n<msg><img cdnurl=\"abc\"/></msg>" }),
    { type: "group", group_id: ROOM, sender: BUDDY, text: undefined, atme: false }]);

// 8 群消息没有「发送者wxid:\n」前缀（线上真丢过 "cc#帮助" 和被人 @ 的提问）：
//    以前整条丢弃 = 机器人装聋，现在必须成事件，发送者记成群本身
cases.push(["群聊无前缀正文 → 照样成事件", addMsg({ MsgType: 1, from: ROOM, to: OUR, content: "cc#帮助" }),
    { type: "group", group_id: ROOM, sender: ROOM, text: "cc#帮助", atme: false }]);

// 9 被 @ 但 MsgSource 里只有 atuserlist、没有 <username> 可解析 → 同样不能丢
cases.push(["群聊被@且无前缀 → 成事件且 atme", addMsg({
    MsgType: 1, from: ROOM, to: OUR, content: "@机器人 默认是斗地主吗",
    source: "<msgsource>\n\t<atuserlist><![CDATA[" + OUR + "]]></atuserlist>\n</msgsource>\n",
}), { type: "group", group_id: ROOM, sender: ROOM, text: "@机器人 默认是斗地主吗", atme: true }]);

// 10 正文自己带冒号不能被当发送者前缀剥掉：剥完不以 cc 开头，命令就静静没反应
cases.push(["正文里的冒号不剥", addMsg({ MsgType: 1, from: ROOM, to: OUR, content: "cc:开局" }),
    { type: "group", group_id: ROOM, sender: ROOM, text: "cc:开局", atme: false }]);
cases.push(["发送者前缀后的 cc:开局", addMsg({ MsgType: 1, from: ROOM, to: OUR, content: BUDDY + ":\ncc:开局" }),
    { type: "group", group_id: ROOM, sender: BUDDY, text: "cc:开局", atme: false }]);

// 11 NewMsgId 是 int64，接口按 JSON 数字给的时候 JS 双精度在这个量级最小间隔上千，
//    两条不同的消息会算成同一个 id。老代码把这种 id 直接当去重键 → 新命令被当重复吞掉。
function bigIdMsg(text, tail) {
    const m = addMsg({ MsgType: 1, from: BUDDY, to: OUR, content: text });
    m.NewMsgId = 8500000000000000000 + tail;
    m.MsgId = 700000 + tail;
    return m;
}
cases.push(["int64 精度撞车的两条：第一条", bigIdMsg("第一条命令", 1),
    { type: "private", group_id: BUDDY, sender: BUDDY, text: "第一条命令", atme: false }]);
cases.push(["int64 精度撞车的两条：第二条不能当重复", bigIdMsg("第二条命令", 2),
    { type: "private", group_id: BUDDY, sender: BUDDY, text: "第二条命令", atme: false }]);
// 同一条重推时 NewMsgId 是字符串（无损），必须还能认出来是重复
const strId = addMsg({ MsgType: 1, from: BUDDY, to: OUR, content: "字符串id重推" });
strId.NewMsgId = "8500000000000000003";
cases.push(["字符串 id 第一次", strId, { type: "private", group_id: BUDDY, sender: BUDDY, text: "字符串id重推", atme: false }]);
cases.push(["字符串 id 重推 → 丢弃", strId, null]);

console.log("toEvent 断言：");
for (const [label, raw, want] of cases) {
    const ev = client.toEvent(raw);
    if (want === null) {
        check(label, ev, null);
        continue;
    }
    if (!ev) { check(label, ev, want); continue; }
    check(label, {
        type: ev.type,
        group_id: ev.group_id,
        sender: ev.sender.user_id,
        text: (ev.message.find((m) => m.type === "text") || {}).text,
        atme: ev.atme,
    }, want);
    // 图片正文不是文本段，单独确认类型没被当成文本
    if (label === "群聊图片") check("   图片段类型", ev.message.map((m) => m.type), ["image"]);
    if (label === "群聊无前缀正文 → 照样成事件") {
        check("   查不到发送者要标出来", ev.sender_unknown, true);
    }
}

console.log(failed ? "\n" + failed + " 条断言失败" : "\n全部通过");
process.exit(failed ? 1 : 0);
