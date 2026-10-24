"use strict";
// 日麻计分：役表 + 符数 + 番符结算 + 流局/罚符。
// 计分口径全部写死在这一层：牌局状态机只负责「谁和了、怎么和的」，算多少点找这里。
//
// 口径备注（改规则就改这里，别在调用处绕）：
//  - 役满：大三元/小四喜/字一色/绿一色/清老头/九莲宝灯/四暗刻/四杠子/国士无双/天和/地和；
//    四暗刻单骑、国士十三幺（13 种待牌）、纯正九莲按二倍役满。
//  - 二立直按 2 番（天凤口径，与立直不重复计）。二杯口 2 番且不再计一杯口。
//  - 七对子不逐张算符，按 50 符结算。
//  - 30 符 1 番不存在，按 40 符 1 番结算。
//  - 宝牌/里宝/赤不是役：只加番，不能让无役的手牌和牌。

const T = require("../tiles");
const H = require("../hand");

const YAKUMAN = "yakuman";
const DORA_KEYS = new Set(["dora", "ura", "red"]);

const WIND_ID = (idx) => 27 + (idx % 4);
const ceil100 = (n) => Math.ceil(n / 100) * 100;

// ---------- 宝牌 ----------

// 指示牌 -> 宝牌本身：数牌同花色 9 回 1，风牌东南西北循环，三元中发白循环
function doraOf(indicator) {
    if (indicator == null) return null;
    if (T.isNum(indicator)) {
        const base = Math.floor(indicator / 9) * 9;
        return base + ((indicator % 9 + 1) % 9);
    }
    if (T.isWind(indicator)) return 27 + ((indicator - 27 + 1) % 4);
    return 31 + ((indicator - 31 + 1) % 3);
}

function doraTiles(indicators) {
    return new Set((indicators || []).map(doraOf).filter((x) => x != null));
}

function countDora(ids, indicators) {
    const doras = doraTiles(indicators);
    return ids.filter((id) => doras.has(id)).length;
}

function countRedFives(tiles) {
    return (tiles || []).filter((t) => t && typeof t === "object" && t.red).length;
}

// ---------- 拆法特征 ----------

const GREEN_TILES = new Set([19, 20, 21, 22, 23, 25, 32]); // 绿一色：二三四五六八条 + 發

function mentsuIds(m) {
    if (m.type === H.MENTSU_SHUNTSU) return [m.tile, m.tile + 1, m.tile + 2];
    if (m.type === "pair") return [m.tile, m.tile];
    const n = m.type === H.MENTSU_KANTU ? 4 : 3;
    return new Array(n).fill(m.tile);
}

// 把「雀头 + 门前面子 + 副露」摊平成役判定需要的特征。
// counts/shape 只吃牌 id，赤宝牌用 ctx.redIds 单独加番。
function shapeOf(decomp, melds, ctx) {
    const mentsu = [];
    for (const m of (decomp ? decomp.mentsu : []) || []) {
        mentsu.push({ type: m.type, tile: m.tile, open: false, concealed: true });
    }
    for (const m of melds || []) {
        const ids = m.tiles.map((t) => (typeof t === "number" ? t : t.id));
        if (m.type === "chi") mentsu.push({ type: H.MENTSU_SHUNTSU, tile: Math.min(...ids), open: true, concealed: false });
        else if (m.type === "pon") mentsu.push({ type: H.MENTSU_KOTSU, tile: ids[0], open: true, concealed: false });
        else mentsu.push({ type: H.MENTSU_KANTU, tile: ids[0], open: !m.concealed, concealed: !!m.concealed });
    }
    const blocks = mentsu.slice();
    if (decomp) blocks.push({ type: "pair", tile: decomp.pair });

    const allIds = blocks.flatMap(mentsuIds);
    const suits = new Set();
    let honors = 0, young = 0, terminals = 0, kotsu = 0, shuntsu = 0, kantsu = 0, anko = 0, openMentsu = 0;
    for (const id of allIds) {
        if (T.isHonor(id)) { honors++; suits.add("z"); } else suits.add(T.suitOf(id));
        if (T.isYoung(id)) young++;
        if (T.isTerminal(id)) terminals++;
    }
    for (const m of mentsu) {
        if (m.type === H.MENTSU_SHUNTSU) shuntsu++;
        if (m.type === H.MENTSU_KOTSU) kotsu++;
        if (m.type === H.MENTSU_KANTU) { kantsu++; kotsu++; }
        if (m.open) openMentsu++;
        // 暗刻：门前自己凑的三张才算；荣和补上的那组刻子不算（四暗刻要自摸）
        if (m.type === H.MENTSU_KANTU) {
            if (m.concealed) anko++;
        } else if (m.type === H.MENTSU_KOTSU && !m.open) {
            const ronMade = ctx && !ctx.selfDrawn && ctx.winTile === m.tile;
            if (!ronMade) anko++;
        }
    }
    const pair = decomp ? decomp.pair : null;
    return {
        decomp, mentsu, blocks, pair, allIds,
        suits: [...suits], numSuits: [...suits].filter((s) => s !== "z").length,
        honors, young, terminals, kotsu, shuntsu, kantsu, anko, openMentsu,
        dragonKotsu: mentsu.filter((m) => m.type !== H.MENTSU_SHUNTSU && T.isDragon(m.tile)).length,
        windKotsu: mentsu.filter((m) => m.type !== H.MENTSU_SHUNTSU && T.isWind(m.tile)).length,
        menzen: (melds || []).every((m) => m.type === "kan" && m.concealed),
    };
}

