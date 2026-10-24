"use strict";
// 扑克牌地基：牌面编码、整副牌、增强/蜡封/版本三件套、排序与显示。
// 牌一律用「纯数据对象」表示（不是类实例），这样 state/store.js 直接 JSON 落盘、
// 热重载后 rebase 也不用管牌本身；游戏对象才需要 rebase。
//
// rank 1..13 = A 2 3 4 5 6 7 8 9 10 J Q K（A 既能当 1 也能当 14，顺子判定在 hands.js 里处理）
// suit 'S'黑桃 'H'红桃 'D'方块 'C'梅花；红 = H/D
// enh  ''|B奖励 M倍率 W万能 G玻璃 T钢铁 S石头 G? 见 ENH；seal ''|R红 U蓝 P金 Q紫；ed ''|F箔 H全息 C多彩 N负片

const SUITS = ["S", "H", "D", "C"];
const SUIT_CHAR = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_CN = { S: "黑桃", H: "红桃", D: "方块", C: "梅花" };
const RANK_CN = {
    1: "A", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
    11: "J", 12: "Q", 13: "K",
};

// 增强：chips/mult 是结算时直接加的部分，其余是触发型效果（在 score.js / jokers.js 里查表）
const ENH = {
    "": { name: "", chips: 0, mult: 0 },
    B: { name: "奖励", chips: 30, mult: 0, desc: "+30 筹码" },
    M: { name: "倍率", chips: 0, mult: 4, desc: "+4 倍率" },
    W: { name: "万能", chips: 0, mult: 0, desc: "花色算作所有花色" },
    G: { name: "玻璃", chips: 0, mult: 0, x: 2, desc: "×2 倍率，1/4 概率碎裂销毁" },
    T: { name: "钢铁", chips: 0, mult: 0, xHand: 1.5, desc: "在手牌里时 ×1.5 倍率" },
    X: { name: "石头", chips: 50, mult: 0, noRank: true, desc: "+50 筹码，没有点数花色" },
    D: { name: "金币", chips: 0, mult: 0, money: 3, desc: "回合结束还在手里 +$3" },
    L: { name: "幸运", chips: 0, mult: 0, desc: "1/5 概率 +20 倍率，1/15 概率 +$20" },
};
// 石头牌用 X 而不是 S，避免和花色 S（黑桃）混
const ENH_KEYS = ["B", "M", "W", "G", "T", "X", "D", "L"];

const SEAL = {
    "": { name: "" },
    R: { name: "红蜡封", desc: "重触发手里第一张牌的「在手牌里」效果" },
    U: { name: "蓝蜡封", desc: "回合结束复制最后打出的那手牌" },
    P: { name: "金蜡封", desc: "弃掉时 +$3" },
    Q: { name: "紫蜡封", desc: "弃掉时 1/4 概率生成一张塔罗牌" },
};
const SEAL_KEYS = ["R", "U", "P", "Q"];

const ED = {
    "": { name: "" },
    F: { name: "闪箔", mult: 1, desc: "+1 倍率" },
    H: { name: "全息", chips: 10, desc: "+10 筹码" },
    C: { name: "多彩", x: 1.5, desc: "×1.5 倍率" },
    N: { name: "负片", desc: "不占小丑/消耗品位，效果可无限叠加" },
};
const ED_KEYS = ["F", "H", "C", "N"];

const isRed = (card) => card.suit === "H" || card.suit === "D";
// 石头牌没有点数也没有花色：牌型判定要跳过它，但结算时它照样贡献筹码
const isStone = (card) => card.enh === "X";
// 万能牌算所有花色，判同花时当「和谁都能配」
const matchSuit = (card, suit) => card.enh === "W" || card.suit === suit;

let nextUid = 1;
function makeCard(rank, suit, opt) {
    const c = Object.assign({ uid: nextUid++, rank, suit, enh: "", seal: "", ed: "" }, opt || {});
    return c;
}

function newDeck() {
    const d = [];
    for (const s of SUITS) for (let r = 1; r <= 13; r++) d.push(makeCard(r, s));
    return d;
}

// 洗牌：Fisher-Yates，rng 由牌局自己带（测试可传固定种子复现）
function shuffle(list, rng) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
}

// 可复现随机数：mulberry32，牌局存 seed 就能整局重演
function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rankOf = (card) => (isStone(card) ? 0 : card.rank);
// 顺子里 A 可以当 1（A2345）也可以当 14（10JQKA）
const straightValues = (card) => {
    const r = rankOf(card);
    return r === 1 ? [1, 14] : [r];
};

// 排序：先按点数（A 最大放最前，跟斗地主一致的手感），再按花色
const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 };
function sortHand(cards) {
    return cards.slice().sort((a, b) => {
        const ra = rankOf(a) === 0 ? -1 : (rankOf(a) === 1 ? 14 : rankOf(a));
        const rb = rankOf(b) === 0 ? -1 : (rankOf(b) === 1 ? 14 : rankOf(b));
        if (ra !== rb) return rb - ra;
        return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
    });
}

// 单张牌的紧凑写法：红桃A / 石头 / 万能♠A —— 文本消息和盘面都用它
function cardText(card) {
    if (isStone(card)) return "石头";
    let s = SUIT_CHAR[card.suit] + RANK_CN[card.rank];
    if (card.enh) s = ENH[card.enh].name + s;
    if (card.seal) s = s + SEAL[card.seal].name[0];
    if (card.ed) s = s + ED[card.ed].name[0];
    return s;
}
// 群里打字选牌用的序号（1 起），手牌按显示顺序编号
function handMenu(cards) {
    return cards.map((c, i) => (i + 1) + "." + cardText(c)).join(" ");
}

function sameCard(a, b) { return a && b && a.uid === b.uid; }
function indexOfUid(cards, uid) { return cards.findIndex((c) => c.uid === uid); }

module.exports = {
    SUITS, SUIT_CHAR, SUIT_CN, RANK_CN, ENH, ENH_KEYS, SEAL, SEAL_KEYS, ED, ED_KEYS,
    isRed, isStone, matchSuit, makeCard, newDeck, shuffle, makeRng,
    rankOf, straightValues, sortHand, cardText, handMenu, sameCard, indexOfUid,
};
