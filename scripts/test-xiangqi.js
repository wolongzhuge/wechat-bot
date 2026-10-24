"use strict";
// 象棋引擎 + 命令层断言：记谱解析、全部行棋规则、将军/将死/困毙、前/后区分、流程 stub。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { client } = require("../app");
const { XiangqiGame, normalizeMoveText, MOVE_RE, makeBoard, RED, BLACK } = require("../command/xiangqi/game");
const { getXiangqiCommand, games } = require("../command/xiangqi/xiangqiIndex");

let failed = 0;
function check(label, cond, extra) {
    if (!cond) failed++;
    console.log((cond ? "  ok   " : "  FAIL ") + label + (cond ? "" : "  → " + extra));
}
// 清空棋盘只留需要的子，避免初始布局干扰手工摆的残局
function bare() {
    const b = makeBoard();
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) b[r][c] = null;
    return b;
}

// ---------- 记谱归一与正则 ----------
check("中文数字转阿拉伯", normalizeMoveText("炮二平五") === "炮2平5", normalizeMoveText("炮二平五"));
check("全角数字转半角", normalizeMoveText("马５进６") === "马5进6", normalizeMoveText("马５进６"));
check("前/后省略起点列号也认", MOVE_RE.test(normalizeMoveText("前马进三")) && MOVE_RE.test(normalizeMoveText("后炮平五")), "regex");
// 正则对缺列号是宽松的（马进6 能匹配），但代码强制无前缀必须带列号
const nf = new XiangqiGame();
nf.addPlayer("A", "红"); nf.addPlayer("B", "黑"); nf.start(false);
const nf1 = nf.tryMove("A", "马进六");
check("无前缀必须带列号", !nf1.ok && nf1.hint.includes("没看懂"), nf1.hint);

// ---------- 经典开局 ----------
const g = new XiangqiGame();
g.addPlayer("A", "红方甲"); g.addPlayer("B", "黑方乙"); g.start(false);
const seq = [
    ["A", "炮二平五", "炮二平五"],
    ["B", "马8进7", "马8进7"],
    ["A", "马二进三", "马二进三"],
    ["B", "车9平8", "车9平8"],
    ["A", "车一平二", "车一平二"],
];
for (const [who, cmd, want] of seq) {
    const r = g.tryMove(who, cmd);
    check("开局 " + cmd + " → " + want, r.ok && r.notation === want, r.ok ? r.notation : r.hint);
}
check("五步之后轮到黑", g.turn === BLACK, "turn=" + g.turn);
const bad1 = g.tryMove("B", "炮8进8"); // 黑炮 (2,7) 前进 8 步出界
check("走出棋盘被拒", !bad1.ok && bad1.hint.includes("棋盘"), bad1.hint);
const bad2 = g.tryMove("B", "马7进3");
check("马不走日被拒", !bad2.ok && bad2.hint.includes("日"), bad2.hint);
// 浅跳：横向差 2 路是「进/退一」，这一步之前被写死成两步，误判成不走日
const shallow = g.tryMove("B", "马7进5");
check("马浅跳（横 2 路=进一）合法", !shallow.ok && shallow.hint.includes("自己的棋子"), shallow.hint);
const bad3 = g.tryMove("B", "士4进5");
check("黑补士合法", bad3.ok, bad3.hint || "");
const bad4 = g.tryMove("A", "炮五进二"); // 中炮 (7,4) 上行被 (6,4) 自己的中兵挡住
check("炮不能隔子走", !bad4.ok && bad4.hint.includes("隔着"), bad4.hint);
const bad5 = g.tryMove("B", "车9平8");
check("没轮到你被拒", !bad5.ok && bad5.hint.includes("轮到你"), bad5.hint);
const bad6 = g.tryMove("A", "炮五平五");
check("原地不动被拒", !bad6.ok, bad6.hint || "");