// 一杯口/二杯口/一色三同顺：同花色同起点顺子的重复数
function shuntsuRepeats(shape) {
    const seen = {};
    for (const m of shape.mentsu) {
        if (m.type !== H.MENTSU_SHUNTSU) continue;
        seen[m.tile] = (seen[m.tile] || 0) + 1;
    }
    const pairs = Object.values(seen).filter((n) => n >= 2).length;
    const triples = Object.values(seen).filter((n) => n >= 3).length;
    return { pairs, triples };
}

// 全带幺九：每个块（含雀头）都碰得到幺九牌。七对/国士没有块结构，不参与这类役。
function everyBlockHasYoung(shape) {
    if (!shape.blocks.length) return false;
    return shape.blocks.every((m) => mentsuIds(m).some((id) => T.isYoung(id)));
}

function everyBlockYoungOnly(shape) {
    if (!shape.blocks.length) return false;
    return shape.blocks.every((m) => mentsuIds(m).every((id) => T.isYoung(id)));
}

function hasSanshoku(shape, kind) {
    const byNum = { m: new Set(), p: new Set(), s: new Set() };
    for (const m of shape.mentsu) {
        const isShuntsu = m.type === H.MENTSU_SHUNTSU;
        const isKotsu = m.type === H.MENTSU_KOTSU || m.type === H.MENTSU_KANTU;
        if (kind === "shuntsu" && !isShuntsu) continue;
        if (kind === "kotsu" && !isKotsu) continue;
        if (T.isNum(m.tile)) byNum[T.suitOf(m.tile)].add(m.tile % 9);
    }
    for (const r of byNum.m) if (byNum.p.has(r) && byNum.s.has(r)) return true;
    return false;
}

const isSingleSuit = (shape, suit) => shape.suits.length === 1 && shape.suits[0] === suit;

// 一气通贯：同花色 123 456 789 三组顺子
function hasIppong(shape) {
    for (const suit of ["m", "p", "s"]) {
        const base = { m: 0, p: 9, s: 18 }[suit];
        const ranks = new Set(shape.mentsu.filter((x) => x.type === H.MENTSU_SHUNTSU && T.suitOf(x.tile) === suit).map((x) => x.tile - base));
        if (ranks.has(0) && ranks.has(3) && ranks.has(6)) return true;
    }
    return false;
}

// 九莲宝灯：同色 1112345678999 + 同色任意一张
function chuRenCount(counts) {
    for (let s = 0; s < 3; s++) {
        const base = s * 9;
        const want = [3, 1, 1, 1, 1, 1, 1, 1, 3];
        let extra = 0;
        let ok = true;
        for (let r = 0; r < 9; r++) {
            const c = counts[base + r];
            if (c < want[r]) { ok = false; break; }
            extra += c - want[r];
        }
        for (let i = 0; i < 34 && ok; i++) if ((i < base || i >= base + 9) && counts[i] > 0) ok = false;
        if (ok && extra === 1) {
            // 纯正：和牌张补齐 1/9 使其成第 4 张
            const pure = counts[base] >= 4 || counts[base + 8] >= 4;
            return { yes: true, pure };
        }
    }
    return { yes: false, pure: false };
}

