"use strict";
// 麻将引擎 + 四套规则计分 + 命令层断言。
// 牌型地基（向听/待牌/和牌）先于计分验，因为四套规则的算番全压在它上面。
const path = require("path");
process.env.state_file = process.env.state_file || path.join(__dirname, "..", "test", "tmp-mahjong-state.json");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const T = require("../command/mahjong/tiles");
const H = require("../command/mahjong/hand");
const R = require("../command/mahjong/scoring/riichi");

let failed = 0;
function check(label, cond, extra) {
    if (!cond) failed++;
    console.log((cond ? "  ok   " : "  FAIL ") + label + (cond ? "" : "  → " + extra));
}

// 「123m456p東白白」这种紧凑写法 -> 排序好的 id 数组
function idsOf(spec) {
    const counts = T.emptyCounts();
    const re = /([1-9]+)([mps])/g;
    let m;
    while ((m = re.exec(spec))) {
        const base = { m: 0, p: 9, s: 18 }[m[2]];
        for (const d of m[1]) counts[base + Number(d) - 1]++;
    }
    for (const ch of spec.replace(/[1-9]+[mps]/g, "")) {
        const id = T.parseTile(ch);
        if (id !== null) counts[id]++;
    }
    return T.tilesFromCounts(counts);
}
function countsOf(spec) {
    return T.countsOf(idsOf(spec));
}
const names = (list) => T.sortTiles(list).map(T.tileName).join(" ");

// ---------- 牌地基 ----------
check("日麻牌墙 136 张", T.makeWall({ honors: true }).length === 136, T.makeWall({ honors: true }).length);
check("血战牌墙 108 张（无字牌）", T.makeWall({ honors: false }).length === 108, T.makeWall({ honors: false }).length);
check("带花牌墙 144 张", T.makeWall({ honors: true, flowers: true }).length === 144, T.makeWall({ flowers: true }).length);
const redWall = T.makeWall({ reds: 3 });
check("三赤标在 5万5筒5条", redWall.filter((t) => t.red).map((t) => T.tileShort(t.id)).sort().join(",") === "5万,5条,5筒",
    redWall.filter((t) => t.red).map((t) => T.tileShort(t.id)).join(","));
check("赤牌张数可配到 0", T.makeWall({ reds: 0 }).every((t) => !t.red));
check("牌墙每种牌不超 4 枚", (() => {
    const c = {};
    for (const t of redWall) c[t.id] = (c[t.id] || 0) + 1;
    return Object.values(c).every((n) => n === 4);
})(), "count");
check("花牌只出现一次", (() => {
    const w = T.makeWall({ flowers: true }).filter((t) => T.isFlower(t.id)).map((t) => t.id);
    return w.length === 8 && new Set(w).size === 8;
})(), "flowers");

check("解析 5万 / 五萬 / 5m 同一张", T.parseTile("5万") === T.parseTile("五萬") && T.parseTile("五萬") === T.parseTile("5m"), T.parseTile("5m"));
check("解析全角 ５万", T.parseTile("５万") === 4, T.parseTile("５万"));
check("解析风牌 東/东/东风", T.parseTile("東") === 27 && T.parseTile("东") === 27 && T.parseTile("东风") === 27, "wind");
check("解析三元 中/發/白", T.parseTile("中") === 31 && T.parseTile("发") === 32 && T.parseTile("白板") === 33, "dragon");
check("解析花牌 春/菊", T.parseTile("春") === 34 && T.parseTile("菊") === 41, "flower");
check("乱写解析为 null", T.parseTile("炸他") === null && T.parseTile("0万") === null && T.parseTile("10万") === null, "garbage");
check("解析顺子串 3万4万5万", T.parseTiles("3万4万5万").join(",") === "2,3,4", T.parseTiles("3万4万5万").join(","));
check("解析裸点数 34（配合 cc吃34）", T.parseRanks("34").join(",") === "3,4" && T.parseRanks("三四").join(",") === "3,4", T.parseRanks("34"));
check("点数串不吃花色", T.parseRanks("5万") === null);
check("花色解析 条", T.parseSuit("条") === "s" && T.parseSuit("萬") === "m", "suit");
check("计数数组往返", T.tilesFromCounts(countsOf("123m456p東白白")).join(",") === idsOf("123m456p東白白").join(","), "roundtrip");
check("幺九/中张分类", T.isYoung(0) && T.isYoung(27) && !T.isYoung(4) && T.isSimple(4) && !T.isSimple(0), "class");

