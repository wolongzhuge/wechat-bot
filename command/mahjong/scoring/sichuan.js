"use strict";
// 血战到底（四川）计分。这跟日麻是两套口径，别互相抄：
//  - 牌只有万筒条 108 张，没有字牌；开局必须定缺，和牌时手里不能还留着缺门那门牌。
//  - 不能吃：副露只有碰和杠，顺子只能自己摸出来。
//  - 不算番符，算「番数相加」：n 番就是 2^n 倍，超过封顶按封顶裁。
//  - 杠的钱（刮风下雨）在杠成那一刻单独结清，不并进和牌的分——这是四川规则最容易
//    跟别处搞混的一条，很多群里吵的就是这个。
//  - 自摸是三家各付全额，点炮是放炮者一家付全额；一炮多响时放炮者对每家都付全额
//    （不拆分），所以血战里点炮比日麻贵得多。
//  - 一家和了牌局继续，直到三家和或摸完；摸完还要查花猪、查叫。
//
// 口径备注（要改规则就改这里）：
//  - 不做「清对 / 清七对」这类复合专项番，一律拆成清一色 + 对对胡相加。
//    各地对复合番给的番数不一样，拆着算至少每一笔都能跟人对上账。
//  - 门清不含七对（七对自带 2 番，再叠门清等于凭空多 1 番）。
//  - 默认 3 番封顶（8 倍），可由 ctx.fanCap 改；传 0 或 false 表示不封顶。

const T = require("../tiles");
const H = require("../hand");

const QUE_SUITS = ["m", "p", "s"];
const SUIT_BASE = { m: 0, p: 9, s: 18 };
const DEFAULT_FAN_CAP = 3;
const DEFAULT_BASE = 1;

function countSuit(counts, suit) {
    const base = SUIT_BASE[suit];
    if (base === undefined) return 0;
    let n = 0;
    for (let i = base; i < base + 9; i++) n += counts[i] || 0;
    return n;
}

// 缺门清空了没有。定缺之后必须先把那一门打光才允许和牌，
// 手里还攥着缺门牌就是「花猪」，和不了，流局还要重罚。
function queCleared(counts, queSuit) {
    return countSuit(counts, queSuit) === 0;
}

// 七对。日麻那边不认「四张当两对」，血战认——而且专门给它一个龙七对，
// 所以这里不能复用 H.isChiitoiCounts（它要求正好 7 种各 2 张）。
function chiitoiOf(counts) {
    let pairs = 0, kinds = 0, longPairs = 0;
    for (let i = 0; i < 34; i++) {
        if (!counts[i]) continue;
        if (counts[i] % 2 !== 0) return null;
        kinds++;
        pairs += counts[i] / 2;
        if (counts[i] >= 4) longPairs++;
    }
    return pairs === 7 ? { longPairs, kinds } : null;
}

function shapeOf(decomp, melds) {
    const mentsu = [];
    for (const m of (decomp ? decomp.mentsu : []) || []) {
        mentsu.push({ type: m.type, tile: m.tile, open: false, concealed: false });
    }
    for (const m of melds || []) {
        const ids = m.tiles.map((t) => (typeof t === "number" ? t : t.id));
        if (m.type === "pon") mentsu.push({ type: H.MENTSU_KOTSU, tile: ids[0], open: true, concealed: false });
        else mentsu.push({ type: H.MENTSU_KANTU, tile: ids[0], open: !m.concealed, concealed: !!m.concealed });
    }

    const allIds = mentsu.flatMap((m) => mentsuIds(m));
    const suits = new Set();
    let shuntsu = 0, kotsu = 0, kantsu = 0, anko = 0;
    for (const id of allIds) suits.add(T.suitOf(id));
    for (const m of mentsu) {
        if (m.type === H.MENTSU_SHUNTSU) shuntsu++;
        if (m.type === H.MENTSU_KOTSU) kotsu++;
        if (m.type === H.MENTSU_KANTU) { kantsu++; kotsu++; }
        if (m.type === H.MENTSU_KANTU) { if (m.concealed) anko++; }
        else if (m.type === H.MENTSU_KOTSU && !m.open) anko++;
    }
    return {
        mentsu, allIds, pair: decomp ? decomp.pair : null,
        numSuits: suits.size, shuntsu, kotsu, kantsu, anko,
        openMelds: (melds || []).filter((m) => m.type !== "kan" || !m.concealed).length,
        meldCount: (melds || []).length,
        menzen: (melds || []).every((m) => m.type === "kan" && m.concealed),
    };
}

function mentsuIds(m) {
    if (m.type === H.MENTSU_SHUNTSU) return [m.tile, m.tile + 1, m.tile + 2];
    if (m.type === H.MENTSU_KANTU) return [m.tile, m.tile, m.tile, m.tile];
    if (m.type === H.MENTSU_KOTSU) return [m.tile, m.tile, m.tile];
    if (m.type === "pair") return [m.tile, m.tile];
    return [];
}