function isPinfu(shape, ctx) {
    if (!shape.menzen) return false;
    if (shape.mentsu.length !== 4 || shape.shuntsu !== 4) return false;
    if (T.isYoung(shape.pair)) return false;
    if (shape.pair === WIND_ID(ctx.seatWind) || shape.pair === WIND_ID(ctx.roundWind)) return false;
    return ctx.waitShape === "ryanmen";
}

// ---------- 符 ----------

// 刻子/杠子的符：中张 暗刻2 明刻4 暗杠8 明杠16；幺九 4/8/16/32 减半按常见口径取 4/8/8/16
function kotsuFu(m) {
    const young = T.isYoung(m.tile);
    if (m.type === H.MENTSU_KANTU) return young ? (m.open ? 16 : 8) : (m.open ? 8 : 4);
    return young ? (m.open ? 8 : 4) : (m.open ? 4 : 2);
}

function calcFu(shape, ctx) {
    if (shape.kokushi) return 0; // 役满不算符
    if (shape.chiitoi) return 50;

    let fu = 20;
    const seat = WIND_ID(ctx.seatWind);
    const round = WIND_ID(ctx.roundWind);

    if (shape.pair === seat && shape.pair === round) fu += 4;
    else if (shape.pair === seat || shape.pair === round || T.isDragon(shape.pair)) fu += 2;

    for (const m of shape.mentsu) {
        if (m.type === H.MENTSU_SHUNTSU) continue;
        fu += kotsuFu(m);
    }

    if (shape.pinfu) {
        // 平和：自摸不计符，荣和只拿门前荣和的 10 符
        if (!ctx.selfDrawn) fu = 30;
        else fu = 20;
        return fu;
    }
    if (ctx.waitShape === "tanki" || ctx.waitShape === "kanchan" || ctx.waitShape === "penchan") fu += 2;
    if (ctx.selfDrawn && shape.menzen) fu += 2;
    if (!ctx.selfDrawn && shape.menzen) fu += 10;
    // 副露听牌且自摸、符全为 0 的「无符自摸」按 20 符底
    return Math.ceil(fu / 10) * 10;
}

// ---------- 役表 ----------