// ---------- 牌型：和牌 / 向听 / 待牌 ----------
const WINS = [
    "123m456m789m123p55s",
    "111m222p333s444m55s",
    "11m234m567m789m123m",
    "123m123m123p123p55s",
    "中中中發發發白白白123m55s",
];
for (const spec of WINS) check("和牌型 " + spec, H.isWin(countsOf(spec), { melds: 0 }), "not win");
check("七对和牌", H.isWin(countsOf("11m22p33s44m55s66m77p"), {}));
check("国士和牌", H.isWin(countsOf("19m19p19s東南西北中發白白"), {}));
check("十三张不算和", !H.isWin(countsOf("123m456m789m12p55s"), {}));
check("十四张但凑不出面子不算和", !H.isWin(countsOf("123m456m789m1p55s22p"), {}));
check("副露 2 组、门前 8 张成和", H.isWin(countsOf("123m456p55s"), { melds: 2 }), "meld win");
check("副露 1 组、门前 11 张成和", H.isWin(countsOf("123m456m789m55m"), { melds: 1 }), "meld win 1");

const SHANTEN = [
    ["123m456m789m123p55s", -1],
    ["123m456m789m12p55s", 0],
    ["123m456m789m13p55s", 0],
    ["123m456p789s11p22s", 0],
    ["11m22p33s44m55s66m7p", 0],
    ["19m19p19s東南西北中發白", 0],
    ["123m456m789m1p55s", 1],
    ["111222333m123p55s", -1],
];
for (const [spec, want] of SHANTEN) {
    check("向听 " + spec + " = " + want, H.shanten(countsOf(spec), {}) === want, H.shanten(countsOf(spec), {}));
}
check("双碰听两面牌", names(H.waits(countsOf("123m456p789s11p22s"), {})) === "一筒 二条", names(H.waits(countsOf("123m456p789s11p22s"), {})));
check("七对听单张", names(H.waits(countsOf("11m22p33s44m55s66m7p"), {})) === "七筒", names(H.waits(countsOf("11m22p33s44m55s66m7p"), {})));
check("国士十三面听", H.waits(countsOf("19m19p19s東南西北中發白"), {}).length === 13, H.waits(countsOf("19m19p19s東南西北中發白"), {}).length);
check("坎张听嵌张", names(H.waits(countsOf("123m456m789m13p55s"), {})) === "二筒", names(H.waits(countsOf("123m456m789m13p55s"), {})));
check("副露修正向听（2 露 7 张听牌）", H.shanten(countsOf("123m45p55s"), { melds: 2 }) === 0, H.shanten(countsOf("123m45p55s"), { melds: 2 }));
check("已向听数不为负（乱牌下限）", H.shanten(countsOf("159m159p159s東南西北"), {}) >= 0);

// 不变式：和牌 <=> -1 向听；听牌 <=> 有待牌
let violated = 0;
for (let k = 0; k < 3000; k++) {
    const wall = T.shuffle(T.makeWall({ honors: true, reds: 3 })).slice(0, 14).map((t) => t.id);
    const full = T.countsOf(wall);
    if ((H.shantenStandard(full, 0) === -1) !== H.isStandardWin(full, 0)) violated++;
    const c13 = full.slice();
    c13[wall[k % 14]]--;
    const tenpai = H.shantenStandard(c13, 0) === 0;
    const hasWait = H.waits(c13, { melds: 0, chiitoi: false, kokushi: false }).length > 0;
    if (tenpai !== hasWait) violated++;
}
check("随机 3000 手不变式 0 违例", violated === 0, violated);

// 分解个数（算番要用全部拆法）
check("111222333m+55s 有 2 种拆法", H.allDecompositions(countsOf("111222333m55s")).length === 2, H.allDecompositions(countsOf("111222333m55s")).length);
check("123456789m+55s 只有 1 种拆法", H.allDecompositions(countsOf("123456789m55s")).length === 1, H.allDecompositions(countsOf("123456789m55s")).length);
check("振听：自己打过待牌", H.isFuriten([4, 18], [4], []).yes === true);
check("振听：同巡别人打过", H.isFuriten([4], [], [4]).yes === true);
check("振听：待牌不含现张", H.isFuriten([4, 18], [2, 30], []).yes === false);

// ---------- 日麻计分 ----------
function win(spec, extra) {
    const list = idsOf(spec);
    const base = {
        concealedIds: list,
        concealedTiles: list.map((i) => ({ id: i, red: false })),
        melds: [],
        winSeat: 1,
        dealerSeat: 0,
        seatWind: 1,
        roundWind: 0,
    };
    return R.scoreWin(Object.assign(base, extra || {}));
}
function fanNames(r) {
    return r.fans.map((f) => f.name).join(",");
}

const r1 = win("123m456m789m123p55s", { winTile: 9, selfDrawn: false, discarderSeat: 2, waitShape: "ryanmen" });
check("平和+一气通贯 3 番 30 符 子荣和 3900", r1.ok && r1.han === 3 && r1.fu === 30 && r1.total === 3900, JSON.stringify({ h: r1.han, f: r1.fu, t: r1.total }));