// ---------- 番型表 ----------
// fan 是番数（n 番 = 2^n 倍）。supersedes 里的番型被本条命中时不再重复计。
const FANS = [
    { key: "duidui", name: "对对胡", fan: 1, test: (s) => !s.chiitoi && s.shuntsu === 0 },
    { key: "qing", name: "清一色", fan: 2, test: (s) => s.numSuits === 1 },
    { key: "menzen", name: "门清", fan: 1, test: (s) => s.menzen && !s.chiitoi },
    { key: "qidui", name: "七对", fan: 2, test: (s) => s.chiitoi && !s.longPairs },
    { key: "longqidui", name: "龙七对", fan: 4, test: (s) => s.chiitoi && s.longPairs >= 1,
      supersedes: ["qidui"] },
    // 四组副露、门前只剩一对将的单钓。金钩钓必然是对对胡形，两个都算。
    { key: "jingoudiao", name: "金钩钓", fan: 2, test: (s) => s.meldCount === 4 && s.shuntsu === 0 },
    { key: "quanqiu", name: "全求人", fan: 1, test: (s, c) => s.meldCount === 4 && !c.selfDrawn,
      requires: ["jingoudiao"] },
    { key: "luohan", name: "十八罗汉", fan: 4, test: (s) => s.kantsu === 4 },
    { key: "haidi", name: "海底捞月", fan: 1, test: (s, c) => c.wallEmpty && c.selfDrawn },
    { key: "hedi", name: "河底捞鱼", fan: 1, test: (s, c) => c.wallEmpty && !c.selfDrawn },
    { key: "gangshang", name: "杠上开花", fan: 1, test: (s, c) => c.afterGangDraw && c.selfDrawn },
    { key: "gangshangpao", name: "杠上炮", fan: 1, test: (s, c) => c.gangPlayerSeat === c.discarderSeat && !c.selfDrawn },
    { key: "qianggang", name: "抢杠和", fan: 1, test: (s, c) => !!c.robbedKang },
    { key: "tianhu", name: "天胡", fan: 4, test: (s, c) => !!c.tianhu, supersedes: ["dihu"] },
    { key: "dihu", name: "地胡", fan: 2, test: (s, c) => !!c.dihu },
];

function evaluate(shape, ctx) {
    const hits = [];
    for (const f of FANS) {
        if (!f.test(shape, ctx)) continue;
        if (f.requires && !f.requires.every((need) => hits.some((h) => h.key === need))) continue;
        hits.push(f);
    }
    const keys = new Set(hits.map((f) => f.key));
    const dropped = new Set();
    for (const f of hits) (f.supersedes || []).forEach((k) => { if (keys.has(k)) dropped.add(k); });
    const kept = hits.filter((f) => !dropped.has(f.key));
    return kept.map((f) => ({ key: f.key, name: f.name, fan: f.fan }));
}

function multOf(fan, cap) {
    const limit = cap === undefined ? DEFAULT_FAN_CAP : cap;
    const used = (limit || limit === 0) && limit !== false ? Math.min(fan, limit) : fan;
    return { fan: used, rawFan: fan, capped: used < fan, mult: Math.pow(2, used) };
}

// ---------- 和牌结算 ----------
// ctx: { concealedIds|concealed, concealedTiles, melds, winTile, queSuit, selfDrawn,
//        winSeat, discarderSeat, base, fanCap, wallEmpty, afterGangDraw, gangPlayerSeat,
//        robbedKang, tianhu, dihu }
function scoreWin(ctx) {
    const ids = ctx.concealedIds || ctx.concealed || [];
    const melds = ctx.melds || [];
    const chi = melds.find((m) => m.type === "chi");
    if (chi) return { ok: false, reason: "血战到底不能吃，手上这组顺子只能是自摸凑的" };

    if (!ctx.queSuit) return { ok: false, reason: "还没定缺，不能和牌（先 cc缺万 / cc缺筒 / cc缺条）" };
    const counts = T.countsOf(ids);
    if (!queCleared(counts, ctx.queSuit)) {
        return { ok: false, reason: "缺门" + T.SUIT_CHAR[ctx.queSuit] + "还剩 " + countSuit(counts, ctx.queSuit) +
            " 张，花猪和不了牌" };
    }

    const expect = 14 - 3 * melds.length;
    if (ids.length !== expect) {
        return { ok: false, reason: "门前牌 " + ids.length + " 张，应该 " + expect + " 张（副露 " + melds.length + " 组）" };
    }

    const base = ctx.base || DEFAULT_BASE;
    const candidates = [];
    const seven = melds.length === 0 ? chiitoiOf(counts) : null;
    if (seven) {
        candidates.push({ kind: "chiitoi", shape: {
            mentsu: [], allIds: ids.slice(), numSuits: new Set(ids.map((id) => T.suitOf(id))).size,
            shuntsu: 0, kotsu: 0, kantsu: 0, anko: 0, openMelds: 0, meldCount: 0,
            menzen: true, chiitoi: true, longPairs: seven.longPairs, pair: null,
        } });
    }
    for (const decomp of H.allDecompositions(counts)) {
        candidates.push({ kind: "standard", shape: shapeOf(decomp, melds) });
    }
    if (!candidates.length) return { ok: false, reason: "牌型不成立：要 4 面子 + 1 将，或七对" };

    let best = null;
    for (const cand of candidates) {
        const fans = evaluate(cand.shape, ctx);
        const raw = fans.reduce((a, f) => a + f.fan, 0);
        const m = multOf(raw, ctx.fanCap);
        const cand2 = { cand, fans, raw, mult: m.mult, basePoints: base * m.mult };
        // 封顶之后常见「两种拆法付一样的钱」：这时报番要报番数多的那一拆，
        // 不然 1112223334445 5 这种对对胡会被显示成三组顺子，群里一定吵。
        if (!best || cand2.basePoints > best.basePoints ||
            (cand2.basePoints === best.basePoints && cand2.raw > best.raw)) best = cand2;
    }

    const m = multOf(best.raw, ctx.fanCap);
    const per = base * m.mult;
    const otherSeats = [0, 1, 2, 3].filter((s) => s !== ctx.winSeat);
    let payments;
    if (ctx.selfDrawn) {
        payments = otherSeats.map((seat) => ({ seat, amount: per, why: "自摸" }));
    } else {
        const payer = ctx.discarderSeat == null ? otherSeats[0] : ctx.discarderSeat;
        // 抢杠和算被抢的那家独付，跟点炮同一套走
        payments = [{ seat: payer, amount: per, why: ctx.robbedKang ? "抢杠" : "点炮" }];
    }

    return {
        ok: true,
        rule: "sichuan",
        kind: best.cand.kind,
        fans: best.fans,
        fan: m.fan,
        rawFan: m.rawFan,
        capped: m.capped,
        mult: m.mult,
        base: base,
        basePoints: per,
        payments: payments,
        total: payments.reduce((a, p) => a + p.amount, 0),
    };
}