const SANYAKU = [
    { key: "riichi", name: "立直", han: [1, 1], menzenOnly: true, test: (s, c) => !!c.riichi && !c.doubleRiichi },
    { key: "double-riichi", name: "二立直", han: [2, 2], menzenOnly: true, test: (s, c) => !!c.doubleRiichi },
    { key: "ippatsu", name: "一发", han: [1, 1], menzenOnly: true, test: (s, c) => !!c.ippatsu },
    { key: "tsumo", name: "门前清自摸和", han: [1, 1], menzenOnly: true, test: (s, c) => s.menzen && c.selfDrawn },
    { key: "haitei", name: "海底捞月", han: [1, 1], test: (s, c) => !!c.haitei },
    { key: "houtei", name: "河底捞鱼", han: [1, 1], test: (s, c) => !!c.houtei },
    { key: "rinshan", name: "杠上开花", han: [1, 1], test: (s, c) => !!c.rinshan },
    { key: "chankan", name: "抢杠和", han: [1, 1], test: (s, c) => !!c.chankan },
    { key: "pinfu", name: "平和", han: [1, 1], menzenOnly: true, test: (s) => s.pinfu },
    { key: "tanyao", name: "断幺九", han: [1, 1], test: (s) => s.young === 0 },
    { key: "ipeiko", name: "一杯口", han: [1, 1], menzenOnly: true, test: (s) => s.repeats.pairs === 1 && s.repeats.triples === 0 },
    { key: "ryanpeiko", name: "二杯口", han: [2, 2], menzenOnly: true, test: (s) => s.repeats.pairs === 2 && s.repeats.triples === 0 },
    { key: "sankoh", name: "一色三同顺", han: [2, 1], test: (s) => s.repeats.triples >= 1 },
    { key: "chiitoi", name: "七对子", han: [2, 2], menzenOnly: true, test: (s) => s.chiitoi },
    { key: "sanshoku", name: "三色同顺", han: [2, 1], test: (s) => hasSanshoku(s, "shuntsu") },
    { key: "sanshoku-kou", name: "三色同刻", han: [2, 2], test: (s) => hasSanshoku(s, "kotsu") },
    { key: "ippong", name: "一气通贯", han: [2, 1], test: (s) => hasIppong(s) },
    { key: "hon-chanta", name: "混全带幺九", han: [2, 1], test: (s) => s.honors > 0 && everyBlockHasYoung(s) },
    { key: "junchan", name: "纯全带幺九", han: [3, 2], test: (s) => everyBlockHasYoung(s) && s.honors === 0 },
    { key: "toitoi", name: "对对和", han: [2, 2], test: (s) => s.kotsu === 4 },
    { key: "sankantsu", name: "三杠子", han: [2, 2], test: (s) => s.kantsu === 3 },
    { key: "sanankou", name: "三暗刻", han: [2, 2], test: (s) => s.anko === 3 },
    { key: "shousangen", name: "小三元", han: [2, 2], test: (s) => s.dragonKotsu === 2 && T.isDragon(s.pair) },
    { key: "honroutou", name: "混老头", han: [2, 2], test: (s) => everyBlockYoungOnly(s) && s.honors > 0 && s.terminals > 0 },
    { key: "shousuushi", name: "小四喜", han: [YAKUMAN, YAKUMAN], test: (s) => s.windKotsu === 3 && T.isWind(s.pair) },
    { key: "honitsu", name: "混一色", han: [3, 2], test: (s) => s.numSuits === 1 && s.honors > 0 },
    { key: "chinitsu", name: "清一色", han: [6, 5], test: (s) => isSingleSuit(s, "m") || isSingleSuit(s, "p") || isSingleSuit(s, "s") },
    { key: "tsuuisou", name: "字一色", han: [YAKUMAN, YAKUMAN], test: (s) => s.suits.length === 1 && s.suits[0] === "z" },
    { key: "ryuisou", name: "绿一色", han: [YAKUMAN, YAKUMAN], test: (s) => s.allIds.every((id) => GREEN_TILES.has(id)) },
    { key: "chinroutou", name: "清老头", han: [YAKUMAN, YAKUMAN], test: (s) => s.terminals === s.allIds.length && s.honors === 0 },
    { key: "daisangen", name: "大三元", han: [YAKUMAN, YAKUMAN], test: (s) => s.dragonKotsu === 3 },
    { key: "suuankou", name: "四暗刻", han: [YAKUMAN, YAKUMAN], test: (s) => s.anko === 4 },
    { key: "suukantsu", name: "四杠子", han: [YAKUMAN, YAKUMAN], test: (s) => s.kantsu === 4 },
    { key: "kokushi", name: "国士无双", han: [YAKUMAN, YAKUMAN], menzenOnly: true, test: (s) => s.kokushi },
    { key: "churen", name: "九莲宝灯", han: [YAKUMAN, YAKUMAN], menzenOnly: true, test: (s, c) => !!c.chuRen },
    { key: "tenhou", name: "天和", han: [YAKUMAN, YAKUMAN], test: (s, c) => !!c.tenhou },
    { key: "chihou", name: "地和", han: [YAKUMAN, YAKUMAN], test: (s, c) => !!c.chihou },
    { key: "renhou", name: "人和", han: [5, 5], test: (s, c) => !!c.renhou },
];

// 役牌单列：自风/场风/三元每种一番，连风刻按两番
function yakuhaiFans(shape, ctx) {
    const out = [];
    const seat = WIND_ID(ctx.seatWind);
    const round = WIND_ID(ctx.roundWind);
    for (const m of shape.mentsu) {
        if (m.type === H.MENTSU_SHUNTSU) continue;
        if (m.tile === seat && m.tile === round) out.push({ key: "yakuhai", name: "连风刻", han: 2 });
        else if (m.tile === seat) out.push({ key: "yakuhai", name: "自风刻", han: 1 });
        else if (m.tile === round) out.push({ key: "yakuhai", name: "场风刻", han: 1 });
        if (T.isDragon(m.tile)) out.push({ key: "yakuhai", name: T.tileName(m.tile) + "刻", han: 1 });
    }
    return out;
}