const r2 = win("123m456m789m123p55s", { winTile: 9, selfDrawn: true, riichi: true, ippatsu: true, waitShape: "ryanmen" });
check("平立一发... 6 番跳满 12000", r2.ok && r2.han === 6 && r2.level === "跳满" && r2.total === 12000, JSON.stringify({ h: r2.han, lv: r2.level, t: r2.total }));

// 一色三同顺只能用副露版来验：门前 123m123m123m 同时也能拆成 111m222m333m（三暗刻），
// 两种拆法番数相同、符数看牌，算番取优本来就是对的，拿它测「有没有认出三同顺」会一直打架。
const r3 = win("123m456p55s", {
    winTile: 2, selfDrawn: true, waitShape: "ryanmen",
    melds: [{ type: "chi", tiles: [0, 1, 2] }, { type: "chi", tiles: [0, 1, 2] }],
});
// 有副露就不是门前清，自摸不加番，所以只有三同顺本身的 1 番
check("一色三同顺（两组副露+一组门前）副露 1 番且不吃一杯口",
    r3.ok && fanNames(r3).includes("一色三同顺") && !fanNames(r3).includes("一杯口") && r3.han === 1,
    JSON.stringify({ f: fanNames(r3), h: r3.han, fu: r3.fu }));

const r4 = win("中中中發發發白白白123m55s", { winTile: 33, selfDrawn: true, waitShape: "shanpon" });
check("大三元 = 役满 32000（子自摸）", r4.ok && r4.yakuman === 1 && r4.level === "役满" && r4.total === 32000, JSON.stringify({ y: r4.yakuman, lv: r4.level, t: r4.total }));
// 役满不与数役叠加，但宣言/局面役要留：立直、自摸这类不因役满而消失
check("大三元仍保留自摸，只有三元役牌不重复计", r4.ok && fanNames(r4) === "门前清自摸和,大三元", fanNames(r4));

const r5 = win("111m222p333s444m55s", { winTile: 22, selfDrawn: true, waitShape: "tanki" });
check("四暗刻单骑 = 二倍役满 64000", r5.ok && r5.yakuman === 2 && r5.total === 64000, JSON.stringify({ y: r5.yakuman, t: r5.total }));

const r6 = win("111m222p333s444m55s", { winTile: 3, selfDrawn: false, discarderSeat: 3, waitShape: "shanpon" });
check("荣和补的刻子不算暗刻（四暗刻降为三暗刻+对对和）", r6.ok && r6.yakuman === 0 && fanNames(r6).includes("三暗刻"), JSON.stringify({ y: r6.yakuman, f: r6.fans }));

const r7 = win("11m33p55s77m22s99p33s", { winTile: 2, selfDrawn: true, waitShape: "tanki" });
check("七对子自摸 3 番 50 符 6400", r7.ok && fanNames(r7).includes("七对子") && r7.fu === 50 && r7.total === 6400, JSON.stringify({ f: r7.fans, t: r7.total }));

const r8 = win("19m19p19s東南西北中發白白", { winTile: 33, selfDrawn: true, waitShape: "tanki", kokushi13: true });
check("国士十三幺 = 二倍役满", r8.ok && r8.yakuman === 2 && r8.total === 64000, JSON.stringify({ y: r8.yakuman, t: r8.total }));
check("国士不掺全带幺/混老头", r8.ok && fanNames(r8) === "门前清自摸和,国士无双（二倍）,国士无双（二倍）", fanNames(r8));

const r9 = win("11m234m567m789m123m", { winTile: 1, selfDrawn: true, waitShape: "penchan" });
check("清一色自摸 = 6+1 番 跳满", r9.ok && r9.han === 7 && r9.level === "跳满", JSON.stringify({ ok: r9.ok, h: r9.han, lv: r9.level, r: r9.reason }));

const r10 = win("中中中發發發白白123m456p", { winTile: 32, selfDrawn: false, discarderSeat: 0, waitShape: "shanpon" });
check("小三元+两张役牌 = 4 番 40 符 满贯", r10.ok && r10.han === 4 && r10.fu === 40 && r10.level === "满贯", JSON.stringify({ h: r10.han, f: r10.fu, lv: r10.level }));

const r11 = win("123m456p789s89m55p7m", { winTile: 7, selfDrawn: false, discarderSeat: 2, waitShape: "penchan", doraIndicators: [0, 9] });
check("无役（只有宝牌）不能和", r11.ok === false && r11.reason.includes("无役"), JSON.stringify(r11));

const r12 = win("123m456m789m123p55s", { winTile: 9, selfDrawn: true, waitShape: "ryanmen", doraIndicators: [10] });
check("宝牌只加番：平+一气+自摸+宝 = 5 番", r12.ok && r12.han === 5 && fanNames(r12).includes("宝牌"), JSON.stringify({ h: r12.han, f: fanNames(r12) }));

