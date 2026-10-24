"use strict";
// 麻将模式注册表：三套规则的差异全压在这里声明，状态机只读标志位 + 调统一适配器，
// 不写 if (mode === "血战")。加一套新规则 = 在这儿加一条 MODES。
//
// 三个计分模块的返回口径本来不一致（日麻 payments 用 {from,to}，血战/广东用 {seat,amount}，
// seat 是「付款人」），所以这一层统一转成 transfers[{from,to,amount,why}]，
// 记账只认这一种形状，钱才不会记反。

const T = require("./tiles");
const R = require("./scoring/riichi");
const S = require("./scoring/sichuan");
const G = require("./scoring/gd");

const SEATS = 4;

// 付款人字段名不同的那一步，集中在这里处理
function normPayments(res, winnerSeat) {
    return (res.payments || []).map((p) => ({
        from: p.from != null ? p.from : p.seat,
        to: p.to != null ? p.to : winnerSeat,
        amount: p.amount,
        why: p.why || "",
    }));
}

// 日麻的流局结算返回 {transfers,...}，血战返回裸数组且用 seat/to —— 都转成同一种
function riichiDraw(ctx) {
    const res = R.buppaiPayments(ctx.tenpaiSeats, ctx.dealerSeat);
    return (res && res.transfers) || [];
}
function sichuanDraw(ctx) {
    return S.liujuSettle(ctx).map((p) => ({ from: p.seat, to: p.to, amount: p.amount, why: p.why }));
}

const MODES = {
    riichi: {
        id: "riichi",
        name: "日麻",
        aliases: ["日麻", "日本麻将", "立直麻将", "riichi", "日本麻将"],
        wall: { honors: true, reds: 3 },
        deadWall: 14,          // 牌尾 14 张不摸，宝牌指示牌从这里翻
        chi: true,
        riichi: true,
        que: false,
        multiRon: false,       // 三家同时荣和 = 流局
        furiten: true,
        unit: "点",
        score: (ctx) => {
            const res = R.scoreWin(ctx);
            return res.ok ? Object.assign({}, res, {
                transfers: normPayments(res, ctx.winSeat),
                label: res.yakuman ? res.level + " " + res.total + " 点" : res.han + " 番 " + res.fu + " 符 = " + res.total + " 点",
            }) : res;
        },
        drawSettle: riichiDraw,
        drawName: "流局罚符",
        abortive: (checks) => R.abortiveDraw(checks),
        gangSettle: null,      // 日麻杠没有即时分，杠只翻宝牌
        terms: { win: "和了", self: "自摸", caller: "荣和", discard: "打", seat: "家" },
    },
    sichuan: {
        id: "sichuan",
        name: "血战",
        aliases: ["血战", "血战到底", "四川", "川麻", "sichuan"],
        wall: { honors: false, reds: 0 },
        deadWall: 0,
        chi: false,            // 血战不能吃
        riichi: false,
        que: true,             // 起手定缺，缺门必须打光
        base: 1, fanCap: 3,    // 1 底 = 1 分，3 番封顶（8 倍）；群里要改底分数就改这里
        multiRon: true,        // 一炮多响，放炮者对每家全额付
        furiten: false,
        unit: "分",
        score: (ctx) => {
            const res = S.scoreWin(ctx);
            return res.ok ? Object.assign({}, res, {
                transfers: normPayments(res, ctx.winSeat),
                label: res.fan + " 番 = " + res.mult + " 倍，共 " + res.total + " 分" + (res.capped ? "（封顶）" : ""),
            }) : res;
        },
        drawSettle: sichuanDraw,
        drawName: "查花猪 / 查叫",
        gangSettle: (opts) => {
            const res = S.gangSettle(opts);
            return { name: res.name, transfers: normPayments(res, res.to) };
        },
        terms: { win: "胡", self: "自摸", caller: "点炮", discard: "打", seat: "家" },
    },
    gd: {
        id: "gd",
        name: "广东",
        aliases: ["广东", "鸡平胡", "广东麻将", "gd"],
        wall: { honors: true, reds: 0 },
        deadWall: 0,
        chi: true,
        riichi: false,
        que: false,
        base: 1, fanCap: 3,    // 爆胡：3 番封顶
        multiRon: true,
        furiten: false,
        unit: "分",
        score: (ctx) => {
            const res = G.scoreWin(ctx);
            return res.ok ? Object.assign({}, res, {
                transfers: normPayments(res, ctx.winSeat),
                label: (res.fans || []).map((f) => f.name).join("+") + " = " + res.mult + " 倍，共 " + res.total + " 分",
            }) : res;
        },
        drawSettle: () => [],  // 荒牌不算分，推倒重来
        drawName: "荒牌",
        gangSettle: null,
        terms: { win: "食糊", self: "自摸", caller: "出糊", discard: "打", seat: "家" },
    },
};

const ORDER = ["riichi", "sichuan", "gd"];
const DEFAULT_MODE = "riichi";

function get(id) {
    return MODES[id] || MODES[DEFAULT_MODE];
}

// 「日麻」「打日麻」「#麻将 血战到底」都能命中；认不出来返回 null 让上层列可选
function byName(text) {
    const s = String(text == null ? "" : text).replace(/\s+/g, "");
    if (!s) return null;
    for (const id of ORDER) {
        if (MODES[id].aliases.some((a) => s === a || s.includes(a) || a.includes(s))) return MODES[id];
    }
    return null;
}

function list() {
    return ORDER.map((id) => MODES[id]);
}

// 起手牌墙：模式决定字牌/赤牌/花牌，rng 可注入方便测试复现
function buildWall(mode, rng) {
    return T.shuffle(T.makeWall(mode.wall), rng);
}

// 牌尾让位给 dead wall（日麻翻宝牌用），返回还能摸的张数
function liveWallLength(mode, wall) {
    return Math.max(0, wall.length - (mode.deadWall || 0));
}

module.exports = {
    SEATS, MODES, ORDER, DEFAULT_MODE, get, byName, list, buildWall, liveWallLength, normPayments,
    R, S, G,
};
