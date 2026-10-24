"use strict";
// 麻将机器人：补满 4 家用的，也用来在人类挂机时给提示。
// 思路是「先少亏、再快听」：向听数最小 > 待牌最多 > 最安全（打过/现物优先）。
// 不做防守读牌（那要靠牌效统计），但在有人立直时会明显变怂。

const T = require("./tiles");
const H = require("./hand");

// 手牌计数（不含副露），meldsCount 用来修正向听
function countsFromHand(hand) {
    return T.countsOf(hand.map((t) => (typeof t === "number" ? t : t.id)));
}

// 打每张牌之后的「向听 / 待牌数」，用来挑最接近和牌的一手
function discardScores(counts, meldsCount, opts) {
    const out = [];
    for (let id = 0; id < 34; id++) {
        if (counts[id] <= 0) continue;
        const next = counts.slice();
        next[id]--;
        const sh = H.shanten(next, { melds: meldsCount, chiitoi: opts.chiitoi, kokushi: opts.kokushi });
        const waits = sh <= 0 ? H.waits(next, { melds: meldsCount }).length : 0;
        out.push({ id, shanten: sh, waits });
    }
    return out;
}

// 危险度：这张牌对某家是不是「现物」（他自己打过的牌，振听所以不能再和）
function safetyOf(id, game, seat) {
    let safe = 0;
    for (let s = 0; s < game.seats.length; s++) {
        if (s === seat || game.seats[s].out) continue;
        if (game.riverIds(s).includes(id)) safe += 2;              // 他家现物
        if (game.riversOwn(seat).includes(id)) safe += 3;          // 自己现物（振听，最稳）
        if (game.seats[s].riichi) safe -= 1;
    }
    return safe;
}

// 挑打哪张。locked（立直后）由调用方保证只能摸切。
function chooseDiscard(game, seat, handIds, opts) {
    const options = Object.assign({ chiitoi: true, kokushi: true, defend: false }, opts || {});
    const counts = countsFromHand(handIds);
    const melds = game.seats[seat].melds.length;
    const scored = discardScores(counts, melds, options);
    if (!scored.length) return handIds.length ? handIds[0] : null;

    let best = null;
    for (const cand of scored) {
        // 血战定缺：手里还剩缺门的牌时，先打缺门，别的都往后排
        const que = game.seats[seat].queSuit;
        const isQue = que ? T.suitOf(cand.id) === que : false;
        const danger = options.defend ? safetyOf(cand.id, game, seat) : 0;
        const value = (game.isDora(cand.id) ? 1 : 0) + (T.isYoung(cand.id) ? 0 : 0.5);
        const key = [
            isQue ? -100 : 0,
            cand.shanten,
            options.defend ? -danger : 0,
            -cand.waits,
            -value,
        ];
        if (!best || cmpKey(key, best.key) < 0) best = { id: cand.id, key };
    }
    return best.id;
}

function cmpKey(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

// 定缺：挑张数最少的一门；一样少就挑幺九多的那门（更难凑）
function chooseQue(handIds) {
    const bySuit = { m: 0, p: 0, s: 0 };
    const young = { m: 0, p: 0, s: 0 };
    for (const id of handIds) {
        const suit = T.suitOf(id);
        if (!suit) continue;
        bySuit[suit]++;
        if (T.isYoung(id)) young[suit]++;
    }
    let best = null;
    for (const suit of ["m", "p", "s"]) {
        const key = [bySuit[suit], young[suit], -suit.charCodeAt(0)];
        if (!best || cmpKey(key, best.key) < 0) best = { suit, key };
    }
    return best.suit;
}

// 要不要碰：能降向听才做，否则过（副露会关门清，乱碰反而更慢）。
// 血战的缺门那一门本来就要打光，碰它等于白送张数，直接不碰。
function wantsPon(game, seat, handIds, tileId, opts) {
    const que = game.seats[seat].queSuit;
    if (que && T.suitOf(tileId) === que) return false;
    const before = H.shanten(countsFromHand(handIds), { melds: game.seats[seat].melds.length, ...opts });
    const counts = countsFromHand(handIds);
    if (counts[tileId] < 2) return false;
    counts[tileId] -= 2;
    // 碰完算 3 张面子，向听要按「副露 +1」重算
    const after = H.shanten(counts, { melds: game.seats[seat].melds.length + 1, ...opts });
    return after < before;
}

// 吃：只在全能降向听时做，且优先吃边/坎
function wantsChi(game, seat, handIds, tileId, opts) {
    const before = H.shanten(countsFromHand(handIds), { melds: game.seats[seat].melds.length, ...opts });
    for (const combo of chiOptions(handIds, tileId)) {
        const counts = countsFromHand(handIds);
        for (const id of combo) if (id !== tileId) counts[id]--;
        const after = H.shanten(counts, { melds: game.seats[seat].melds.length + 1, ...opts });
        if (after < before) return true;
    }
    return false;
}

// 能被吃的组合：返回「手上的两张牌」的组合列表（不含被吃的那张）
function chiOptions(handIds, tileId) {
    if (!T.isNum(tileId)) return [];
    const counts = countsFromHand(handIds);
    const suit = T.suitOf(tileId);
    const base = suit === "m" ? 0 : suit === "p" ? 9 : 18;
    const rank = tileId - base; // 0-8
    const out = [];
    const has = (id) => id >= base && id < base + 9 && counts[id] > 0;
    if (has(tileId - 2) && has(tileId - 1)) out.push([tileId - 2, tileId - 1]);
    if (has(tileId - 1) && has(tileId + 1)) out.push([tileId - 1, tileId + 1]);
    if (has(tileId + 1) && has(tileId + 2)) out.push([tileId + 1, tileId + 2]);
    return out;
}

module.exports = { chooseDiscard, chooseQue, wantsPon, wantsChi, chiOptions, countsFromHand, discardScores, safetyOf };