const r13 = win("111m222p333s444m55s", { winTile: 22, selfDrawn: true, waitShape: "tanki", riichi: true });
check("役满时不列数役", r13.ok && fanNames(r13).indexOf("对对和") === -1, fanNames(r13));

const r14 = win("123m456m789m55m", Object.assign({ winTile: 4, waitShape: "shanpon", selfDrawn: true }, { melds: [{ type: "pon", tiles: [31, 31, 31] }] }));
check("副露混一色按副露番（混一色2+中刻1+自摸1=4 番 30 符，子自摸 4000/2000/2000=7900）", r14.ok && r14.han === 4 && r14.fu === 30 && r14.total === 7900,
    JSON.stringify({ ok: r14.ok, h: r14.han, f: r14.fu, t: r14.total, r: r14.reason }));

// 一杯口：要挑一副「不是七对子」的形，否则算番取优时七对子 50 符本来就该赢
// 一杯口要挑拆不出七对的形（1/2/3m+9m 只凑出 4 个对子），否则算番取优时七对子 50 符本来就该赢
const r15 = win("123m123m456p678p99m", { winTile: 8, selfDrawn: true, waitShape: "tanki" });
check("一杯口 1 番 + 自摸 = 2 番", r15.ok && fanNames(r15).includes("一杯口") && r15.han === 2, fanNames(r15));
// 二杯口同理：223344m556677p33s 也拆得出七对，靠平和+断幺把番数抬过去才轮得到它
// （112233m 那型不行，1 万是幺九牌，断幺九不成立，番数就压不过七对子 50 符）
const r16 = win("223344m556677p33s", { winTile: 3, selfDrawn: true, waitShape: "ryanmen" });
check("二杯口+平和+断幺+自摸 = 5 番满贯，且不再计一杯口",
    r16.ok && fanNames(r16).includes("二杯口") && !fanNames(r16).includes("一杯口") && r16.han === 5 && r16.total === 8000,
    JSON.stringify({ f: fanNames(r16), h: r16.han, t: r16.total }));

check("立直棒结算：三根 3000", (() => {
    const r = win("123m456m789m123p55s", { winTile: 9, selfDrawn: false, discarderSeat: 2, waitShape: "ryanmen", riichi: true, honba: 3, riichiSticks: 2 });
    return r.ok && r.honbaGain === 900 && r.total === r.payments[0].amount + 2000;
})(), "sticks");

check("符：30 符 1 番不存在，按 40 符", R.levelOf(1, 30).base === R.levelOf(1, 40).base, JSON.stringify([R.levelOf(1, 30), R.levelOf(1, 40)]));
check("点数：30 符 4 番子荣和 7700", R.paymentsFor(R.levelOf(4, 30).base, 1, 0, false, 2)[0].amount === 7700, R.levelOf(4, 30).base);
check("点数：30 符 4 番亲荣和 11600", R.paymentsFor(R.levelOf(4, 30).base, 0, 0, false, 1)[0].amount === 11600);
check("点数：满贯子自摸 2000/2000/4000", (() => {
    const p = R.paymentsFor(2000, 1, 0, true);
    return p.map((x) => x.amount).sort((a, b) => a - b).join(",") === "2000,2000,4000";
})(), "mangan tsumo");
check("点数：役满子荣和 32000 / 亲荣和 48000", R.paymentsFor(8000, 1, 0, false, 2)[0].amount === 32000 && R.paymentsFor(8000, 0, 0, false, 1)[0].amount === 48000);
check("数え役满：13 番按役满", R.levelOf(13, 30).yakuman === 1);

const b1 = R.buppaiPayments([1, 2], 0);
check("流局罚符：两子听 -> 未听各付 1500、听家各收 1500", b1.perPayer.join(",") === "1500,1500" && b1.perWinner.join(",") === "1500,1500", JSON.stringify(b1));
const b2 = R.buppaiPayments([0], 0);
check("流局罚符：亲听独听 -> 未听各付 2000、亲收 6000", b2.perPayer.join(",") === "2000,2000,2000" && b2.perWinner[0] === 6000, JSON.stringify(b2));
const b3 = R.buppaiPayments([0, 2], 0);
check("流局罚符：亲+子听 -> 未听各付 3000、亲收 4000 子收 2000", b3.perPayer.join(",") === "3000,3000" && b3.perWinner.join(",") === "4000,2000", JSON.stringify(b3));
check("流局罚符：逐对拆分总额与付出一致", b3.transfers.reduce((a, x) => a + x.amount, 0) === 6000, b3.transfers);
check("流局罚符：全听牌不付", R.buppaiPayments([0, 1, 2, 3], 0).length === 0 || R.buppaiPayments([0, 1, 2, 3], 0).transfers.length === 0);

