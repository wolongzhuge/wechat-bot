"use strict";
// 五子棋全流程离线断言：不联网，只把 reply 换成记录器
const { client } = require("../app");
const { getGomokuCommand, games, parseCoord } = require("../command/gomoku/gomokuIndex");
const { SIZE, BLACK, WHITE } = require("../command/gomoku/game");

const ROOM = "testroom@chatroom";
let sent = [];

function mkEvent(userId) {
    return {
        type: "group",
        group_id: ROOM,
        sender: { user_id: userId, nick: userId },
        message: [],
        atme: true,
        client,
        reply: (content) => {
            sent.push(content);
            return Promise.resolve();
        },
    };
}

// 命令内部用 .then 串图片，必须等微任务跑完才能看到全部回复
async function send(userId, text) {
    getGomokuCommand(mkEvent(userId), text);
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

function lastText() {
    for (let i = sent.length - 1; i >= 0; i--) {
        if (typeof sent[i] === "string") return sent[i];
    }
    return "";
}
function hadImage() {
    return sent.some((c) => c && typeof c === "object" && c.image);
}

let failures = 0;
function check(label, cond, extra) {
    if (cond) console.log("  ok   " + label);
    else {
        failures++;
        console.log("  FAIL " + label + (extra ? "\n       " + extra : ""));
    }
}

// 坐标口径：parseCoord 出来的是 {col,row}，写在测试里期望值一律 [列, 行]
function coord(label, text, col, row) {
    const got = parseCoord(text);
    check(label, got.col === col && got.row === row, "parseCoord(" + text + ") = " + JSON.stringify(got));
}
function badCoord(label, text, needle) {
    const got = parseCoord(text);
    const ok = got.bad && (!needle || String(got.bad).includes(needle));
    check(label, ok, "parseCoord(" + text + ") = " + JSON.stringify(got));
}

const A = "wxid_aaaaaaaa", B = "wxid_bbbbbbbb", C = "wxid_cccccccc";
const g = () => games.get(ROOM);

async function main() {
    console.log("0) parseCoord：一律「前列后行」");
    coord("5,6 = 第5列第6行", "5,6", 5, 6);
    coord("「下」可以省", "下5,6", 5, 6);
    coord("落子前缀 + 全角逗号", "落子5，6", 5, 6);
    coord("中文全角数字", "下５，６", 5, 6);
    coord("空格分隔", "5 6", 5, 6);
    coord("短横分隔", "5-6", 5, 6);
    coord("两位连写 56", "56", 5, 6);
    coord("四位连写 1115 = 11列15行", "1115", 11, 15);
    coord("带「行列」字样", "3列8行", 3, 8);
    coord("写反了也认：8行3列", "8行3列", 3, 8);
    coord("「第…列第…行」", "第8列第3行", 8, 3);
    coord("中文一十一 = 1列11行", "一十一", 1, 11);
    coord("中文一十三 = 1列13行", "一十三", 1, 13);
    coord("中文三三 = 3列3行", "三三", 3, 3);
    coord("中文十一一 = 11列1行", "十一一", 11, 1);
    coord("中文八八 = 8列8行", "八八", 8, 8);
    coord("11,15 合法", "11,15", 11, 15);
    badCoord("三位连写 111 有歧义，提示加逗号", "111", "逗号");
    badCoord("单个数字 8 要两个数", "8", "一个数");
    badCoord("单个中文数 八 同样拒绝", "八", "一个数");
    badCoord("看不懂的 xx", "下xx", null);
    badCoord("0 坐标不算数字", "下0,3", null);
    badCoord("尾逗号吞掉后只剩一个数", "5,", "一个数");
    badCoord("只有逗号没数字（带动词）", "下，", "空的");
    coord("5,,5 折叠成一对坐标", "5,,5", 5, 5);
    check("越界 99,99 交给 fixSwap 判定", parseCoord("99,99").col === 99);

    console.log("1) 一人等人、两人开局、第三人拒入");
    sent = [];
    await send(A, "五子棋");
    check("第一人提示还差 1 人", lastText().includes("还差 1"));
    sent = [];
    await send(B, "五子棋");
    check("两人后已开局", g().started === true);
    check("黑白各一", g().players.filter((p) => p.color === BLACK).length === 1);
    check("开局播报讲明前列后行", lastText().includes("第3列第8行"));
    check("每手贴图", hadImage());
    sent = [];
    await send(C, "五子棋");
    check("第三人被拒", lastText().includes("两个人已经齐了"));

    console.log("2) 越序 / 越界 / 局外人");
    const blackId = g().players.find((p) => p.color === BLACK).id;
    const whiteId = g().players.find((p) => p.color !== BLACK).id;
    sent = [];
    await send(whiteId, "下8,8");
    check("白方抢先后被拒", lastText().includes("还没轮到你"));
    check("拒绝落子时不贴图", !hadImage());
    sent = [];
    await send(C, "下8,8");
    check("局外人被拒", lastText().includes("不在这局里"));
    sent = [];
    await send(blackId, "下99,99");
    check("越界被拒", lastText().includes("1~" + SIZE));
    check("越界时报的是列在前", lastText().includes("第99列第99行"));
    sent = [];
    await send(blackId, "下0,3");
    check("0 坐标被拒并教写法", lastText().includes("前列后行"));

    console.log("3) 写法各样都要落到同一个格子");
    sent = [];
    await send(blackId, "下8,8");
    check("下8,8 播报第8列第8行", lastText().includes("第8列第8行"));
    check("8,8 落在 grid 的第8列第8行", g().cellAt(8, 8) === BLACK, "cellAt(row=8,col=8)");
    check("落子后贴图", hadImage());
    sent = [];
    await send(whiteId, "下８，８");
    check("已占位提示换位置", lastText().includes("已经有子"));
    sent = [];
    await send(whiteId, "下１，８");
    check("全角 1,8 = 第1列第8行", lastText().includes("第1列第8行"));
    check("grid 上确实是 1 列 8 行", g().cellAt(8, 1) === WHITE);
    check("grid 上没有多落 8 列 1 行", g().cellAt(1, 8) === 0);
    sent = [];
    await send(blackId, "落子3 4");
    check("空格分隔 3 4 = 第3列第4行", lastText().includes("第3列第4行"));
    check("grid 校验 3 列 4 行", g().cellAt(4, 3) === BLACK);
    sent = [];
    await send(whiteId, "3,5");
    check("不带「下」也认", lastText().includes("第3列第5行"));
    check("grid 校验 3 列 5 行", g().cellAt(5, 3) === WHITE);
    sent = [];
    await send(blackId, "下xx");
    check("看不懂坐标给格式提示", lastText().includes("前列后行"));
    check("提示里给了中文写法", lastText().includes("一十三"));
    sent = [];
    await send(blackId, "五五");
    check("中文数字能直接落子", lastText().includes("第5列第5行"));
    sent = [];
    await send(whiteId, "下7,7");
    check("提示后白方仍能落子", lastText().includes("第7列第7行"));
    sent = [];
    await send(blackId, "一十二");
    check("一十二 = 第1列第12行", lastText().includes("第1列第12行"));
    check("grid 校验 1 列 12 行", g().cellAt(12, 1) === BLACK);
    sent = [];
    await send(whiteId, "8行3列");
    check("写反字样也能落子", lastText().includes("第3列第8行"));
    check("上一手回显用列在前", g().statusText().includes("第3列第8行"));

    console.log("4) 轮流向第 1 列推进，黑棋五连");
    // filler 要散开，别自己连成五子把黑棋抢先；一律 [列, 行]
    const target = [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5]];
    const filler = [[14, 14], [12, 13], [15, 15], [14, 13], [12, 15]];
    let ti = 0, fi = 0, steps = 0;
    while (!g().winner && steps++ < 60) {
        const cur = g().current();
        const cell = cur.color === BLACK ? target[ti++] : filler[fi++];
        if (!cell) break;
        await send(cur.id, "下" + cell[0] + "," + cell[1]);
    }
    check("黑棋五连判胜", !!g().winner && g().winner.color === BLACK);
    check("winLine 记下五连格子", g().winLine.length === 5 && g().winLine.every((c) => c.col === 1), "winLine=" + JSON.stringify(g().winLine));
    check("群里播报获胜方", lastText().includes("五连") || lastText().includes("获胜"));
    check("胜利盘面也贴图", hadImage());
    sent = [];
    await send(blackId, "下13,13");
    check("分胜负后拒绝继续落子", lastText().includes("已经分出胜负"));

    console.log("5) 有胜负时 cc五子棋 自动清盘重开");
    sent = [];
    await send(A, "五子棋");
    check("重开新局且无胜负", !g().winner);
    check("新盘还差 1 人", lastText().includes("还差 1"));
    sent = [];
    await send(B, "五子棋");
    check("第二人加入即开新局", g().started === true && !g().winner);

    console.log("6) 认输 / 结束 / 棋盘 / 规则 / 无棋局");
    sent = [];
    const loserId = g().players[0].id;
    await send(loserId, "认输");
    check("认输判对方赢", lastText().includes("认输"));
    sent = [];
    await send(loserId, "认输");
    check("重复认输被拒", lastText().includes("已经结束"));
    sent = [];
    await send(A, "规则");
    check("规则说明带落子格式", lastText().includes("cc3,8"));
    check("规则说明不再出现「下」前缀示例", !lastText().includes("cc下1,2"));
    sent = [];
    await send(A, "棋盘");
    check("cc棋盘 贴图", hadImage());
    sent = [];
    await send(A, "结束");
    check("结束清盘", !games.has(ROOM));
    sent = [];
    await send(A, "棋盘");
    check("没棋局时提示先开局", lastText().includes("没有棋局"));
    sent = [];
    await send(A, "下5,5");
    check("没棋局时落子提示开局", lastText().includes("开一局"));

    console.log(failures ? "\n失败 " + failures + " 项" : "\n全部通过");
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error("测试脚本自己炸了: " + (err && err.stack || err));
    process.exit(1);
});
