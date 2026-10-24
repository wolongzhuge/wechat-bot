"use strict";
// 牌型判定 + 每级加成。一手最多 5 张（跟小丑牌本体一致），所以判定不用回溯。
// 石头牌不参与牌型，但打出去照样算「计分牌」贡献 +50 筹码。
// 万能牌花色算作全部花色，判同花时跟谁都能配。

const { isStone, matchSuit, rankOf, straightValues } = require("./cards");

// key 是内部代号，cn 是群里显示用的名字，planet 是对应星球卡
const HANDS = {
    HIGH:   { cn: "高牌",     chips: 5,   mult: 1,  add: [10, 1], planet: "冥王星" },
    PAIR:   { cn: "对子",     chips: 10,  mult: 2,  add: [15, 1], planet: "火星" },
    TWOPAIR:{ cn: "两对",     chips: 20,  mult: 2,  add: [20, 1], planet: "水星" },
    TRIPS:  { cn: "三条",     chips: 30,  mult: 3,  add: [20, 2], planet: "木星" },
    STRAIGHT:{ cn: "顺子",    chips: 30,  mult: 4,  add: [30, 3], planet: "土星" },
    FLUSH:  { cn: "同花",     chips: 35,  mult: 4,  add: [40, 4], planet: "天王星" },
    FULL:   { cn: "葫芦",     chips: 40,  mult: 4,  add: [40, 4], planet: "海王星" },
    QUADS:  { cn: "四条",     chips: 60,  mult: 7,  add: [60, 3], planet: "金星" },
    SF:     { cn: "同花顺",   chips: 100, mult: 8,  add: [100, 4], planet: "地球" },
    FIVE:   { cn: "五条",     chips: 120, mult: 12, add: [80, 3], planet: "X星" },
    FHOUSE: { cn: "同花葫芦", chips: 250, mult: 14, add: [100, 4], planet: "谷神星" },
    FFIVE:  { cn: "同花五条", chips: 350, mult: 18, add: [120, 4], planet: "阋神星" },
};
// 从低到高，找「至少等于哪一档」时用（比如某些小丑要求牌型 ≥ 顺子）
const RANK_ORDER = ["HIGH", "PAIR", "TWOPAIR", "TRIPS", "STRAIGHT", "FLUSH", "FULL", "QUADS", "SF", "FIVE", "FHOUSE", "FFIVE"];
const handLevel = (key) => RANK_ORDER.indexOf(key);

function groups(cards) {
    const m = new Map();
    for (const c of cards) {
        const r = rankOf(c);
        if (!r) continue;
        if (!m.has(r)) m.set(r, []);
        m.get(r).push(c);
    }
    // 组大小降序、点数降序，保证同样牌型每次挑出的计分牌一致
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || b[0] - a[0]);
}

function isFlush(cards) {
    if (cards.length !== 5) return null;
    for (const s of ["S", "H", "D", "C"]) {
        if (cards.every((c) => matchSuit(c, s))) return s;
    }
    return null;
}

// 顺子：5 张点数互不相同且能连上；A 可 1 可 14
function straightCards(cards) {
    if (cards.length !== 5) return null;
    const opts = cards.map((c) => straightValues(c));
    const walk = (i, picked) => {
        if (i === cards.length) return picked;
        for (const v of opts[i]) {
            if (picked.some((p) => p.v === v)) continue;
            const r = walk(i + 1, picked.concat([{ c: cards[i], v }]));
            if (r) return r;
        }
        return null;
    };
    const picked = walk(0, []);
    if (!picked) return null;
    const vs = picked.map((p) => p.v).sort((a, b) => a - b);
    for (let i = 1; i < 5; i++) if (vs[i] !== vs[i - 1] + 1) return null;
    return picked.map((p) => p.c);
}

// 主入口：给一手打出的牌（≤5 张），回 {key, cn, scoring} 或 null（一手废牌也能算高牌）
// scoring = 这手里真正算分的牌（石头牌永远算分，其余只取牌型内的那几张）
function detect(played) {
    const cards = played.filter((c) => !isStone(c));
    const stones = played.filter(isStone);
    const g = groups(cards);
    const sizes = g.map((e) => e[1].length);
    const flushSuit = isFlush(cards);
    const straight = straightCards(cards);

    let key = null;
    let part = [];
    const pick = (n, from) => (from || g).slice(0, n).flatMap((e) => e[1]);

    if (flushSuit && straight) {
        key = sizes[0] === 5 ? "FFIVE" : "SF";
        part = cards;
    } else if (sizes[0] === 5) {
        key = flushSuit ? "FFIVE" : "FIVE";
        part = cards;
    } else if (sizes[0] === 3 && sizes[1] === 2) {
        key = flushSuit ? "FHOUSE" : "FULL";
        part = cards;
    } else if (straight) {
        key = "STRAIGHT"; part = straight;
    } else if (flushSuit) {
        key = "FLUSH"; part = cards;
    } else if (sizes[0] === 4) {
        key = "QUADS"; part = g[0][1];
    } else if (sizes[0] === 3 && sizes[1] === 2) {
        key = "FULL"; part = cards;
    } else if (sizes[0] === 3) {
        key = "TRIPS"; part = g[0][1];
    } else if (sizes[0] === 2 && sizes[1] === 2) {
        key = "TWOPAIR"; part = pick(2);
    } else if (sizes[0] === 2) {
        key = "PAIR"; part = g[0][1];
    } else {
        key = "HIGH"; part = [cards.slice().sort((a, b) => rankOf(b) - rankOf(a))[0]].filter(Boolean);
    }
    // 计分牌顺序保持玩家打出时的顺序，重触发类小丑按这个顺序数
    const scoringSet = new Set(part.concat(stones).map((c) => c.uid));
    return { key, cn: HANDS[key].cn, scoring: played.filter((c) => scoringSet.has(c.uid)), stones: stones.length };
}

// 某牌型在某等级的基础值：base + (等级-1) × 每级加成
function handValue(key, level) {
    const h = HANDS[key] || HANDS.HIGH;
    const lv = Math.max(1, level || 1);
    return { chips: h.chips + (lv - 1) * h.add[0], mult: h.mult + (lv - 1) * h.add[1] };
}

const PLANETS = {
    冥王星: "HIGH", 火星: "PAIR", 水星: "TWOPAIR", 木星: "TRIPS", 土星: "STRAIGHT",
    天王星: "FLUSH", 海王星: "FULL", 金星: "QUADS", 地球: "SF", X星: "FIVE",
    谷神星: "FHOUSE", 阋神星: "FFIVE",
};
// 星球卡：把对应牌型升 1 级；「求签/塔罗」那套在 consumables.js
function planetEffect(name, levels) {
    const key = PLANETS[name];
    if (!key) return null;
    return { key, levels: levels || 1 };
}

module.exports = { HANDS, RANK_ORDER, handLevel, detect, handValue, PLANETS, planetEffect };