check("中途流局识别", ["四风连打", "九种九牌", "四杠散了", "三家和"].every((by) => {
    const map = { fourWindsSameTile: true, nineKindsFirstTurn: true, fourKansNoWall: true, threeRonSameTile: true };
    const keys = { "四风连打": "fourWindsSameTile", "九种九牌": "nineKindsFirstTurn", "四杠散了": "fourKansNoWall", "三家和": "threeRonSameTile" };
    const checks = {};
    for (const k of Object.values(map)) checks[k] = false;
    checks[keys[by]] = true;
    return R.abortiveDraw(checks).by === by;
}), "abort");

check("宝牌指示牌推宝牌", [R.doraOf(0), R.doraOf(8), R.doraOf(27), R.doraOf(30), R.doraOf(31), R.doraOf(33)].join(",") === "1,0,28,27,32,31",
    [R.doraOf(0), R.doraOf(8), R.doraOf(27), R.doraOf(30), R.doraOf(31), R.doraOf(33)].join(","));
check("九莲宝灯识别", R.chuRenCount(countsOf("1112345678999m1m")).yes === true, JSON.stringify(R.chuRenCount(countsOf("1112345678999m1m"))));
check("非九莲不误判", R.chuRenCount(countsOf("123m456m789m11m55s")).yes === false);

// ---------- 命令记法（立直与出牌同一条） ----------
const N = require("../command/mahjong/notation");
check("cc三万立直 = 打三万并宣言立直", JSON.stringify(N.parseRiichi("三万立直")) === '{"tile":2}', JSON.stringify(N.parseRiichi("三万立直")));
check("cc3万立直 / cc5m立直 / 全角都认", N.parseRiichi("3万立直").tile === 2 && N.parseRiichi("5m立直").tile === 4 && N.parseRiichi("５筒立直").tile === 13,
    JSON.stringify([N.parseRiichi("3万立直"), N.parseRiichi("5m立直"), N.parseRiichi("５筒立直")]));
check("打三万立直 也认（前缀打可选）", N.parseRiichi("打三万立直").tile === 2, JSON.stringify(N.parseRiichi("打三万立直")));
check("光发 cc立直 提示要带牌", N.parseRiichi("立直").needTile === true, JSON.stringify(N.parseRiichi("立直")));
check("cc炸他立直 认不出牌会点名", N.parseRiichi("炸他立直").badTile === "炸他", JSON.stringify(N.parseRiichi("炸他立直")));
check("普通打牌不带立直", N.parseRiichi("三万") === null && N.parseDiscard("打三万") === 2, "discard");
check("副露记法：碰五筒 / 暗杠五筒 / 补杠 / 吃34 / 缺条 / 过", (() => {
    const pon = N.parseClaim("碰五筒"), an = N.parseClaim("暗杠五筒"), add = N.parseClaim("补杠五条");
    const chi = N.parseClaim("吃34"), miss = N.parseClaim("缺条"), pass = N.parseClaim("过");
    return pon.claim === "pon" && pon.tile === 13 && an.claim === "ankan" && an.tile === 13 &&
        add.claim === "ranka" && add.tile === 22 && chi.claim === "chi" && chi.ranks.join(",") === "3,4" &&
        miss.claim === "miss" && miss.suit === "s" && pass.claim === "pass";
})(), JSON.stringify([N.parseClaim("碰五筒"), N.parseClaim("暗杠五筒"), N.parseClaim("补杠五条"), N.parseClaim("吃34"), N.parseClaim("缺条"), N.parseClaim("过")]));
check("和牌记法：cc和 / cc自摸 / cc和了", N.parseClaim("和").claim === "ron" && N.parseClaim("自摸").claim === "tsumo" && N.parseClaim("和了").claim === "ron", "win");

// ---------- 血战到底（四川） ----------
const S = require("../command/mahjong/scoring/sichuan");
// 血战只打万筒条、起手定缺，缺门那门必须先打光。下面这些牌型全部按「缺条」算，
// 所以牌里一张条子都不能有——带条子的那一手是专门测花猪拒和的。
const PINGHU = "123m456m123p456p55m";
function sc(spec, extra) {
    return S.scoreWin(Object.assign({
        concealedIds: idsOf(spec), melds: [], winTile: null, queSuit: "s",
        selfDrawn: true, winSeat: 0, base: 1,
    }, extra || {}));
}
const keysOf = (res) => (res.fans || []).map((f) => f.key).join(",");
const has = (res, key) => ("," + keysOf(res) + ",").indexOf("," + key + ",") >= 0;

const s1 = sc(PINGHU);
check("血战平胡：门清 1 番 = 2 倍，自摸三家各付", s1.ok && s1.fan === 1 && s1.mult === 2 &&
    s1.payments.length === 3 && s1.total === 6, JSON.stringify(s1));
