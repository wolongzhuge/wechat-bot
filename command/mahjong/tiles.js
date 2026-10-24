"use strict";
// 麻将牌的地基：编码、牌墙、发牌、名称与命令解析。四套规则的算番全压在这一层，所以先写死它。
//
// id 0-8   = 一万..九万 (m)
// id 9-17  = 一筒..九筒 (p)
// id 18-26 = 一条..九条 (s)
// id 27-30 = 東 南 西 北
// id 31-33 = 中 發 白
// id 34-41 = 花牌 春夏秋冬梅兰竹菊（只算加花，不进牌型）
//
// 牌墙元素不是裸 id 而是 {id, red}：同一张 5 万有 4 枚，赤宝牌要能精确标到某几枚上。

const SUIT_CHAR = { m: "万", p: "筒", s: "条" };
const HONOR_NAMES = ["東", "南", "西", "北", "中", "發", "白"];
const FLOWER_NAMES = ["春", "夏", "秋", "冬", "梅", "兰", "竹", "菊"];
const NUM_CHARS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

const suitOf = (id) => (id < 9 ? "m" : id < 18 ? "p" : id < 27 ? "s" : null);
const isNum = (id) => id >= 0 && id < 27;
const isHonor = (id) => id >= 27 && id < 34;
const isWind = (id) => id >= 27 && id < 31;
const isDragon = (id) => id >= 31 && id < 34;
const isFlower = (id) => id >= 34 && id < 42;
const isSimple = (id) => isNum(id) && id % 9 !== 0 && id % 9 !== 8; // 中张 2-8
const isTerminal = (id) => isNum(id) && (id % 9 === 0 || id % 9 === 8); // 1/9
const isYoung = (id) => isTerminal(id) || isHonor(id); // 幺九牌（国士、老头用）
const rankOf = (id) => (isNum(id) ? (id % 9) + 1 : null); // 1-9
const numOf = (id) => (isNum(id) ? Math.floor(id / 9) : null); // 0=万 1=筒 2=条

// 牌河的展示名：日麻写作「五萬」，其余写作「5万」。这里统一用一套，渲染和聊天都够用。
function tileName(id) {
    if (isFlower(id)) return FLOWER_NAMES[id - 34];
    if (isHonor(id)) return HONOR_NAMES[id - 27];
    return NUM_CHARS[id % 9] + SUIT_CHAR[suitOf(id)];
}
// 聊天里更常见的口语写法：3万 / 五萬 都能收，回执用这个短名
function tileShort(id) {
    if (isFlower(id)) return FLOWER_NAMES[id - 34];
    if (isHonor(id)) return HONOR_NAMES[id - 27];
    return String((id % 9) + 1) + SUIT_CHAR[suitOf(id)];
}
// 手牌/牌墙计数数组：长度 34（字牌算进去，花牌不算），面子分解全靠它
function emptyCounts() {
    return new Array(34).fill(0);
}
function countsOf(tiles) {
    const counts = emptyCounts();
    for (const t of tiles) {
        const id = typeof t === "number" ? t : t.id;
        if (id >= 0 && id < 34) counts[id]++;
    }
    return counts;
}
// 计数数组还原成排序好的 id 列表
function tilesFromCounts(counts) {
    const out = [];
    for (let id = 0; id < counts.length; id++) for (let i = 0; i < counts[id]; i++) out.push(id);
    return out;
}
const sortTiles = (ids) => ids.slice().sort((a, b) => a - b);

// 34 种基本牌各 4 枚
function baseWallIds(opts) {
    const ids = [];
    const max = opts.honors ? 34 : 27;
    for (let id = 0; id < max; id++) for (let i = 0; i < 4; i++) ids.push(id);
    return ids;
}

// 赤宝牌候选顺序：三赤 = 5m/5p/5s 各一枚；再多就往同一种 5 的第二、三枚叠。
// reds 也可以直接给 id 数组，让规则自己指定。
const RED_ORDER = [4, 13, 22, 4, 13, 22];

