"use strict";
// 麻将的 cc 命令记法解析。命令层只做「认得出、说得清」，判定都交给引擎。
//
// 立直和出牌是一条命令（用户 2026-10-24 指定）：
//   cc三万立直   cc3万立直   cc五筒立直   cc5m立直   全角 cc３萬立直 都认
// 没有单独的 cc立直 两步流程——只发 cc立直 会被拒并提示带上要打的那张牌。

const T = require("./tiles");

const RIICHI = /(立直|リーチ|riichi|reach)/i;
const STRIP_LEAD = /^(打|出|丢|扔|play|drop)/;

function normalizeText(text) {
    return String(text == null ? "" : text)
        .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/\s+/g, "")
        .trim();
}

// 「打三万」「三万」「出三万」「3m」-> 要打出的牌 id
function parseDiscard(text) {
    const s = normalizeText(text).replace(STRIP_LEAD, "");
    const id = T.parseTile(s);
    return id === null ? null : id;
}

// 立直一体命令 -> {tile} 或 {needTile}（没带牌）或 {badTile}（带的不是牌）
function parseRiichi(text) {
    const s = normalizeText(text);
    if (!RIICHI.test(s)) return null;
    const body = s.replace(RIICHI, "").replace(STRIP_LEAD, "").trim();
    if (!body) return { needTile: true };
    const id = T.parseTile(body);
    return id === null ? { badTile: body } : { tile: id };
}

// 副露/声明：cc过 cc和 cc碰五筒 cc暗杠五筒 cc明杠 cc补杠 cc吃34 cc缺条
// cc过 的简写是 ccp（用户指定，和雀魂的 P=过 一致）；单独一个 p 只可能是「过」，
// 牌名里的 p 永远带数字（3p=三筒），不会撞车。
function parseClaim(text) {
    const s = normalizeText(text);
    if (/^(过|跳过|不要|pass)/i.test(s) || /^p$/i.test(s)) return { claim: "pass" };
    if (/^(自摸)/.test(s)) {
        const tile = T.parseTile(s.replace(/^自摸/, ""));
        return { claim: "tsumo", tile: tile === null ? undefined : tile };
    }
    if (/^(和了|和|胡|ron|hu)/.test(s)) {
        const tile = T.parseTile(s.replace(/^(和了|和|胡|ron|hu)/, ""));
        return { claim: "ron", tile: tile === null ? undefined : tile };
    }
    if (/^(暗杠|黑杠)/.test(s)) return { claim: "ankan", tile: tileAfter(s, /^(暗杠|黑杠)/) };
    if (/^(补杠|加杠|续杠)/.test(s)) return { claim: "ranka", tile: tileAfter(s, /^(补杠|加杠|续杠)/) };
    if (/^(明杠|直杠|开杠|杠)/.test(s)) return { claim: "minkan", tile: tileAfter(s, /^(明杠|直杠|开杠|杠)/) };
    if (/^(碰|pon|pong)/.test(s)) return { claim: "pon", tile: tileAfter(s, /^(碰|pon|pong)/) };
    if (/^(吃|顺|chi)/.test(s)) {
        const body = s.replace(/^(吃|顺|chi)/, "");
        const ranks = T.parseRanks(body);
        if (ranks) return { claim: "chi", ranks };
        const tiles = T.parseTiles(body);
        if (tiles.length) return { claim: "chi", tiles };
        return { claim: "chi" };
    }
    if (/^(定缺|缺一门|缺)/.test(s)) return { claim: "miss", suit: T.parseSuit(s.replace(/^(定缺|缺一门|缺)/, "")) };
    return null;
}

function tileAfter(s, stripRe) {
    const id = T.parseTile(s.replace(stripRe, ""));
    return id === null ? undefined : id;
}

// 查询类命令
function parseQuery(text) {
    const s = normalizeText(text);
    if (/^(状态|局面|现在)/.test(s)) return "status";
    if (/^(手牌|我的牌)/.test(s)) return "hand";
    if (/^(棋盘|盘面|看图|牌河|桌)/.test(s)) return "board";
    if (/^(点数|分数|结算|积分)/.test(s)) return "score";
    if (/^(规则|怎么玩)/.test(s)) return "rules";
    if (/^(模式|换玩法|换规则)/.test(s)) return "mode";
    if (/^(结束|散桌|不玩了)/.test(s)) return "quit";
    return null;
}

module.exports = { parseDiscard, parseRiichi, parseClaim, parseQuery, normalizeText, RIICHI };