function evaluateShape(shape, ctx) {
    let fans = [];
    for (const yaku of SANYAKU) {
        if (yaku.menzenOnly && !shape.menzen) continue;
        if (!yaku.test(shape, ctx)) continue;
        let mul = 1;
        if (yaku.key === "suuankou" && ctx.waitShape === "tanki") mul = 2;
        if (yaku.key === "kokushi" && ctx.kokushi13) mul = 2;
        if (yaku.key === "churen" && ctx.chuRenPure) mul = 2;
        if (yaku.han[0] === YAKUMAN) {
            for (let i = 0; i < mul; i++) fans.push({ key: yaku.key, name: yaku.name + (mul > 1 ? "（二倍）" : ""), han: YAKUMAN });
        } else {
            fans.push({ key: yaku.key, name: yaku.name, han: yaku.han[shape.openMentsu > 0 ? 1 : 0] });
        }
    }
    // 大三元已经包含三张三元牌的役牌番，不再重复加
    if (!fans.some((f) => f.key === "daisangen")) fans.push(...yakuhaiFans(shape, ctx));
    if (ctx.doraCount) fans.push({ key: "dora", name: "宝牌" + (ctx.doraCount > 1 ? "×" + ctx.doraCount : ""), han: ctx.doraCount });
    if (ctx.riichi && ctx.uraCount) fans.push({ key: "ura", name: "里宝牌×" + ctx.uraCount, han: ctx.uraCount });
    if (ctx.redCount) fans.push({ key: "red", name: "赤宝牌×" + ctx.redCount, han: ctx.redCount });

    // 一色三同顺不计一杯口
    if (shape.repeats.triples >= 1) {
        const i = fans.findIndex((f) => f.key === "ipeiko");
        if (i >= 0) fans.splice(i, 1);
    }
    // 役满不与数役叠加结算：清单里只留役满本身 + 宣言/局面役（立直、一发、自摸、海底、河底、杠上、抢杠），
    // 宝牌类在役满下不加番也不显示
    const yakuman = fans.filter((f) => f.han === YAKUMAN);
    if (yakuman.length) {
        const keep = new Set(["riichi", "double-riichi", "ippatsu", "tsumo", "haitei", "houtei", "rinshan", "chankan"]);
        return fans.filter((f) => f.han === YAKUMAN || keep.has(f.key));
    }
    return fans;
}

// ---------- 点数 ----------

function levelOf(han, fu) {
    if (han >= 13) return { name: "数え役满", base: 8000, yakuman: 1 };
    if (han >= 11) return { name: "三倍满", base: 6000 };
    if (han >= 8) return { name: "倍满", base: 4000 };
    if (han >= 6) return { name: "跳满", base: 3000 };
    if (han >= 5) return { name: "满贯", base: 2000 };
    if (fu === 30 && han <= 1) fu = 40; // 30 符 1 番不存在
    const raw = fu * Math.pow(2, 2 + han);
    if (raw >= 2000) return { name: "满贯", base: 2000 };
    return { name: han + " 番 " + fu + " 符", base: raw, fu };
}

// 收付：荣和由舍家全包（亲家和了 ×6，子家 ×4）；自摸按亲家付双倍分摊
function paymentsFor(basePoints, winnerSeat, dealerSeat, selfDrawn, discarderSeat) {
    const out = [];
    const winnerIsDealer = winnerSeat === dealerSeat;
    if (selfDrawn) {
        for (let seat = 0; seat < 4; seat++) {
            if (seat === winnerSeat) continue;
            const payerIsDealer = seat === dealerSeat;
            const unit = winnerIsDealer ? basePoints * 2 : payerIsDealer ? basePoints * 2 : basePoints;
            out.push({ from: seat, to: winnerSeat, amount: ceil100(unit) });
        }
        return out;
    }
    const payer = discarderSeat == null ? (winnerIsDealer ? 0 : 1) : discarderSeat;
    out.push({ from: payer, to: winnerSeat, amount: ceil100(basePoints * (winnerIsDealer ? 6 : 4)) });
    return out;
}