// ---------- 车不能隔子 / 不能吃自己的子 ----------
const rb = new XiangqiGame();
rb.addPlayer("A", "红"); rb.addPlayer("B", "黑"); rb.start(false);
rb.board = bare();
rb.board[0][4] = { side: BLACK, type: "K" };
rb.board[9][0] = { side: RED, type: "K" };
rb.board[9][1] = { side: RED, type: "R" };
rb.board[7][1] = { side: RED, type: "P" };
const rb1 = rb.tryMove("A", "车八进三"); // (9,1)→(6,1)，中间 (7,1) 自己的兵
check("车不能隔子走", !rb1.ok && rb1.hint.includes("隔着"), rb1.hint);
const rb2 = rb.tryMove("A", "车八平九"); // (9,1)→(9,0) 自己的帅
check("车不能吃自己的子", !rb2.ok && rb2.hint.includes("自己的棋子"), rb2.hint);

// ---------- 蹩马腿（自己的兵也是蹩腿子）----------
const h = new XiangqiGame();
h.addPlayer("A", "红"); h.addPlayer("B", "黑"); h.start(false);
const r1 = h.tryMove("A", "马二进三");
check("马二进三合法", r1.ok, r1.hint || "");
h.tryMove("B", "马8进7");
const r2 = h.tryMove("A", "马三进四"); // 腿点 (6,6) 有红兵 → 蹩
check("中兵蹩马腿被拒", !r2.ok && r2.hint.includes("蹩"), r2.hint);
h.board[6][6] = null;
h.turn = BLACK; // r2 被拒轮次没动，黑方补一手
h.tryMove("B", "车9平8");
const r3 = h.tryMove("A", "马三进四");
check("挪开中兵后马三进四合法", r3.ok, r3.hint || "");
h.tryMove("B", "炮8进1");
const r4 = h.tryMove("A", "相七进五");
check("相七进五合法", r4.ok, r4.hint || "");
h.tryMove("B", "马2进3");
const r5 = h.tryMove("A", "相五进七");
check("相五退回到河边合法", r5.ok, r5.hint || "");
h.tryMove("B", "车8进1");
const r6 = h.tryMove("A", "相七进五");
check("相过河被拒", !r6.ok && r6.hint.includes("过河"), r6.hint);

// ---------- 顺炮局：炮借中兵吃中卒 → 借黑炮当炮架将军 ----------
const c = new XiangqiGame();
c.addPlayer("A", "红"); c.addPlayer("B", "黑"); c.start(false);
const c1 = c.tryMove("A", "炮二平五");
check("当头炮", c1.ok, c1.hint || "");
const c1b = c.tryMove("B", "炮8平5");
check("顺手炮", c1b.ok, c1b.hint || "");
const c2 = c.tryMove("A", "炮五进四");
check("炮借中兵吃中卒", c2.ok && c2.captured === "卒", c2.hint || "");
check("黑炮挡在中路 → 将军！", c2.check === true, JSON.stringify({ check: c2.check }));
const c3 = c.tryMove("B", "车9进1");
check("被将军必须应将", !c3.ok && c3.hint.includes("被将"), c3.hint);
const c4 = c.tryMove("B", "士4进5");
check("补士后两个炮架不算将", c4.ok, c4.hint || "");

// ---------- 空头炮：飞象/补士都变成炮架 = 送将 ----------
const e = new XiangqiGame();
e.addPlayer("A", "红"); e.addPlayer("B", "黑"); e.start(false);
e.board = bare();
e.board[0][4] = { side: BLACK, type: "K" };
e.board[9][4] = { side: RED, type: "K" };
e.board[3][4] = { side: RED, type: "C" }; // 空头炮：中间无子，不将
e.board[0][2] = { side: BLACK, type: "E" };
e.board[0][3] = { side: BLACK, type: "A" };
e.board[0][6] = { side: BLACK, type: "E" };
e.turn = BLACK;
const e1 = e.tryMove("B", "象3进5");
check("空头炮下飞象自堵被拒", !e1.ok && e1.hint.includes("被将"), e1.hint);
const e2 = e.tryMove("B", "士4进5");
check("空头炮下补士自堵被拒", !e2.ok && e2.hint.includes("被将"), e2.hint);
const e3 = e.tryMove("B", "将5平6"); // (0,5) 空位
check("将5平6 出宫躲避合法", e3.ok, e3.hint || "");

