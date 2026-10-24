"use strict";
// 牌型核心：和牌分解、向听数、待牌枚举、振听判定。
// 四套规则的算番都从这里拿拆法，所以这层的正确性优先于花哨。
//
// 约定：counts 是长度 34 的计数数组（不含花牌），melds 是已经亮出的副露数量。
// 手牌张数 = sum(counts) = 13 - 3*melds（和牌前）/ 14 - 3*melds（和牌时）。

const T = require("./tiles");

const MENTSU_SHUNTSU = "shuntsu";
const MENTSU_KOTSU = "kotsu";
const MENTSU_KANTU = "kantsu";

// ---------- 完整分解（算番用） ----------

// 把纯计数数组拆成若干面子；返回所有拆法（每个拆法是面子数组）
function splitMentsu(c, start) {
    let i = start || 0;
    while (i < 34 && c[i] === 0) i++;
    if (i >= 34) return [[]];
    const out = [];
    if (c[i] >= 3) {
        c[i] -= 3;
        for (const rest of splitMentsu(c, i)) out.push([{ type: MENTSU_KOTSU, tile: i }, ...rest]);
        c[i] += 3;
    }
    if (i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
        c[i]--; c[i + 1]--; c[i + 2]--;
        for (const rest of splitMentsu(c, i)) out.push([{ type: MENTSU_SHUNTSU, tile: i }, ...rest]);
        c[i]++; c[i + 1]++; c[i + 2]++;
    }
    return out;
}

// 全部「雀头 + 面子」拆法。counts 必须正好凑成 3*n+2 张。
// 返回 [{pair, mentsu:[{type,tile}]}]；拆不出来返回空数组。
function allDecompositions(counts) {
    const c = counts.slice();
    const out = [];
    for (let i = 0; i < 34; i++) {
        if (c[i] < 2) continue;
        c[i] -= 2;
        for (const mentsu of splitMentsu(c, 0)) out.push({ pair: i, mentsu });
        c[i] += 2;
    }
    return out;
}

const YOUNG_IDS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

function isKokushiCounts(counts) {
    let kinds = 0, pairs = 0;
    for (let i = 0; i < 34; i++) {
        if (counts[i] === 0) continue;
        if (!T.isYoung(i)) return false;
        kinds++;
        if (counts[i] > 2) return false;
        if (counts[i] === 2) pairs++;
    }
    return kinds === 13 && pairs === 1;
}

function isChiitoiCounts(counts) {
    let kinds = 0, pairs = 0;
    for (let i = 0; i < 34; i++) {
        if (counts[i] === 0) continue;
        if (counts[i] % 2 !== 0) return false;
        kinds++;
        pairs += counts[i] / 2;
    }
    return kinds === 7 && pairs === 7;
}

// 标准和牌型（含副露）：n 个面子 + 1 雀头
function isStandardWin(counts, melds) {
    const need = 4 - (melds || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total !== need * 3 + 2) return false;
    return allDecompositions(counts).length > 0;
}

// 和牌判定入口：按模式允许的牌型逐个试
function isWin(counts, opts) {
    const options = Object.assign({ melds: 0, chiitoi: true, kokushi: true }, opts || {});
    if (options.melds === 0 && options.kokushi && isKokushiCounts(counts)) return true;
    if (options.melds === 0 && options.chiitoi && isChiitoiCounts(counts)) return true;
    return isStandardWin(counts, options.melds);
}

// ---------- 向听数 ----------

// 面子/搭子/雀头的最优组合：向听 = 2*(4-melds) - 2*面子 - 搭子 - 雀头
// 注意两点（写错过，留在这儿）：
//  1) 对子既可能是雀头，也可能是「碰了就成面子」的搭子，两种用法要分别试；
//  2) 雀头是第 5 个块，四个面子槽位占满后仍然要能再认雀头，否则和牌算成 0 向听。
function scanBlocks(counts, melds) {
    const need = 4 - (melds || 0);
    const c = counts.slice();
    let best = -1;
    let bestCombo = { mentsu: 0, taatsu: 0, pair: 0 };

    function evaluate(m, t, p) {
        const tt = Math.min(t, need - m);
        const score = 2 * m + tt + p;
        if (score > best) {
            best = score;
            bestCombo = { mentsu: m, taatsu: tt, pair: p };
        }
    }

    function rec(i, m, t, p) {
        while (i < 34 && c[i] === 0) i++;
        if (i >= 34) {
            evaluate(m, t, p);
            return;
        }

        if (m < need && c[i] >= 3) {
            c[i] -= 3;
            rec(i, m + 1, t, p);
            c[i] += 3;
        }
        if (m < need && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
            c[i]--; c[i + 1]--; c[i + 2]--;
            rec(i, m + 1, t, p);
            c[i]++; c[i + 1]++; c[i + 2]++;
        }
        if (p === 0 && c[i] >= 2) {
            c[i] -= 2;
            rec(i, m, t, 1);
            c[i] += 2;
        }
        if (m + t < need) {
            // 对子当搭子（将来碰成面子）
            if (c[i] >= 2) {
                c[i] -= 2;
                rec(i, m, t + 1, p);
                c[i] += 2;
            }
            // 两面/边张搭子；留在 i 继续找，所以 1122 能拆成两个搭子
            if (i % 9 <= 7 && c[i + 1] > 0) {
                c[i]--; c[i + 1]--;
                rec(i, m, t + 1, p);
                c[i]++; c[i + 1]++;
            }
            if (i % 9 <= 6 && c[i + 2] > 0) {
                c[i]--; c[i + 2]--;
                rec(i, m, t + 1, p);
                c[i]++; c[i + 2]++;
            }
        }
        // 这一张不用，往后走
        c[i]--;
        rec(i + 1, m, t, p);
        c[i]++;
    }

    rec(0, 0, 0, 0);
    return { score: best, ...bestCombo };
}