const s2 = sc("111m999m555p777p22m");
check("血战对对胡 1 番 + 门清 1 番 = 4 倍", s2.ok && s2.fan === 2 && s2.mult === 4, JSON.stringify(s2));
const s3 = sc("111m222m333m444m55m");
check("清一色对对胡门清共 4 番，默认 3 番封顶按 8 倍裁", s3.ok && s3.rawFan === 4 && s3.capped &&
    s3.fan === 3 && s3.mult === 8, JSON.stringify(s3));
const s4 = sc("1133557799m22p44p");
check("七对 2 番且不再叠门清", s4.ok && s4.kind === "chiitoi" && s4.fan === 2 && !has(s4, "menzen"),
    JSON.stringify(s4));
const s5 = sc("111133557799m22p");
check("龙七对顶替七对（4 番，不重复计）", s5.ok && s5.rawFan === 4 && has(s5, "longqidui") && !has(s5, "qidui"),
    JSON.stringify(s5));
const pon = (t) => ({ type: "pon", tiles: [t, t, t] });
const s6 = S.scoreWin({ concealedIds: idsOf("88m"), melds: [pon(0), pon(4), pon(9), pon(13)],
    queSuit: "s", selfDrawn: false, winSeat: 0, discarderSeat: 2, base: 1 });
check("金钩钓 2 番 + 对对胡 + 点炮全求人，共 4 番取封顶 8 倍", s6.ok && s6.kind === "standard" &&
    has(s6, "jingoudiao") && has(s6, "quanqiu") && s6.rawFan === 4 && s6.mult === 8, JSON.stringify(s6));
check("点炮只由放炮那一家付全额", s6.ok && s6.payments.length === 1 && s6.payments[0].seat === 2 &&
    s6.payments[0].amount === 8, JSON.stringify(s6.payments));
const s7 = sc("123m456m789p123s55p");
check("缺门还有牌就是花猪，和不了", !s7.ok && /花猪/.test(s7.reason), JSON.stringify(s7));
const s8 = S.scoreWin({ concealedIds: idsOf("23m456m123p456p55m"), melds: [{ type: "chi", tiles: [1, 2, 3] }],
    queSuit: "s", selfDrawn: true, winSeat: 0, base: 1 });
check("血战不能吃：带顺子副露直接拒", !s8.ok && /不能吃/.test(s8.reason), JSON.stringify(s8));
check("没定缺不能和牌，提示要给出缺命令", /定缺/.test(sc(PINGHU, { queSuit: null }).reason), "no-que");
const s9 = sc("111m222m333m444m55m", { fanCap: false });
check("fanCap:false 就不封顶（16 倍），fanCap:1 就压到 2 倍",
    s9.ok && s9.rawFan === 4 && !s9.capped && s9.mult === 16 &&
    sc("111m222m333m444m55m", { fanCap: 1 }).mult === 2, JSON.stringify(s9));
check("海底捞月只在牌墙摸完自摸时算，河底捞鱼只在末张点炮时算",
    has(sc(PINGHU, { wallEmpty: true }), "haidi") &&
    has(sc(PINGHU, { wallEmpty: true, selfDrawn: false, discarderSeat: 1 }), "hedi") &&
    !has(sc(PINGHU), "haidi"), keysOf(sc(PINGHU, { wallEmpty: true })));
check("杠上开花要自摸、杠上炮要点炮且付钱的是刚杠那家",
    has(sc(PINGHU, { afterGangDraw: true }), "gangshang") &&
    has(S.scoreWin({ concealedIds: idsOf(PINGHU), melds: [], queSuit: "s", selfDrawn: false,
        winSeat: 0, discarderSeat: 2, gangPlayerSeat: 2, base: 1 }), "gangshangpao"), "杠上");
check("抢杠和算 1 番，且由抢杠那家对应的放杠者独付", (() => {
    const q = S.scoreWin({ concealedIds: idsOf(PINGHU), melds: [], queSuit: "s", selfDrawn: false,
        robbedKang: true, winSeat: 0, discarderSeat: 3, base: 1 });
    return q.ok && has(q, "qianggang") && q.payments.length === 1 && q.payments[0].seat === 3 &&
        q.payments[0].why === "抢杠";
})(), "抢杠");
check("十八罗汉：四组杠 + 单钓将，不封顶能到 8 番", (() => {
    const r = S.scoreWin({ concealedIds: idsOf("55m"), fanCap: false,
        melds: [{ type: "kan", tiles: [0, 0, 0, 0], concealed: true },
            { type: "kan", tiles: [8, 8, 8, 8], concealed: true },
            { type: "kan", tiles: [9, 9, 9, 9], concealed: true },
            { type: "kan", tiles: [17, 17, 17, 17], concealed: true }],
        queSuit: "s", selfDrawn: true, winSeat: 0, base: 1 });
    return r.ok && has(r, "luohan") && r.rawFan >= 8;
})(), "十八罗汉");
check("天胡顶掉地胡，两者不同时计", has(sc(PINGHU, { tianhu: true, dihu: true }), "tianhu") &&
    !has(sc(PINGHU, { tianhu: true, dihu: true }), "dihu"), "天/地胡");