// 一炮多响：血战里放炮者对每一家和都付全额，不像日麻那样把一份分数拆给几家。
function splitMultiRon(perWinnerPayment, discarderSeat) {
    return perWinnerPayment.map((amount, i) => ({ seat: discarderSeat, amount: amount, winnerIndex: i }));
}

// ---------- 刮风下雨（杠的即时分） ----------
// kind: anzeng(暗杠) | diagan(直摸明杠：碰的那家自己摸到第4张=补杠) | bugang(补杠) | diangang(点杠)
// 成都口径：暗杠 2 倍、补杠 1 倍、点杠由放杠者一家付 2 倍。
// 抢杠不成杠，即时分不结（钱由抢杠那家的和牌结算负责）。
// 钱的流向统一成一条规则：payments[].seat 永远是「付款人」，杠家用 to 字段收钱，
// 跟 scoreWin 的 payments 同一个口径，记账层不用分支。
function gangSettle(opts) {
    const kind = opts.kind;
    const base = opts.base || DEFAULT_BASE;
    const others = (opts.otherSeats || []).filter((s) => s !== opts.seat);
    if (kind === "anzeng") {
        return { name: "暗杠（下雨）", to: opts.seat, payments: others.map((seat) => ({ seat, amount: base * 2 })) };
    }
    if (kind === "bugang") {
        return { name: "补杠（巴杠）", to: opts.seat, payments: others.map((seat) => ({ seat, amount: base })) };
    }
    if (kind === "diangang") {
        return { name: "点杠", to: opts.seat, payments: [{ seat: opts.discarderSeat, amount: base * 2 }] };
    }
    return { name: "不成杠", to: opts.seat, payments: [] };
}

// ---------- 流局：查花猪 / 查叫 ----------
// players: [{ seat, queLeft, ting, maxFan }]
// 花猪（缺门还有牌）最重，按封顶赔给每一家；没花猪但没听牌的，按听牌家的番赔。
// payments 同样 seat=付款人、to=收款人。
function liujuSettle(opts) {
    const base = opts.base || DEFAULT_BASE;
    const cap = opts.fanCap === undefined ? DEFAULT_FAN_CAP : opts.fanCap;
    const list = opts.players || [];
    const out = [];
    const pigs = list.filter((p) => p.queLeft > 0);
    const tinged = list.filter((p) => p.queLeft === 0 && p.ting);

    for (const pig of pigs) {
        for (const other of list.filter((p) => p.seat !== pig.seat)) {
            const fan = Math.max(other.maxFan || 0, cap || 0);
            out.push({ seat: pig.seat, to: other.seat, amount: base * Math.pow(2, fan), why: "查花猪" });
        }
    }
    for (const loser of list.filter((p) => p.queLeft === 0 && !p.ting)) {
        for (const winner of tinged.filter((w) => w.seat !== loser.seat)) {
            const fan = Math.min(winner.maxFan || 0, cap === false ? Infinity : cap);
            out.push({ seat: loser.seat, to: winner.seat, amount: base * Math.pow(2, fan), why: "查叫" });
        }
    }
    return out;
}

module.exports = {
    QUE_SUITS, DEFAULT_FAN_CAP, DEFAULT_BASE,
    countSuit, queCleared, chiitoiOf, shapeOf, mentsuIds, FANS, evaluate, multOf,
    scoreWin, splitMultiRon, gangSettle, liujuSettle,
};