// ---------- 帅不出九宫 / 兵过河横走 ----------
const k = new XiangqiGame();
k.addPlayer("A", "红"); k.addPlayer("B", "黑"); k.start(false);
k.board = bare();
k.board[0][5] = { side: BLACK, type: "K" }; // 黑将摆开，避免双帅照面干扰
k.board[8][4] = { side: RED, type: "K" };
k.board[5][2] = { side: RED, type: "P" }; // 没过河（红方 r>=5 是己方半场）
k.turn = RED;
const k1 = k.tryMove("A", "兵七平八");
check("兵没过河不能横走", !k1.ok && k1.hint.includes("过河"), k1.hint);
const k2 = k.tryMove("A", "兵七进一");
check("兵过河前只能前进", k2.ok, k2.hint || "");
k.board[4][2] = null;
k.board[2][2] = { side: RED, type: "P" }; // 直接摆个过了河的兵
k.turn = RED;
const k3 = k.tryMove("A", "兵七平八");
check("过河后能横走", k3.ok, k3.hint || "");
k.turn = RED;
const k4 = k.tryMove("A", "兵八退一");
check("兵不能后退", !k4.ok && k4.hint.includes("后退"), k4.hint);
k.board[8][4] = null;
k.board[7][4] = { side: RED, type: "K" };
k.turn = RED;
const k5 = k.tryMove("A", "帅五进一"); // (7,4)→(6,4) 出宫
check("帅出九宫被拒", !k5.ok && k5.hint.includes("九宫"), k5.hint);
k.board[7][4] = null;
k.board[8][4] = { side: RED, type: "K" };
k.turn = RED;
const k6 = k.tryMove("A", "帅五进一"); // (8,4)→(7,4) 宫内
check("帅在宫内进一合法", k6.ok, k6.hint || "");

// ---------- 前/后 区分（同列两车）----------
const d = new XiangqiGame();
d.addPlayer("A", "红"); d.addPlayer("B", "黑"); d.start(false);
d.board = bare();
d.board[0][3] = { side: BLACK, type: "K" }; // 黑将摆开，避免双帅照面
d.board[9][4] = { side: RED, type: "K" };
d.board[9][0] = { side: RED, type: "R" };
d.board[8][0] = { side: RED, type: "R" };
const d1 = d.tryMove("A", "车九进一");
check("同列两车必须写前/后", !d1.ok && d1.hint.includes("前"), d1.hint);
const d2 = d.tryMove("A", "前车进一");
check("前车进一 = 更靠前的 (8,0) 动", d2.ok && d2.notation === "前车进一", d2.ok ? d2.notation : d2.hint);
check("动的是 (8,0)→(7,0)", !d.board[8][0] && d.board[7][0] && d.board[7][0].type === "R", "board");
d.turn = RED;
const d3 = d.tryMove("A", "后车进一");
check("后车进一 = (9,0) 动", d3.ok && d3.notation === "后车进一", d3.ok ? d3.notation : d3.hint);

// ---------- 对面笑（帅将照面）----------
const f = new XiangqiGame();
f.addPlayer("A", "红"); f.addPlayer("B", "黑"); f.start(false);
f.board = bare();
f.board[0][4] = { side: BLACK, type: "K" };
f.board[8][4] = { side: RED, type: "K" };
f.board[9][3] = { side: RED, type: "R" };
f.board[5][4] = { side: RED, type: "C" }; // 中路有子挡着
const f1 = f.tryMove("A", "车六进一"); // (9,3) 是红第 6 列
check("中路有子时车随便走", f1.ok, f1.hint || "");
f.board[5][4] = null; // 挪开中路 → 两帅照面
f.turn = RED;
const f2 = f.tryMove("A", "车六进一");
check("两帅照面算被将，不能造成", !f2.ok && f2.hint.includes("被将"), f2.hint);
const f3 = f.tryMove("A", "车六平五");
check("车吃自己帅被拒", !f3.ok, f3.hint || "");

