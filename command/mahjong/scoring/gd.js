"use strict";
// 广东鸡平胡计分。跟日麻、血战又是第三套口径：
//  - 136 张牌（万筒条 + 东南西北中发白），没有花牌；能吃、能碰、能杠，碰比吃优先。
//  - 「番」在这里就是 2 倍：n 番 = 2^n 倍，跟血战一样是倍法，但番型表完全不同。
//  - 爆胡（封顶）是广东打法的招牌：爆胡内的牌型只能叠到封顶，超出不加。
//    默认 3 番封顶，可由 ctx.fanCap 改；珠三角不少地方打「四翻/辣子」，那就是 fanCap:4。
//  - 牌型分两档：爆胡内（鸡胡/平胡/碰碰胡/混一色）可以再加自摸、门风、圈风、箭刻；
//    爆胡外（清一色、大三元、十三幺这些特殊牌型）是独占的——不封顶、也不再叠附加番。
//    把这两档混在一起加，就会算出「十三幺加自摸加门风」这种没人认的天文数字。
//  - 一炮多响允许，放炮者对每一家都付全额。
//
// 口径备注：各地对具体番数出入很大（混碰有记 4 番也有记 5 番，七对有记 2 番也有记 5 番）。
// 这里取珠三角普及表，要按本群的约定改，只改 FANS / SPECIALS 的 fan 字段，别在调用处绕。

const T = require("../tiles");
const H = require("../hand");

const DEFAULT_FAN_CAP = 3;
const DEFAULT_BASE = 1;

function analyze(decomp, melds) {
    const mentsu = [];
    for (const m of (decomp ? decomp.mentsu : []) || []) {
        mentsu.push({ type: m.type, tile: m.tile, open: false, concealed: false });
    }
    for (const m of melds || []) {
        const ids = m.tiles.map((t) => (typeof t === "number" ? t : t.id));
        if (m.type === "chi") mentsu.push({ type: H.MENTSU_SHUNTSU, tile: Math.min(...ids), open: true, concealed: false });
        else if (m.type === "pon") mentsu.push({ type: H.MENTSU_KOTSU, tile: ids[0], open: true, concealed: false });
        else mentsu.push({ type: H.MENTSU_KANTU, tile: ids[0], open: !m.concealed, concealed: !!m.concealed });
    }

    let shuntsu = 0, kotsu = 0, kantsu = 0;
    const allIds = [];
    for (const m of mentsu) {
        const ids = mentsuIds(m);
        ids.forEach((id) => allIds.push(id));
        if (m.type === H.MENTSU_SHUNTSU) shuntsu++;
        if (m.type === H.MENTSU_KOTSU) kotsu++;
        if (m.type === H.MENTSU_KANTU) { kantsu++; kotsu++; }
    }
    const pair = decomp ? decomp.pair : null;
    // 幺九类的牌型要连将牌一起看，只看面子会把「111m999m111p999p 55s」放过去
    if (pair != null) allIds.push(pair);
    const suits = new Set(allIds.filter((id) => !T.isHonor(id)).map((id) => T.suitOf(id)));
    return {
        mentsu, allIds, pair,
        numSuits: suits.size, hasHonor: allIds.some((id) => T.isHonor(id)),
        allHonor: allIds.length > 0 && allIds.every((id) => T.isHonor(id)),
        shuntsu, kotsu, kantsu,
        dragonKotsu: mentsu.filter((m) => m.type !== H.MENTSU_SHUNTSU && T.isDragon(m.tile)).length,
        windKotsu: mentsu.filter((m) => m.type !== H.MENTSU_SHUNTSU && T.isWind(m.tile)).length,
        menzen: (melds || []).every((m) => m.type === "kan" && m.concealed),
        meldCount: (melds || []).length,
    };
}

function mentsuIds(m) {
    if (m.type === H.MENTSU_SHUNTSU) return [m.tile, m.tile + 1, m.tile + 2];
    if (m.type === H.MENTSU_KANTU) return [m.tile, m.tile, m.tile, m.tile];
    if (m.type === H.MENTSU_KOTSU) return [m.tile, m.tile, m.tile];
    if (m.type === "pair") return [m.tile, m.tile];
    return [];
}

// 门风 / 圈风刻：只有真刻子或杠才算，对子不算
function kotsuOf(s, id) {
    return s.mentsu.some((m) => m.type !== H.MENTSU_SHUNTSU && m.tile === id);
}