const g1 = S.gangSettle({ kind: "anzeng", seat: 0, otherSeats: [1, 2, 3], base: 2 });
check("暗杠下雨：三家各付 2 倍底，杠家收钱", g1.to === 0 && g1.payments.length === 3 &&
    g1.payments.every((p) => p.amount === 4), JSON.stringify(g1));
const g2 = S.gangSettle({ kind: "diangang", seat: 0, discarderSeat: 2, otherSeats: [1, 2, 3], base: 2 });
check("点杠：放杠那一家独付 2 倍底", g2.payments.length === 1 && g2.payments[0].seat === 2 &&
    g2.payments[0].amount === 4, JSON.stringify(g2));
const g3 = S.gangSettle({ kind: "bugang", seat: 0, otherSeats: [1, 2, 3], base: 2 });
check("补杠巴杠：三家各付 1 倍底", g3.payments.every((p) => p.amount === 2), JSON.stringify(g3));
const lj = S.liujuSettle({ base: 1, players: [
    { seat: 0, queLeft: 0, ting: true, maxFan: 2 }, { seat: 1, queLeft: 0, ting: false, maxFan: 0 },
    { seat: 2, queLeft: 3, ting: false, maxFan: 0 }, { seat: 3, queLeft: 0, ting: false, maxFan: 0 }] });
// 记账口径：payments[].seat 永远是付款人，to 是收款人
check("查花猪最重：按封顶赔给另外三家", lj.filter((p) => p.why === "查花猪" && p.seat === 2).length === 3 &&
    lj.filter((p) => p.why === "查花猪" && p.seat === 2).every((p) => p.amount === 8), JSON.stringify(lj));
check("查叫：没听牌但非花猪的，按听牌家的番赔", lj.some((p) => p.why === "查叫" && p.seat === 1 &&
    p.to === 0 && p.amount === 4), JSON.stringify(lj));
check("听牌但又是花猪的，只按花猪赔一次，不重复掏两遍", (() => {
    const r = S.liujuSettle({ base: 1, players: [
        { seat: 0, queLeft: 2, ting: true, maxFan: 1 }, { seat: 1, queLeft: 0, ting: false, maxFan: 0 },
        { seat: 2, queLeft: 0, ting: false, maxFan: 0 }, { seat: 3, queLeft: 0, ting: false, maxFan: 0 }] });
    return r.filter((p) => p.seat === 0).length === 3 && r.every((p) => p.why === "查花猪");
})(), "花猪+听");
check("定缺判定：缺门清空才算干净", S.queCleared(countsOf("123m456p"), "s") &&
    !S.queCleared(countsOf("123m456s"), "s"), "queCleared");

// ---------- 广东鸡平胡 ----------
const G = require("../command/mahjong/scoring/gd");
// 广东带字牌、能吃，分「鸡胡 / 平胡 / 爆胡」三档；这些牌型不设缺门。
function gd(spec, extra) {
    return G.scoreWin(Object.assign({
        concealedIds: idsOf(spec), melds: [], winTile: null,
        selfDrawn: false, winSeat: 0, discarderSeat: 1, base: 1,
    }, extra || {}));
}
const gname = (res) => (res.fans || []).map((f) => f.name).join("+");

const d1 = gd("123m444p123s789s中中");
check("广东鸡胡：摊不上任何番型也能胡，1 倍底、食糊者独付",
    d1.ok && d1.fan === 0 && d1.mult === 1 && d1.payments.length === 1 &&
    d1.payments[0].seat === 1 && gname(d1) === "鸡胡", JSON.stringify(d1));
const d2 = gd("123m456m123p456p55m", { selfDrawn: true });
check("广东平胡：全顺子 1 番，自摸再加 1 番 = 4 倍、三家各付",
    d2.ok && d2.rawFan === 2 && d2.mult === 4 && d2.payments.length === 3, JSON.stringify(d2));
const d3 = gd("111m999m555p777p22m");
check("广东碰碰胡 2 番（两门花色就不算混一色）", d3.ok && d3.rawFan === 2 && d3.mult === 4 &&
    gname(d3) === "碰碰胡", JSON.stringify(d3));
const d4 = gd("123m456m789m中中中白白", { selfDrawn: true });
check("混一色 2 + 箭刻 1 + 自摸 1 = 4 番，爆胡裁到 3 番 8 倍",
    d4.ok && d4.kind === "standard" && d4.rawFan === 4 && d4.capped && d4.fan === 3 && d4.mult === 8,
    JSON.stringify(d4));