// 流局罚符：听牌家里亲听则池子翻倍（6000），未听家均摊付出，听家按「亲=子的两倍」收
function buppaiPayments(tenpaiSeats, dealerSeat) {
    const noten = [0, 1, 2, 3].filter((s) => !tenpaiSeats.includes(s));
    if (!tenpaiSeats.length || !noten.length) return [];
    const pool = tenpaiSeats.includes(dealerSeat) ? 6000 : 3000;
    const weights = tenpaiSeats.map((s) => (s === dealerSeat ? 2 : 1));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const receives = tenpaiSeats.map((s, i) => Math.round((pool * weights[i]) / weightSum / 100) * 100);
    const pays = noten.map(() => Math.round(pool / noten.length / 100) * 100);
    // 逐对拆分：每个未听家对每个听家的支付 = 付出额 × 该听家权重占比，余数给最后一对
    const round50 = (n) => Math.round(n / 50) * 50;
    const out = [];
    for (let n = 0; n < noten.length; n++) {
        let left = pays[n];
        for (let i = 0; i < tenpaiSeats.length; i++) {
            const last = i === tenpaiSeats.length - 1;
            const amount = last ? left : round50((pays[n] * weights[i]) / weightSum);
            if (amount > 0) out.push({ from: noten[n], to: tenpaiSeats[i], amount });
            left -= amount;
        }
    }
    return { transfers: out, perPayer: pays, perWinner: receives };
}

// ---------- 主入口 ----------

// ctx:
//  concealedIds / concealedTiles   和牌时门前牌（含和牌张）；tiles 版用来数赤牌
//  melds                           [{type:"chi"|"pon"|"kan", tiles, concealed}]
//  winTile, selfDrawn, waitShape   waitShape: ryanmen/kanchan/penchan/shanpon/tanki
//  winSeat, dealerSeat, seatWind, roundWind, discarderSeat
//  doraIndicators, uraIndicators
//  riichi, doubleRiichi, ippatsu, haitei, houtei, rinshan, chankan, tenhou, chihou, renhou
//  allowChiitoi, allowKokushi
function scoreWin(ctx) {
    const ids = ctx.concealedIds || ctx.concealed || [];
    const counts = T.countsOf(ids);
    const melds = ctx.melds || [];
    const chiitoiAllowed = ctx.allowChiitoi !== false && melds.length === 0;
    const kokushiAllowed = ctx.allowKokushi !== false && melds.length === 0;
    // 门前牌数必须正好补齐 14 张（每副露占一个三张槽），否则现场描述就是错的
    const expect = 14 - 3 * melds.length;
    if (ids.length !== expect) {
        return { ok: false, reason: "门前牌 " + ids.length + " 张，应该 " + expect + " 张（副露 " + melds.length + " 组）" };
    }

    const ctxFull = Object.assign({}, ctx, {
        doraCount: countDora(ids, ctx.doraIndicators),
        redCount: countRedFives(ctx.concealedTiles),
    });
    // 里宝只有立直（含二立直）才翻出来数
    ctxFull.uraCount = ctx.riichi || ctx.doubleRiichi ? countDora(ids, ctx.uraIndicators) : 0;
    const chuRen = melds.length === 0 ? chuRenCount(counts) : { yes: false, pure: false };
    ctxFull.chuRen = chuRen.yes;
    ctxFull.chuRenPure = chuRen.pure;

    const candidates = [];
    if (kokushiAllowed && H.isKokushiCounts(counts)) {
        candidates.push({ kind: "kokushi", shape: specialShape(ids, { kokushi: true }, melds) });
    }
    if (chiitoiAllowed && H.isChiitoiCounts(counts)) {
        candidates.push({ kind: "chiitoi", shape: specialShape(ids, { chiitoi: true }, melds) });
    }
    for (const decomp of H.allDecompositions(counts)) {
        const shape = shapeOf(decomp, melds, ctxFull);
        shape.repeats = shuntsuRepeats(shape);
        shape.pinfu = isPinfu(shape, ctxFull);
        shape.allGreen = shape.allIds.every((id) => GREEN_TILES.has(id));
        candidates.push({ kind: "standard", shape });
    }
    if (!candidates.length) return { ok: false, reason: "牌型不成立：要 4 面子 + 1 雀头，或七对 / 国士" };

    let best = null;
    for (const cand of candidates) {
        const fans = evaluateShape(cand.shape, ctxFull);
        const real = fans.filter((f) => !DORA_KEYS.has(f.key));
        const yakuman = fans.filter((f) => f.han === YAKUMAN).length;
        const han = fans.filter((f) => f.han !== YAKUMAN).reduce((a, f) => a + f.han, 0);
        if (!yakuman && !real.length) continue; // 只有宝牌 -> 无役
        const fu = yakuman ? 0 : calcFu(cand.shape, ctxFull);
        const level = yakuman ? { name: levelName(yakuman), base: 8000 * yakuman, yakuman } : levelOf(han, fu);
        const cand2 = { cand, fans, real, han, yakuman, fu, level, basePoints: level.base };
        if (!best || scoreOf(cand2) > scoreOf(best)) best = cand2;
    }
    if (!best) return { ok: false, reason: "无役，不能和牌（宝牌不算役；振听也不能和）" };

    const pays = paymentsFor(best.basePoints, ctx.winSeat, ctx.dealerSeat, !!ctx.selfDrawn, ctx.discarderSeat);
    const sticks = (ctx.honba || 0) * 300;
    if (sticks) {
        if (ctx.selfDrawn) for (const p of pays) p.amount += (ctx.honba || 0) * 100;
        else pays[0].amount += sticks;
    }

    return {
        ok: true,
        kind: best.cand.kind,
        fans: best.fans.map((f) => ({ name: f.name, han: f.han === YAKUMAN ? "役满" : f.han })),
        han: best.han,
        fu: best.fu,
        yakuman: best.yakuman,
        level: best.level.name,
        basePoints: best.basePoints,
        dealer: ctx.winSeat === ctx.dealerSeat,
        honbaGain: sticks,
        riichiSticks: ctx.riichiSticks || 0,
        payments: pays,
        total: pays.reduce((a, p) => a + p.amount, 0) + (ctx.riichiSticks || 0) * 1000,
    };
}