// ---------- 将死 ----------
const m = new XiangqiGame();
m.addPlayer("A", "红"); m.addPlayer("B", "黑"); m.start(false);
m.board = bare();
m.board[0][4] = { side: BLACK, type: "K" };
m.board[8][0] = { side: RED, type: "K" };
m.board[9][3] = { side: RED, type: "R" };
m.board[9][4] = { side: RED, type: "R" };
m.board[9][5] = { side: RED, type: "R" };
m.board[1][0] = { side: RED, type: "R" };
const m1 = m.tryMove("A", "车九进一"); // (1,0) 是红第 9 列，走一步不破坏三车绝杀
check("将死局面红先走一步合法", m1.ok, m1.hint || "");
check("黑被将死 → 红胜", m1.over === true && m1.winBy === "将死", JSON.stringify({ over: m1.over, winBy: m1.winBy }));
check("胜者是红", m.winner && m.winner.side === RED, JSON.stringify(m.winner));

// ---------- 困毙（没被将但无子可走 = 判负）----------
const s = new XiangqiGame();
s.addPlayer("A", "红"); s.addPlayer("B", "黑"); s.start(false);
s.board = bare();
s.board[0][4] = { side: BLACK, type: "K" };
s.board[8][0] = { side: RED, type: "K" };
s.board[1][0] = { side: RED, type: "R" };
s.board[1][8] = { side: RED, type: "R" };
s.board[2][2] = { side: RED, type: "H" };
s.board[2][6] = { side: RED, type: "H" };
s.board[3][3] = { side: RED, type: "P" };
s.board[3][4] = { side: RED, type: "P" };
s.board[3][5] = { side: RED, type: "P" };
const s1 = s.tryMove("A", "兵五进一"); // (3,4)→(2,4)，不给将；黑方无子可动
check("黑困毙（无子可动）→ 红胜", s1.over === true && s1.winBy === "困毙", JSON.stringify({ over: s1.over, winBy: s1.winBy }));

// ---------- 坐标走法：cc21 33 = 从 2 列 1 行走到 3 列 3 行 ----------
const { parseCoordMove } = require("../command/xiangqi/coord");
const cp = (t) => {
    const r = parseCoordMove(t);
    return r.bad ? "BAD" : r.from.col + "," + r.from.row + ">" + r.to.col + "," + r.to.row + (r.piece ? "/" + r.piece : "");
};
check("坐标：空格分隔", cp("21 33") === "2,1>3,3", cp("21 33"));
check("坐标：逗号/顿号/破折号/箭头都算分隔",
    cp("21,33") === "2,1>3,3" && cp("21、33") === "2,1>3,3" && cp("21-33") === "2,1>3,3" && cp("21→33") === "2,1>3,3",
    [cp("21,33"), cp("21、33"), cp("21-33"), cp("21→33")].join(" "));