function makeWall(opts) {
    const options = Object.assign({ honors: true, flowers: false, reds: 0 }, opts || {});
    const ids = baseWallIds(options);
    const wall = ids.map((id) => ({ id, red: false }));

    const redIds = Array.isArray(options.reds)
        ? options.reds.slice()
        : RED_ORDER.slice(0, Math.max(0, Math.min(RED_ORDER.length, options.reds)));
    for (const red of redIds) {
        const slot = wall.find((t) => t.id === red && !t.red);
        if (slot) slot.red = true;
    }

    if (options.flowers) {
        for (let i = 0; i < FLOWER_NAMES.length; i++) wall.push({ id: 34 + i, red: false });
    }
    return wall;
}

// 洗牌： Fisher-Yates，rng 可注入方便测试复现
function shuffle(list, rng) {
    const random = rng || Math.random;
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

// ---------- 记号解析 ----------

const FULL_WIDTH = /[！-～]/g;
function normalize(text) {
    return String(text == null ? "" : text)
        .replace(FULL_WIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/\s+/g, "")
        .trim();
}

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9 };
const SUIT_TOKENS = {
    万: "m", 萬: "m", m: "m", M: "m", w: "m", W: "m",
    筒: "p", 饼: "p", 餅: "p", p: "p", P: "p", o: "p", O: "p", t: "p", T: "p",
    条: "s", 條: "s", 索: "s", s: "s", S: "s", b: "s", B: "s",
};
const HONOR_TOKENS = {
    東: 27, 东: 27, 东风: 27, 东風: 27,
    南: 28, 南风: 28,
    西: 29, 西风: 29,
    北: 30, 北风: 30,
    中: 31, 红中: 31,
    發: 32, 发: 32, 发财: 32, 發财: 32,
    白: 33, 白板: 33,
};
const FLOWER_TOKENS = { 春: 34, 夏: 35, 秋: 36, 冬: 37, 梅: 38, 兰: 39, 蘭: 39, 竹: 40, 菊: 41 };

// 认一张牌：「5万」「五萬」「5m」「東」「北」「发」都返回 id，认不出返回 null
function parseTile(text) {
    const s = normalize(text);
    if (!s) return null;
    if (FLOWER_TOKENS[s] !== undefined) return FLOWER_TOKENS[s];
    if (HONOR_TOKENS[s] !== undefined) return HONOR_TOKENS[s];
    const m = s.match(/^([1-9一二三四五六七八九])([a-zA-Z万萬筒饼餅条條索索])$/);
    if (!m) return null;
    const num = CN_NUM[m[1]];
    const suit = SUIT_TOKENS[m[2]];
    if (!num || !suit) return null;
    return { m: 0, p: 9, s: 18 }[suit] + num - 1;
}

// 认一串牌：「34」= 3、4 万（配合 cc吃34 这类写法），「5万5筒」也行
function parseTiles(text) {
    const s = normalize(text);
    if (!s) return [];
    const one = parseTile(s);
    if (one !== null) return [one];
    const out = [];
    // 先按「数字+花色」成对切，剩下的按分隔符切
    const pairs = s.match(/[1-9一二三四五六七八九][a-zA-Z万萬筒饼餅条條索]/g);
    if (pairs && pairs.join("") === s) {
        for (const p of pairs) out.push(parseTile(p));
        return out.every((t) => t !== null) ? out : [];
    }
    const parts = s.split(/[\s,，、+\-]+/).filter(Boolean);
    for (const part of parts) {
        const id = parseTile(part);
        if (id === null) return [];
        out.push(id);
    }
    return out;
}

// 「cc吃34」里的 34 只是点数，花色跟着被吃的那张牌走 —— 这里只解析出点数串
function parseRanks(text) {
    const s = normalize(text);
    if (!/^[1-9一二三四五六七八九]+$/.test(s)) return null;
    const out = [];
    for (const ch of s) {
        const n = CN_NUM[ch];
        if (!n) return null;
        out.push(n);
    }
    return out;
}

// 花色简称用于命令：cc缺条 / cc缺万
function parseSuit(text) {
    const suit = SUIT_TOKENS[normalize(text)];
    return suit || null;
}

module.exports = {
    SUIT_CHAR, HONOR_NAMES, FLOWER_NAMES, NUM_CHARS,
    suitOf, isNum, isHonor, isWind, isDragon, isFlower, isSimple, isTerminal, isYoung, rankOf, numOf,
    tileName, tileShort,
    emptyCounts, countsOf, tilesFromCounts, sortTiles,
    makeWall, baseWallIds, shuffle, RED_ORDER,
    parseTile, parseTiles, parseRanks, parseSuit,
};