function isJiuLian(counts) {
    for (const base of [0, 9, 18]) {
        let ok = counts[base] >= 3 && counts[base + 8] >= 3;
        for (let i = 1; i < 8 && ok; i++) ok = counts[base + i] >= 1;
        if (!ok) continue;
        // 去掉 1112345678999 这 14 张骨架，剩下的必须还是这一门（多出来那张就是要胡的牌）
        let left = 0, same = true;
        for (let i = base; i < base + 9; i++) left += counts[i];
        for (let i = 0; i < 34; i++) if (counts[i] && (i < base || i >= base + 9)) same = false;
        if (same && left === 14) return true;
    }
    return false;
}

// ---------- 爆胡内的牌型（可叠加附加番） ----------
const FANS = [
    { key: "pinghu", name: "平胡", fan: 1, test: (s) => s.shuntsu === 4 },
    { key: "pengpeng", name: "碰碰胡", fan: 2, test: (s) => s.shuntsu === 0 },
    { key: "hunyse", name: "混一色", fan: 2, test: (s) => s.numSuits === 1 && s.hasHonor },
    // 附加番只在没爆胡时才有意义，超了就是白给，所以统一收在这里由 evaluate 裁
    { key: "zimo", name: "自摸", fan: 1, test: (s, c) => !!c.selfDrawn },
    { key: "menfeng", name: "门风刻", fan: 1, test: (s, c) => c.seatWind != null && kotsuOf(s, c.seatWind) },
    { key: "quanfeng", name: "圈风刻", fan: 1, test: (s, c) => c.roundWind != null && kotsuOf(s, c.roundWind) },
    { key: "sanyuan", name: "箭刻", fan: 1, each: true, test: (s) => s.dragonKotsu > 0,
      count: (s) => s.dragonKotsu },
];

// ---------- 爆胡外的特殊牌型（独占：不封顶、不叠附加） ----------
const SPECIALS = [
    { key: "qingpeng", name: "清碰", fan: 5, test: (s) => s.numSuits === 1 && !s.hasHonor && s.shuntsu === 0 },
    { key: "hunyaohao", name: "混幺九", fan: 5, test: (s) => s.allIds.every((id) => T.isYoung(id)) && s.hasHonor },
    { key: "xiaosanyuan", name: "小三元", fan: 5, test: (s) => s.dragonKotsu === 2 && s.pair != null && T.isDragon(s.pair) },
    { key: "xiaosixi", name: "小四喜", fan: 5, test: (s) => s.windKotsu === 3 && s.pair != null && T.isWind(s.pair) },
    { key: "hunpeng", name: "混碰", fan: 4, test: (s) => s.numSuits === 1 && s.hasHonor && s.shuntsu === 0 },
    { key: "qingyise", name: "清一色", fan: 4, test: (s) => s.numSuits === 1 && !s.hasHonor },
    { key: "ziyise", name: "字一色", fan: 6, test: (s) => s.allIds.every((id) => T.isHonor(id)) },
    { key: "qingyaohao", name: "清幺九", fan: 6, test: (s) => s.allIds.every((id) => T.isTerminal(id)) },
    { key: "dasanyuan", name: "大三元", fan: 6, test: (s) => s.dragonKotsu === 3 },
    { key: "dasixi", name: "大四喜", fan: 6, test: (s) => s.windKotsu === 4 },
];

function evaluateCapped(shape, ctx) {
    const hits = [];
    for (const f of FANS) {
        if (!f.test(shape, ctx)) continue;
        if (f.each) {
            const n = f.count(shape);
            for (let i = 0; i < n; i++) hits.push({ key: f.key, name: n > 1 ? f.name + "×" + (i + 1) : f.name, fan: f.fan });
        } else hits.push({ key: f.key, name: f.name, fan: f.fan });
    }
    return hits;
}

function multOf(fan, cap) {
    const limit = cap === undefined ? DEFAULT_FAN_CAP : cap;
    const uncapped = limit === false || limit === null;
    const used = uncapped ? fan : Math.min(fan, limit);
    return { fan: used, rawFan: fan, capped: used < fan, mult: Math.pow(2, used) };
}