check("坐标：四位连写", cp("2133") === "2,1>3,3", cp("2133"));
check("坐标：中文数字连写", cp("二一三三") === "2,1>3,3", cp("二一三三"));
check("坐标：第 10 行写「十」", cp("二十三三") === "2,10>3,3", cp("二十三三"));
check("坐标：四个数全用逗号分开", cp("2,10,3,3") === "2,10>3,3", cp("2,10,3,3"));
check("坐标：带「列/行」字样", cp("2列1行3列3行") === "2,1>3,3", cp("2列1行3列3行"));
check("坐标：整句话也认，顺带把棋子名挑出来", cp("把2列1行的马走到3列3行") === "2,1>3,3/马", cp("把2列1行的马走到3列3行"));
check("坐标：全角数字", cp("２１３３") === "2,1>3,3", cp("２１３３"));
check("坐标：只给两个数 → 回「要 4 个数」", parseCoordMove("3,3").bad.includes("4 个"), JSON.stringify(parseCoordMove("3,3")));
check("坐标：起点终点同格被拦", parseCoordMove("33 33").bad.includes("同一格"), JSON.stringify(parseCoordMove("33 33")));
check("坐标：拆不出来的连写把写法念一遍", parseCoordMove("2110").bad.includes("写法"), JSON.stringify(parseCoordMove("2110")));

const cg = new XiangqiGame();
cg.addPlayer("A", "红"); cg.addPlayer("B", "黑"); cg.start(false);
const cm1 = cg.tryMoveCoord("A", { col: 2, row: 1 }, { col: 3, row: 3 });
check("红方 21 33 = 马二进三", cm1.ok && cm1.notation === "马二进三", cm1.ok ? cm1.notation : cm1.hint);
const cm2 = cg.tryMoveCoord("B", { col: 2, row: 1 }, { col: 3, row: 3 });
check("同一串坐标黑方按自己视角走（马2进3）", cm2.ok && cm2.notation === "马2进3", cm2.ok ? cm2.notation : cm2.hint);
check("红马真的落在 (7,6)", !cg.board[9][7] && cg.board[7][6] && cg.board[7][6].type === "H", JSON.stringify(cg.board[7][6]));
check("黑马真的落在 (2,2)", cg.board[2][2] && cg.board[2][2].side === BLACK, JSON.stringify(cg.board[2][2]));
const ce1 = cg.tryMoveCoord("A", { col: 5, row: 5 }, { col: 5, row: 6 });
check("起点是空位 → 说清楚哪儿空", !ce1.ok && ce1.hint.includes("是空的"), ce1.hint);
const ce2 = cg.tryMoveCoord("A", { col: 1, row: 11 }, { col: 1, row: 10 });
check("越界 → 报出 9 列 10 行", !ce2.ok && ce2.hint.includes("超出棋盘"), ce2.hint);
const ce3 = cg.tryMoveCoord("A", { col: 9, row: 10 }, { col: 9, row: 9 });
check("动别人的子 → 点名是谁的什么", !ce3.ok && ce3.hint.includes("黑方的车"), ce3.hint);
const ce4 = cg.tryMoveCoord("A", { col: 3, row: 3 }, { col: 3, row: 2 }, "车");
check("开头写的子和位子上不符 → 提示", !ce4.ok && ce4.hint.includes("你说要走车"), ce4.hint);

// 红黑两边列号是反的，照着对面那圈数字数最容易错，得直接点破
const mb = new XiangqiGame();
mb.addPlayer("A", "红"); mb.addPlayer("B", "黑"); mb.start(false);
mb.board = bare();
mb.board[0][3] = { side: BLACK, type: "K" };
mb.board[9][4] = { side: RED, type: "K" };
mb.board[6][2] = { side: RED, type: "R" };   // 红方看是 7列4行，黑方那圈是 3列7行
mb.turn = RED;
const mir = mb.tryMoveCoord("A", { col: 3, row: 7 }, { col: 5, row: 7 });
check("数反了 → 提示「按对面那圈数字数的」并给出正确坐标",
    !mir.ok && mir.hint.includes("对面那圈数字") && mir.hint.includes("7列4行"), mir.hint);
const mir2 = mb.tryMoveCoord("A", { col: 7, row: 4 }, { col: 7, row: 5 });
check("换成自己的那圈就能走", mir2.ok && mir2.notation === "车七进一", mir2.ok ? mir2.notation : mir2.hint);