// -1 = 已和牌，0 = 听牌（差一张），数字越大越远
function shantenStandard(counts, melds) {
    const need = 4 - (melds || 0);
    const b = scanBlocks(counts, melds);
    return 2 * need - 2 * b.mentsu - b.taatsu - b.pair;
}

function shantenChiitoi(counts) {
    let kinds = 0, pairs = 0;
    for (let i = 0; i < 34; i++) {
        if (counts[i] === 0) continue;
        kinds++;
        pairs += Math.floor(counts[i] / 2);
    }
    // 种类不足 7 时，多出来的对子不能当第 8 种牌用
    return 6 - pairs + Math.max(0, 7 - kinds);
}

function shantenKokushi(counts) {
    let kinds = 0, pair = 0;
    for (const id of YOUNG_IDS) {
        if (counts[id] > 0) kinds++;
        if (counts[id] >= 2) pair = 1;
    }
    return 13 - kinds - pair;
}

// 综合向听：标准型 / 七对 / 国士，取最小
function shanten(counts, opts) {
    const options = Object.assign({ melds: 0, chiitoi: true, kokushi: true }, opts || {});
    let best = shantenStandard(counts, options.melds);
    if (options.melds === 0) {
        if (options.chiitoi) best = Math.min(best, shantenChiitoi(counts));
        if (options.kokushi) best = Math.min(best, shantenKokushi(counts));
    }
    return best;
}

// ---------- 待牌 ----------

// 13 张（或副露后等价张数）的手牌，枚举所有能成和的牌。返回 id 数组。
function waits(counts, opts) {
    const options = Object.assign({ melds: 0, chiitoi: true, kokushi: true, allowFlowers: false }, opts || {});
    const out = [];
    for (let id = 0; id < 34; id++) {
        if (counts[id] >= 4) continue;
        const next = counts.slice();
        next[id]++;
        if (isWin(next, options)) out.push(id);
    }
    return out;
}

// 每张待牌还剩几枚可和（牌墙/别家手牌里的余量），用于 AI 选牌和提示
function waitDetail(counts, opts, visibleCounts) {
    const list = waits(counts, opts);
    return list.map((id) => ({
        id,
        name: T.tileName(id),
        left: Math.max(0, 4 - (counts[id] || 0) - (visibleCounts ? visibleCounts[id] || 0 : 0)),
    }));
}

// ---------- 振听 ----------

// 振听 = 待牌里有自己打过的牌（or 同巡别人打过没和）。
// selfRiver 是自己牌河里的 id 列表，winners 是当前待牌 id。
function isFuriten(waitsList, selfRiver, sameTurnRiver) {
    const own = new Set(selfRiver || []);
    for (const id of waitsList) if (own.has(id)) return { yes: true, by: "own", tile: id };
    const turn = new Set(sameTurnRiver || []);
    for (const id of waitsList) if (turn.has(id)) return { yes: true, by: "same-turn", tile: id };
    return { yes: false, by: null, tile: null };
}

// 副露的面子文字化，命令层和渲染都要用
function describeMeld(meld) {
    const tiles = meld.tiles.map((t) => (typeof t === "number" ? t : t.id));
    const head = T.tileName(tiles[0]);
    if (meld.type === "chi") {
        const ranks = tiles.map((id) => T.rankOf(id)).sort((a, b) => a - b);
        return { text: "吃" + head + "(" + ranks.join("") + ")", type: MENTSU_SHUNTSU, tile: Math.min(...tiles) };
    }
    if (meld.type === "pon") return { text: "碰" + head, type: MENTSU_KOTSU, tile: tiles[0] };
    if (meld.type === "kan") return { text: (meld.concealed ? "暗杠" : "明杠") + head, type: MENTSU_KANTU, tile: tiles[0] };
    return { text: head, type: null, tile: tiles[0] };
}

module.exports = {
    MENTSU_SHUNTSU, MENTSU_KOTSU, MENTSU_KANTU, YOUNG_IDS,
    splitMentsu, allDecompositions,
    isKokushiCounts, isChiitoiCounts, isStandardWin, isWin,
    scanBlocks, shantenStandard, shantenChiitoi, shantenKokushi, shanten,
    waits, waitDetail, isFuriten, describeMeld,
};