const d5 = gd("111m222m333m444m55m");
check("清碰（清一色+碰碰胡）属爆胡外：独占 5 番 32 倍，不吃封顶",
    d5.ok && d5.kind === "special" && d5.rawFan === 5 && !d5.capped && d5.mult === 32 &&
    gname(d5) === "清碰", JSON.stringify(d5));
const d5b = gd("123m123m456m999m55m");
check("带顺子的纯一门才是清一色 4 番，不是清碰",
    d5b.ok && gname(d5b) === "清一色" && d5b.mult === 16, JSON.stringify(d5b));
const d6 = gd("111m222m333m444m55m", { selfDrawn: true, seatWind: 0, fanCap: false });
check("爆胡外的牌型不叠自摸/门风（就算不封顶也一样）",
    d6.ok && d6.rawFan === 5 && d6.mult === 32, JSON.stringify(d6));
const d7 = gd("中中中發發發白白白123m11m");
check("大三元 6 番 64 倍，压过混一色的拆法", d7.ok && d7.mult === 64 && gname(d7) === "大三元",
    JSON.stringify(d7));
const d8 = gd("中中中發發發白白123m456m");
check("小三元：两副箭刻加三元做将，5 番独占", d8.ok && gname(d8) === "小三元" && d8.mult === 32,
    JSON.stringify(d8));
const d9 = gd("東東南南西西北北中中發發白白");
check("七对全字牌按字一色 6 番，不再按七对 5 番", d9.ok && d9.mult === 64 && gname(d9) === "字一色",
    JSON.stringify(d9));
const g10 = gd("1133557799m22p44p");
check("七对 5 番 32 倍", g10.ok && g10.mult === 32 && gname(g10) === "七对", JSON.stringify(g10));
const g11 = gd("111m999m111p999p11s");
check("清幺九：连将牌一起只看 1/9，6 番", g11.ok && gname(g11) === "清幺九" && g11.mult === 64,
    JSON.stringify(g11));
const g12 = gd("东东东南南南西西西北北北中中");
check("大四喜与字一色同是 6 番，取到 64 倍就够（不重复叠加）",
    g12.ok && g12.rawFan === 6 && g12.mult === 64, JSON.stringify(g12));
const g13 = gd("东东东南南南西西西北北555m");
check("小四喜：三副风刻 + 风做将，5 番（掺一门数牌才不会被字一色盖过去）",
    g13.ok && gname(g13) === "小四喜" && g13.mult === 32, JSON.stringify(g13));
const g14 = gd("111m999m东东东中中中99p");
check("混幺九：幺九加字牌凑的刻，5 番", g14.ok && gname(g14) === "混幺九" && g14.mult === 32,
    JSON.stringify(g14));
const g15 = gd("19m19p19s東南西北中發白中", { selfDrawn: true });
check("十三幺认在拆型之前，6 番不叠自摸", g15.ok && g15.kind === "kokushi" && g15.mult === 64,
    JSON.stringify(g15));
const g16 = gd("1112345678999m1m");
check("九莲宝灯 6 番；普通清一色不会被误认成九莲",
    g16.ok && gname(g16) === "九莲宝灯" && g16.mult === 64 &&
    G.isJiuLian(countsOf("111m222m333m444m55m")) === false, JSON.stringify(g16));
const g17 = G.scoreWin({ concealedIds: idsOf("456m123p456p55m"), melds: [{ type: "chi", tiles: [0, 1, 2] }],
    selfDrawn: false, winSeat: 0, discarderSeat: 3, base: 2 });
check("广东能吃：吃出来的顺子照样算进平胡", g17.ok && gname(g17).indexOf("平胡") >= 0 &&
    g17.basePoints === 4, JSON.stringify(g17));
const g18 = gd("12m45m78p123p456p55m");
check("牌型不成立时给的是拒和理由，不会拿鸡胡蒙混",
    !g18.ok && /牌型不成立/.test(g18.reason), JSON.stringify(g18));
check("一炮多响：放炮者对每一家都付全额", (() => {
    const r = G.splitMultiRon([8, 16], 2);
    return r.length === 2 && r.every((x) => x.seat === 2) && r[0].amount === 8 && r[1].amount === 16;
})(), "一炮多响");
check("fanCap:4 就是辣子口径：那手混一色箭刻自摸能真给到 4 番",
    gd("123m456m789m中中中白白", { selfDrawn: true, fanCap: 4 }).fan === 4, "辣子");

console.log(failed ? "\n麻将（地基+日麻+血战+广东）失败 " + failed + " 条" : "\n麻将（地基+日麻+血战+广东）全部通过");
process.exit(failed ? 1 : 0);