// 记谱走错的场合，提示里带上等价的坐标，教一次就会
const nt = new XiangqiGame();
nt.addPlayer("A", "红"); nt.addPlayer("B", "黑"); nt.start(false);
const nt1 = nt.tryMove("A", "马二进四");
check("记谱走非法也回坐标等价写法", !nt1.ok && nt1.hint.includes("2列1行→4列2行"), nt1.hint);

// ---------- 命令层流程（stub client）----------
const sent = [];
client.sendText = async (to, text) => { sent.push({ to, text }); return { Code: 0 }; };
client.displayName = (wxid) => (wxid === "A" ? "红方甲" : "黑方乙");
const ROOM = "44699859849@chatroom";
games.delete(ROOM);
const fired = [];
async function fire(userId, text) {
    const event = {
        type: "group",
        group_id: ROOM,
        sender: { user_id: userId, nick: userId },
        message: [{ type: "text", text }],
        atme: true,
        client,
        reply: async (c) => { fired.push(typeof c === "string" ? c : (c && c.text) || (c && c.image ? "[图片]" : "")); },
    };
    getXiangqiCommand(event, text);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
}
(async () => {
    await fire("A", "象棋");
    await fire("B", "象棋");
    check("开局回复带红黑分配", fired.some((t) => t.includes("红先走")), fired.slice(-1)[0]);
    const game = games.get(ROOM);
    check("棋局建起来了", !!game && game.started, "no game");
    check("开局后贴了盘面图", fired.some((t) => t === "[图片]"), fired.join(" | ").slice(0, 80));
    const redId = game.playerBySide(RED).id;
    const blackId = game.playerBySide(BLACK).id;
    await fire(redId, "炮二平五");
    const gmove = game.moves[game.moves.length - 1];
    check("红走 炮二平五 落盘", gmove && gmove.notation === "炮二平五", JSON.stringify(gmove));
    await fire(blackId, "马8进7");
    check("黑走 马8进7 落盘", game.moves.length === 2 && game.moves[1].notation === "马8进7", JSON.stringify(game.moves[1]));
    await fire(redId, "马二进三");
    await fire(blackId, "坏走法");
    check("坏走法回复会拆坐标并说清楚怎么拆", fired.some((t) => t.includes("这步不走") && t.includes("拆不出两个坐标")), fired.slice(-1)[0]);
    // 坐标输入：黑方按自己那圈数，91 81 = 车9平8
    await fire(blackId, "91 81");
    check("黑坐标 91 81 落盘 = 车9平8", game.moves.length === 4 && game.moves[3].notation === "车9平8", JSON.stringify(game.moves.slice(-1)));
    check("坐标走法回复里带坐标", fired.some((t) => t.includes("9列1行→8列1行")), fired.slice(-1)[0]);
    await fire(redId, "54 55");
    check("红坐标 54 55 落盘 = 兵五进一", game.moves.length === 5 && game.moves[4].notation === "兵五进一", JSON.stringify(game.moves.slice(-1)));
    check("红坐标回复里带坐标", fired.some((t) => t.includes("5列4行→5列5行")), fired.slice(-1)[0]);
    await fire(blackId, "55 56");
    check("坐标起点空位 → 回「这步不走」并点明空格", fired.some((t) => t.includes("这步不走") && t.includes("是空的")), fired.slice(-1)[0]);
    await fire(redId, "车9平8");
    check("黑子红走被拒并提示轮次", fired.some((t) => t.includes("还没轮到")), fired.slice(-1)[0]);
    await fire(redId, "棋盘");
    check("cc棋盘 回状态并贴图", fired.some((t) => t.includes("轮到")) && fired.slice(-1)[0] === "[图片]", fired.slice(-1)[0]);
    await fire(blackId, "认输");
    check("认输判红胜", game.winner && game.winner.side === RED, JSON.stringify(game.winner));
    await fire(redId, "结束");
    check("结束后清盘", !games.has(ROOM), "still there");

    console.log(failed ? "\n" + failed + " 条失败" : "\n全部通过");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