function specialShape(ids, extra, melds) {
    const suits = new Set(ids.map((id) => (T.isHonor(id) ? "z" : T.suitOf(id))));
    return Object.assign({
        decomp: null, mentsu: [], blocks: [], pair: null, allIds: ids.slice(),
        suits: [...suits], numSuits: [...suits].filter((s) => s !== "z").length,
        honors: ids.filter(T.isHonor).length, young: ids.filter(T.isYoung).length,
        terminals: ids.filter(T.isTerminal).length,
        kotsu: 0, shuntsu: 0, kantsu: 0, anko: 0, openMentsu: 0,
        dragonKotsu: 0, windKotsu: 0, menzen: true,
        repeats: { pairs: 0, triples: 0 }, pinfu: false,
    }, extra);
}

const scoreOf = (x) => (x.yakuman ? 100000 + x.yakuman * 1000 : x.basePoints * 10 + x.han);
const levelName = (n) => (n === 1 ? "役满" : n === 2 ? "二倍役满" : n === 3 ? "三倍役满" : n + "倍役满");

// ---------- 流局 ----------

// 中途流局：四风连打 / 九种九牌 / 四杠散了 / 三家和 / 牌山不足
function abortiveDraw(checks) {
    if (checks.fourWindsSameTile) return { yes: true, by: "四风连打" };
    if (checks.nineKindsFirstTurn) return { yes: true, by: "九种九牌" };
    if (checks.fourKansNoWall) return { yes: true, by: "四杠散了" };
    if (checks.threeRonSameTile) return { yes: true, by: "三家和" };
    if (checks.wallShort) return { yes: true, by: "牌山不足" };
    return { yes: false, by: null };
}

// 一炮三响：三家同时荣和同一张，按座次顺位分账，舍家按各家单独和牌全额支付
function splitThreeRon(resultList) {
    return resultList.map((r) => ({ winner: r.winSeat, payments: r.payments }));
}

module.exports = {
    YAKUMAN, WIND_ID,
    doraOf, doraTiles, countDora, countRedFives,
    shapeOf, shuntsuRepeats, hasSanshoku, hasIppong, isPinfu, chuRenCount, everyBlockHasYoung,
    calcFu, levelOf, ceil100, paymentsFor, buppaiPayments,
    scoreWin, abortiveDraw, splitThreeRon,
    SANYAKU,
};