function settle(ctx, base, fans, raw, kind, uncapped) {
    const m = uncapped ? { fan: raw, rawFan: raw, capped: false, mult: Math.pow(2, raw) }
        : multOf(raw, ctx.fanCap);
    const per = base * m.mult;
    const seats = [0, 1, 2, 3].filter((se) => se !== ctx.winSeat);
    const payments = ctx.selfDrawn
        ? seats.map((seat) => ({ seat, amount: per, why: "自摸" }))
        : [{ seat: ctx.discarderSeat == null ? seats[0] : ctx.discarderSeat, amount: per, why: "食糊" }];
    return {
        ok: true, rule: "gd", kind,
        fans: fans.map((f) => ({ name: f.name, fan: f.fan })),
        fan: m.fan, rawFan: m.rawFan, capped: m.capped, mult: m.mult,
        base: base, basePoints: per, payments: payments,
        total: payments.reduce((a, p2) => a + p2.amount, 0),
    };
}

// ctx: { concealedIds|concealed, melds, winTile, selfDrawn, winSeat, discarderSeat,
//        seatWind, roundWind, base, fanCap }
function scoreWin(ctx) {
    const ids = ctx.concealedIds || ctx.concealed || [];
    const melds = ctx.melds || [];
    const counts = T.countsOf(ids);
    const base = ctx.base || DEFAULT_BASE;

    // 十三幺和九莲宝灯根本拆不出「4 面子 + 1 将」，只能在拆型之前先认
    const kokushi = melds.length === 0 && H.isKokushiCounts(counts);
    if (kokushi) return settle(ctx, base, [{ name: "十三幺", fan: 6 }], 6, "kokushi", true);
    const jiuLian = melds.length === 0 && isJiuLian(counts);
    if (jiuLian) return settle(ctx, base, [{ name: "九莲宝灯", fan: 6 }], 6, "jiulian", true);

    const expect = 14 - 3 * melds.length;
    if (ids.length !== expect) {
        return { ok: false, reason: "门前牌 " + ids.length + " 张，应该 " + expect + " 张（副露 " + melds.length + " 组）" };
    }

    const decomps = H.allDecompositions(counts);
    const chiitoi = melds.length === 0 && H.isChiitoiCounts(counts);
    if (!decomps.length && !chiitoi) {
        return { ok: false, reason: "牌型不成立：要 4 面子 + 1 将，或七对 / 十三幺" };
    }

    // 鸡胡兜底：牌型成立但一个番型都没摊上也能胡，就是 1 倍底。
    // 七对既是牌型也可能是字一色，所以跟拆型一起参与取优，不提前返回。
    let best = { special: false, fans: [{ key: "jihu", name: "鸡胡", fan: 0 }], raw: 0, money: base };
    if (chiitoi) {
        const honor = ids.every((id) => T.isHonor(id));
        best = honor
            ? { special: true, fans: [{ key: "ziyise", name: "字一色", fan: 6 }], raw: 6, money: base * 64 }
            : { special: true, fans: [{ key: "qidui", name: "七对", fan: 5 }], raw: 5, money: base * 32 };
    }

    for (const decomp of decomps) {
        const shape = analyze(decomp, melds);
        const spec = SPECIALS.filter((f) => f.test(shape, ctx)).sort((a, b) => b.fan - a.fan)[0];
        // 特殊牌型独占：按它自己的番，附加番一概不加，也不受爆胡限制
        const cand = spec
            ? { special: true, fans: [{ key: spec.key, name: spec.name, fan: spec.fan }], raw: spec.fan,
                money: base * Math.pow(2, spec.fan) }
            : (function () {
                const fans = evaluateCapped(shape, ctx);
                const raw = fans.reduce((a, f) => a + f.fan, 0);
                return { special: false, fans: fans, raw: raw, money: base * multOf(raw, ctx.fanCap).mult };
            })();
        if (cand.money > best.money) best = cand;
    }
    return settle(ctx, base, best.fans, best.raw, best.special ? "special" : "standard", best.special);
}

// 一炮多响：广东允许，且放炮者对每一家都付全额（跟血战同，跟日麻的拆付不同）
function splitMultiRon(amounts, discarderSeat) {
    return amounts.map((amount, i) => ({ seat: discarderSeat, amount: amount, winnerIndex: i }));
}

module.exports = {
    DEFAULT_FAN_CAP, DEFAULT_BASE,
    analyze, mentsuIds, kotsuOf, isJiuLian,
    FANS, SPECIALS, evaluateCapped, multOf,
    scoreWin, splitMultiRon,
};
