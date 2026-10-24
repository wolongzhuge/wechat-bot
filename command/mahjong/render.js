"use strict";
// 麻将盘面渲染：照雀魂那张方桌画的。
//   横版长桌 + 一圈木边 → 四家牌河围着中央信息盘（東1局 / 余牌 / 四个风位盒）
//   每张牌一圈橙边（那是牌立着的侧厚度，雀魂最显眼的特征）→ 玩家卡片压在各边中点
//   自己的手牌放大摆在桌子下面，别人手里几张只画数字，一局打完才在下方整排亮牌
//
// 配色是从 game.maj-soul.com 的实机截图上取的，见 scripts/probe-majsoul-pal.js；
// 雀魂是 Unity WebGL 画的，DOM 里只有一个 canvas，扒不到元素，只能照图临。
//
// 牌面本体（筒=圆点、条=竹节、万=数字+萬、字牌=字、白板=框）在 tileart.js，
// 这里只管布局和文字。汉字点阵来自 glyphs.js（scripts/gen-mahjong-glyphs.ps1 烤的 32×32）。
// 出图失败时调用方退回 renderText 的文字盘面。

const { Canvas } = require("../../utils/png");
const A = require("./tileart");
const T = require("./tiles");

const { PAL, drawTile, roundRect, gradRect } = A;

const W = 980;
const HDR = { x: 8, y: 8, w: 964, h: 40 };
const TBL = { x: 8, y: 54, w: 964, h: 704 };
const RIM = 12;                                  // 木边宽度
const FELT = { x: TBL.x + RIM, y: TBL.y + RIM, w: TBL.w - RIM * 2, h: TBL.h - RIM * 2 };
const CX = TBL.x + TBL.w / 2;                    // 490
const CY = TBL.y + TBL.h / 2;                    // 406
const PANEL = { w: 260, h: 150 };
const HAND_Y = TBL.y + TBL.h + 8;                // 766

const RIVER = { w: 26, h: 36, gap: 3, cols: 6, rows: 3 };
const MELD = { w: 20, h: 26, gap: 2, perRow: 16 };         // 一行能摊开四组副露（标签 + 三张）
const REVEAL = { w: 20, h: 26, gap: 2 };                   // 结算亮牌：桌子下方整排，跟副露同尺寸
const HAND = { w: 40, h: 54, gap: 2, cols: 14 };
const TAG = { w: 22, h: 30, gap: 2 };
const CARD = { w: 168, h: 92 };
const CARD_SIDE = { w: 116, h: 150 };                      // 左右两家的卡片立着放

const SUIT_SHORT = { m: "萬", p: "筒", s: "条" };
const WIND_CHARS = ["東", "南", "西", "北"];
const SEAT_CN = ["一", "二", "三", "四"];

// 四个方位各占哪块。pos = (座位 - 视角座位 + 4) % 4：0 下（自己）、1 右（下家）、2 上、3 左
// 牌河四家都是「横着的长方形」：6 张一行、3 行，紧贴中央信息盘摆，左右两家把整块横过来
// 占满两侧，视野才开阔。dx/dy 是列/行的延伸方向，第一行/第一列永远贴盘的那一边。
const RIVER_BOX = [
    { x: 405, y: 494, dx: 1, dy: 1 },     // 0 下：从贴盘那行往下长
    { x: 632, y: 349, dx: 1, dy: 1 },     // 1 右：从贴盘那列往右、往下
    { x: 405, y: 282, dx: 1, dy: -1 },    // 2 对家：从贴盘那行往上
    { x: 322, y: 349, dx: -1, dy: 1 },    // 3 左：从贴盘那列往左、往下
];
// 副露：贴着各自牌河的外侧摊成一行，谁的副露挨着谁的牌河，谁也不压谁。
// cx 是牌河中心，minX/maxX 是这块能占的横向范围（左右两家要留出对家牌河和桌沿，不然会顶出桌外）
const MELD_BAND = [
    { cx: 490, minX: 24, maxX: 956, y: 612 },     // 0 下：牌河下方
    { cx: 717, minX: 604, maxX: 956, y: 297 },    // 1 右：牌河上方，左缘让开对家牌河
    { cx: 490, minX: 24, maxX: 956, y: 170 },     // 2 对家：卡片和牌河之间
    { cx: 262, minX: 24, maxX: 405, y: 297 },     // 3 左：牌河上方，右缘让开对家牌河
];
// 玩家卡片压在各边中点：上下横着放，左右立着放
const CARD_BOX = [{ x: 406, y: 642 }, { x: 0, y: 0 }, { x: 406, y: 74 }, { x: 0, y: 0 }];
const SIDE_BOX = [{ x: 0, y: 0 }, { x: 838, y: 331 }, { x: 0, y: 0 }, { x: 26, y: 331 }];

// ---------- 文字 ----------
const latinAdvance = (scale) => 8 * scale + Math.max(1, Math.ceil(scale / 2));

function drawStr(cv, str, x, y, size, color) {
    let cursor = x;
    const latin = Math.max(1, Math.floor(size / 8));
    for (const ch of String(str)) {
        if (ch === " ") { cursor += Math.round(size / 2); continue; }
        if (A.hasGlyph(ch)) {
            A.drawGlyph(cv, ch, cursor, y + Math.round((size - 8 * latin) / 2), size, color);
            cursor += size + 1;
            continue;
        }
        cv.text(ch, cursor, y + Math.round((size - 8 * latin) / 2) + 1, color, latin);
        cursor += latinAdvance(latin);
    }
    return cursor - x;
}

function strWidth(str, size) {
    const latin = Math.max(1, Math.floor(size / 8));
    let w = 0;
    for (const ch of String(str)) {
        if (ch === " ") w += Math.round(size / 2);
        else if (A.hasGlyph(ch)) w += size + 1;
        else w += latinAdvance(latin);
    }
    return w;
}

function centerText(cv, str, cx, y, size, color) {
    drawStr(cv, str, Math.round(cx - strWidth(str, size) / 2), y, size, color);
}

// 小圆角标签（立直 / 和了 / 缺筒），雀魂那种状态胶囊
function pill(cv, x, y, text, size, fg, bg, border) {
    const w = strWidth(text, size) + 12;
    const h = size + 8;
    roundRect(cv, x, y, w, h, Math.floor(h / 2), border || PAL.pillEdge);
    roundRect(cv, x + 1, y + 1, w - 2, h - 2, Math.floor(h / 2), bg || PAL.pill);
    drawStr(cv, text, x + 6, y + 4, size, fg);
    return w;
}

// 昵称能不能画：字模表只覆盖牌桌用字，微信昵称基本都会缺字，缺一个就整段不画（画出来是问号更难看）
function showable(name, maxLen) {
    const s = String(name || "").slice(0, maxLen);
    if (!s) return "";
    for (const ch of s) {
        if (!A.hasGlyph(ch) && !/[0-9A-Za-z 　·\-_]/.test(ch)) return "";
    }
    return s;
}

// ---------- 视角与方位 ----------
function viewerSeat(snap) {
    return snap.seatOfUser == null ? (snap.dealer || 0) : snap.seatOfUser;
}
const posOf = (snap, seat) => (seat - viewerSeat(snap) + 4) % 4;
const seatAtPos = (snap, pos) => (viewerSeat(snap) + pos) % 4;

function riverSlot(pos, i) {
    const r = RIVER_BOX[pos];
    const col = i % RIVER.cols, row = Math.floor(i / RIVER.cols);
    return {
        x: r.x + col * (RIVER.w + RIVER.gap) * r.dx,
        y: r.y + row * (RIVER.h + RIVER.gap) * r.dy,
    };
}
// 副露一格一格摊：每行张数按总数平均分（≤16 张就是一行），整行居中压在牌河上
function meldLayout(pos, used) {
    const rows = Math.max(1, Math.ceil(used / MELD.perRow));
    const per = Math.max(1, Math.ceil(used / rows));
    const width = per * (MELD.w + MELD.gap) - MELD.gap;
    const b = MELD_BAND[pos];
    const x = Math.min(Math.max(Math.round(b.cx - width / 2), b.minX), b.maxX - width);
    return { x, y: b.y, per, rows, width };
}

// 结算亮牌：打牌过程中别人手牌是隐私，这一局打完才在桌子下方整排摊开
function revealedSeats(snap) {
    if (snap.phase !== "round-over") return [];
    return snap.seats.filter((s) => s.seat !== snap.seatOfUser && s.hand && s.hand.length);
}

// ---------- 桌面 ----------
function drawTable(cv) {
    A.woodFrame(cv, TBL.x, TBL.y, TBL.w, TBL.h, RIM);
    A.paintFelt(cv, FELT.x, FELT.y, FELT.w, FELT.h);
    // 桌沿内侧一道亮线，蓝布和木头之间才有分界
    cv.rect(FELT.x, FELT.y, FELT.x + FELT.w - 1, FELT.y, PAL.tableLine);
    cv.rect(FELT.x, FELT.y + FELT.h - 1, FELT.x + FELT.w - 1, FELT.y + FELT.h - 1, A.mix(PAL.tableLine, [0, 0, 0], 0.5));
    cv.rect(FELT.x, FELT.y, FELT.x, FELT.y + FELT.h - 1, PAL.tableLine);
    cv.rect(FELT.x + FELT.w - 1, FELT.y, FELT.x + FELT.w - 1, FELT.y + FELT.h - 1, PAL.tableLine);
    // 雀魂桌面上那圈「打这块」的斜切线：四个角各一道
    for (const [sx, sy] of [[FELT.x + 60, FELT.y], [FELT.x + FELT.w - 60, FELT.y],
        [FELT.x + 60, FELT.y + FELT.h], [FELT.x + FELT.w - 60, FELT.y + FELT.h]]) {
        cv.line(sx, sy, sx + (sx < CX ? 60 : -60), sy + (sy < CY ? 46 : -46), A.mix(PAL.table2, [0, 0, 0], 0.25));
    }
}

// ---------- 中央信息盘 ----------
function drawCenter(cv, snap) {
    const x = Math.round(CX - PANEL.w / 2), y = Math.round(CY - PANEL.h / 2);
    // 长桌配长方形信息盘，四角的风位盒正好压在盘角上
    roundRect(cv, x - 3, y - 3, PANEL.w + 6, PANEL.h + 6, 20, PAL.panelEdge);
    roundRect(cv, x, y, PANEL.w, PANEL.h, 18, PAL.panel);
    roundRect(cv, x + 2, y + 2, PANEL.w - 4, PANEL.h - 4, 16, A.mix(PAL.panel, [0, 0, 0], 0.22));

    const windIdx = (id) => (id == null ? 0 : id - 27);
    const roundWind = WIND_CHARS[Math.max(0, Math.min(3, windIdx(snap.roundWind)))];
    centerText(cv, roundWind + snap.round + "局", CX, y + 18, 22, PAL.gold);
    centerText(cv, "余 " + snap.wall, CX, y + 48, 18, PAL.white);
    const honba = "第 " + snap.honba + " 本";
    centerText(cv, honba, CX, y + 72, 16, PAL.dim);
    if (snap.sticks) centerText(cv, "立直棒 " + snap.sticks, CX, y + 94, 16, PAL.mark);
    // 横幅文案：打牌时只说「这张牌在等人表态」（谁能碰谁能和是隐私，私聊逐家问）；
    // 结算时役名一堆字点阵里没有，只从 label 里抠「几番 / 几点」这两个数
    let banner = null;
    if (snap.claim) banner = T.tileName(snap.claim.tile) + " 待表态";
    else if (snap.phase === "round-over") {
        const winners = snap.seats.filter((s) => s.win);
        if (!winners.length) banner = "流局";
        else {
            const s = winners[0];
            const m = String(s.win.label || "");
            const han = m.match(/(\d+)\s*番/);
            const pts = m.match(/(\d+)\s*(点|分)/);
            banner = SEAT_CN[s.seat] + "家" + (s.win.selfDrawn ? "自摸" : "和牌") +
                (han ? " " + han[1] + "番" : "") + (pts && winners.length === 1 ? " " + pts[1] + pts[2] : "") +
                (winners.length > 1 ? " +" + (winners.length - 1) : "");
        }
    }

    // 四个角的风位盒：下家顺时针 東南西北，庄家那一格压红底
    const boxes = [
        { pos: 0, x: x + 6, y: y + PANEL.h - 34 },
        { pos: 1, x: x + PANEL.w - 34, y: y + PANEL.h - 34 },
        { pos: 2, x: x + PANEL.w - 34, y: y + 8 },
        { pos: 3, x: x + 6, y: y + 8 },
    ];
    for (const b of boxes) {
        const seat = seatAtPos(snap, b.pos);
        const s = snap.seats[seat];
        if (!s || !s.name) { cv.rect(b.x, b.y, b.x + 25, b.y + 25, A.mix(PAL.panel, [0, 0, 0], 0.4)); continue; }
        const idx = (windIdx(snap.roundWind) + (seat - (snap.dealer || 0) + 4) % 4) % 4;
        const dealer = seat === snap.dealer;
        roundRect(cv, b.x, b.y, 26, 26, 5, dealer ? PAL.mark : PAL.panelEdge);
        roundRect(cv, b.x + 1, b.y + 1, 24, 24, 4, dealer ? A.mix(PAL.mark, [0, 0, 0], 0.25) : A.mix(PAL.panel, [0, 0, 0], 0.35));
        A.drawGlyph(cv, WIND_CHARS[idx], b.x + 3, b.y + 3, 20, dealer ? [255, 255, 255] : PAL.white);
    }
    // 横幅压在两个风位盒中间那条缝里（宽度只有 PANEL.w-66），所以画在盒子之后、放不下就降字号
    if (banner) {
        // 缝隙 = PANEL.w - 两个盒子和边距，再减掉胶囊自身 20 的内边距
        const maxW = PANEL.w - 86;
        let size = 14;
        while (size > 11 && strWidth(banner, size) > maxW) size--;
        let txt = banner;
        while (strWidth(txt, size) > maxW) txt = txt.slice(0, -1);
        const bw = strWidth(txt, size) + 20;
        const by = y + PANEL.h - 34;
        roundRect(cv, CX - bw / 2, by, bw, 26, 13, PAL.gold);
        roundRect(cv, CX - bw / 2 + 1, by + 1, bw - 2, 24, 12, A.mix(PAL.gold, [0, 0, 0], 0.4));
        centerText(cv, txt, CX, by + Math.round((26 - size) / 2) - 1, size, PAL.gold);
    }
}

// ---------- 玩家卡片 ----------
const AVATAR_TINT = [[72, 108, 180], [154, 74, 92], [64, 132, 100], [124, 92, 160]];
const REL_CN = ["我", "下家", "对家", "上家"];

function windIndexOf(snap) {
    return Math.max(0, Math.min(3, (snap.roundWind == null ? 0 : snap.roundWind) - 27));
}
function seatWindOf(snap, seat) {
    return (windIndexOf(snap) + (seat - (snap.dealer || 0) + 4) % 4) % 4;
}

// 头像是画出来的：彩色底板 + 人形剪影；名字头一个字有点阵就改用那个字，认人更快
function drawAvatar(cv, x, y, size, s, seat, windChar, dealer) {
    const tint = AVATAR_TINT[seat] || AVATAR_TINT[0];
    const top = s.out ? A.mix(tint, [88, 88, 104], 0.6) : tint;
    roundRect(cv, x - 2, y - 2, size + 4, size + 4, 12, dealer ? PAL.goldDim : PAL.barEdge);
    roundRect(cv, x, y, size, size, 10, A.mix(top, [0, 0, 0], 0.3));
    gradRect(cv, x + 1, y + 1, size - 2, size - 2, 9,
        A.mix(top, [255, 255, 255], 0.14), A.mix(top, [0, 0, 0], 0.45));

    // 机器人名字都是「机器人X」，取最后那个字才分得清甲/乙/丙/丁；人名的第一个字就是标识
    const nm = String(s.name || "");
    const first = (nm.startsWith("机器人") && nm.length > 3 ? nm.slice(3, 4) : nm.slice(0, 1));
    if (first && A.hasGlyph(first)) {
        const g = Math.round(size * 0.5);
        cv.circle(x + Math.round(size / 2), y + Math.round(size / 2), Math.round(size * 0.34),
            A.mix(top, [0, 0, 0], 0.32));
        A.drawGlyph(cv, first, x + Math.round((size - g) / 2), y + Math.round((size - g) / 2), g, [255, 246, 226]);
    } else {
        const light = A.mix(top, [255, 255, 255], 0.66);
        const cxx = x + Math.round(size / 2);
        cv.circle(cxx, y + Math.round(size * 0.36), Math.round(size * 0.15), light);
        const bw = Math.round(size * 0.5), bh = Math.round(size * 0.34);
        roundRect(cv, cxx - Math.round(bw / 2), y + Math.round(size * 0.58), bw, bh, Math.round(bw / 3), light);
    }

    // 头像右下角挂风位，庄家用金底
    const bx = x + size - 9, by = y + size - 9;
    cv.circle(bx, by, 12, A.mix(PAL.panel, [0, 0, 0], 0.5));
    cv.circle(bx, by, 11, dealer ? PAL.mark : PAL.panelEdge);
    A.drawGlyph(cv, windChar, bx - 7, by - 7, 14, dealer ? [255, 255, 255] : PAL.white);
}

// 左右两家立着的卡片：头像居中，名字/点数/状态竖着排
function drawSideCard(cv, snap, seat, pos) {
    const s = snap.seats[seat];
    const r = SIDE_BOX[pos];
    const isYou = seat === snap.seatOfUser;
    const isTurn = snap.turn === seat && snap.phase !== "round-over" && !s.out;
    roundRect(cv, r.x, r.y, CARD_SIDE.w, CARD_SIDE.h, 10, isTurn ? PAL.gold : PAL.barEdge);
    roundRect(cv, r.x + 1, r.y + 1, CARD_SIDE.w - 2, CARD_SIDE.h - 2, 9, isTurn ? PAL.panelTurn : PAL.bar);

    drawAvatar(cv, r.x + Math.round((CARD_SIDE.w - 52) / 2), r.y + 6, 52, s, seat,
        WIND_CHARS[seatWindOf(snap, seat)], seat === snap.dealer);

    centerText(cv, REL_CN[pos], r.x + Math.round(CARD_SIDE.w / 2), r.y + 62, 10, isYou ? PAL.gold : PAL.dim);
    const nm = showable(s.name, 5);
    if (nm) centerText(cv, nm, r.x + Math.round(CARD_SIDE.w / 2), r.y + 76, 12, isYou ? PAL.gold : PAL.white);

    const score = String(s.score);
    const scoreColor = s.score < 0 ? PAL.mark : PAL.gold;
    const unit = snap.mode.unit || "";
    const sw = strWidth(score, 14) + (unit ? strWidth(unit, 10) + 2 : 0);
    const sx = Math.round(r.x + (CARD_SIDE.w - sw) / 2);
    drawStr(cv, score, sx, r.y + 92, 14, scoreColor);
    if (unit) drawStr(cv, unit, sx + strWidth(score, 14) + 2, r.y + 94, 10, scoreColor);

    // 卡片底下一排：立直/和了/缺门，剩几张牌压在最底下
    let px = r.x + 6;
    const py = r.y + 112;
    if (s.riichi) px += pill(cv, px, py, "立直", 10, [255, 255, 255], PAL.mark,
        A.lerp(PAL.mark, [255, 255, 255], 0.4)) + 3;
    if (s.out) px += pill(cv, px, py, s.win && s.win.selfDrawn ? "自摸" : "和", 10, PAL.goldDark, PAL.gold,
        A.lerp(PAL.gold, [255, 255, 255], 0.3)) + 3;
    if (s.queSuit) pill(cv, px, py, "缺" + SUIT_SHORT[s.queSuit], 10, PAL.white, PAL.pill, PAL.pillEdge);

    const cnt = String(s.handCount);
    const cw = strWidth(cnt, 10) + 10;
    const bx = Math.round(r.x + (CARD_SIDE.w - cw) / 2);
    const by = r.y + CARD_SIDE.h - 18;
    roundRect(cv, bx - 4, by, cw + 8, 16, 5, PAL.barEdge);
    roundRect(cv, bx - 3, by + 1, cw + 6, 14, 4, A.mix(PAL.bar, [0, 0, 0], 0.3));
    drawStr(cv, cnt, bx, by + 4, 10, PAL.dim);
}

function drawCard(cv, snap, seat, pos) {
    if (pos === 1 || pos === 3) return drawSideCard(cv, snap, seat, pos);
    const s = snap.seats[seat];
    const r = CARD_BOX[pos];
    const isYou = seat === snap.seatOfUser;
    const isTurn = snap.turn === seat && snap.phase !== "round-over" && !s.out;
    roundRect(cv, r.x, r.y, CARD.w, CARD.h, 10, isTurn ? PAL.gold : PAL.barEdge);
    roundRect(cv, r.x + 1, r.y + 1, CARD.w - 2, CARD.h - 2, 9, isTurn ? PAL.panelTurn : PAL.bar);

    drawAvatar(cv, r.x + 10, r.y + 10, 56, s, seat, WIND_CHARS[seatWindOf(snap, seat)], seat === snap.dealer);

    const tx = r.x + 76;
    drawStr(cv, REL_CN[pos], tx, r.y + 8, 11, isYou ? PAL.gold : PAL.dim);
    const nm = showable(s.name, 5);
    if (nm) drawStr(cv, nm, tx, r.y + 24, 13, isYou ? PAL.gold : PAL.white);

    // 分数：数字走 8x8 点阵（比汉字笔画细），单位字号降一档才不显得头重脚轻
    const score = String(s.score);
    const scoreColor = s.score < 0 ? PAL.mark : PAL.gold;
    drawStr(cv, score, tx, r.y + 44, 15, scoreColor);
    if (snap.mode.unit) drawStr(cv, snap.mode.unit, tx + strWidth(score, 15) + 2, r.y + 46, 11, scoreColor);
    // 剩几张牌做成右上角的小胶囊，别去压头像
    const cnt = String(s.handCount) + "张";
    const cw = strWidth(cnt, 10) + 10;
    const cx0 = r.x + CARD.w - cw - 8;
    roundRect(cv, cx0, r.y + 8, cw, 16, 5, PAL.barEdge);
    roundRect(cv, cx0 + 1, r.y + 9, cw - 2, 14, 4, A.mix(PAL.bar, [0, 0, 0], 0.3));
    drawStr(cv, cnt, cx0 + 5, r.y + 12, 10, PAL.dim);

    let bx = r.x + 10;
    if (s.riichi) bx += pill(cv, bx, r.y + 66, "立直", 12, [255, 255, 255], PAL.mark,
        A.lerp(PAL.mark, [255, 255, 255], 0.4)) + 4;
    if (s.out) bx += pill(cv, bx, r.y + 66, s.win && s.win.selfDrawn ? "自摸" : "和", 12, PAL.goldDark, PAL.gold,
        A.lerp(PAL.gold, [255, 255, 255], 0.3)) + 4;
    if (s.queSuit) pill(cv, bx, r.y + 66, "缺" + SUIT_SHORT[s.queSuit], 12, PAL.white, PAL.pill, PAL.pillEdge);
}

// ---------- 牌河 ----------
function drawRiver(cv, snap, seat, pos) {
    const river = snap.seats[seat].river;
    const cap = RIVER.cols * RIVER.rows;
    river.slice(0, cap).forEach((t, i) => {
        const p = riverSlot(pos, i);
        drawTile(cv, p.x, p.y, t, { w: RIVER.w, h: RIVER.h });
    });
    if (river.length > cap) {
        const p = riverSlot(pos, cap - 1);
        drawStr(cv, "+" + (river.length - cap), p.x + RIVER.w + 4, p.y + 12, 15, PAL.dim);
    }
    // 刚打的那张：红括号卡在四个角，扫一眼就知道这巡发生了什么
    if (river.length) {
        const p = riverSlot(pos, Math.min(river.length, cap) - 1);
        markLast(cv, p.x, p.y, RIVER.w, RIVER.h);
    }
}

// 最后一手：红括号卡在四个角
function markLast(cv, x, y, w, h) {
    const len = Math.max(4, Math.round(w * 0.3));
    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            const cx = x + (sx < 0 ? -1 : w), cy = y + (sy < 0 ? -1 : h);
            cv.lineH(cy, Math.min(cx, cx + sx * len), Math.max(cx, cx + sx * len), PAL.mark);
            cv.lineV(cx, Math.min(cy, cy + sy * len), Math.max(cy, cy + sy * len), PAL.mark);
        }
    }
}

// ---------- 副露 ----------
function drawMelds(cv, snap, seat, pos) {
    const s = snap.seats[seat];
    const used = s.melds.reduce((n, m) => n + 1 + m.tiles.length, 0);
    if (!used) return;
    const lay = meldLayout(pos, used);
    let slot = 0;
    const place = (spec) => {
        const row = Math.floor(slot / lay.per), col = slot % lay.per;
        drawTile(cv, lay.x + col * (MELD.w + MELD.gap), lay.y + row * (MELD.h + MELD.gap),
            spec, { w: MELD.w, h: MELD.h });
        slot++;
    };
    for (const m of s.melds) {
        const badge = m.type === "pon" ? "碰" : m.type === "chi" ? "吃" : m.concealed ? "暗" : "杠";
        place({ badge: badge });
        for (const id of m.tiles) place({ id: id, red: (m.reds || []).includes(id) });
    }
}

// ---------- 顶部信息条 ----------
function drawHeader(cv, snap) {
    roundRect(cv, HDR.x, HDR.y, HDR.w, HDR.h, 8, PAL.barEdge);
    gradRect(cv, HDR.x + 1, HDR.y + 1, HDR.w - 2, HDR.h - 2, 7, PAL.bar, A.mix(PAL.bar, [0, 0, 0], 0.4));

    const modeName = showable(snap.mode.name, 6) || String(snap.mode.id || "").toUpperCase();
    let x = HDR.x + 8;
    x += pill(cv, x, HDR.y + 8, modeName, 15, PAL.gold, A.mix(PAL.bar, [0, 0, 0], 0.35), PAL.goldDim) + 10;
    drawStr(cv, "第 " + snap.round + " 局", x, HDR.y + 12, 16, PAL.white);
    x += strWidth("第 " + snap.round + " 局", 16) + 14;
    drawStr(cv, "余 " + snap.wall, x, HDR.y + 12, 16, PAL.dim);
    x += strWidth("余 " + snap.wall, 16) + 14;
    if (snap.sticks) { drawStr(cv, "立直棒 " + snap.sticks, x, HDR.y + 12, 16, PAL.mark); x += strWidth("立直棒 " + snap.sticks, 16) + 14; }

    // 宝牌指示牌：只有日麻有死牌区，血战/广东这块不画
    // 从右往左一次算准：[里][里牌][宝牌][宝牌牌面]，各块之间留固定间距，省得叠字
    if (snap.dora && snap.dora.length) {
        const ura = (snap.ura || []).slice(0, 2);
        let dx = HDR.x + HDR.w - 8;
        const doraX = [];
        snap.dora.forEach(() => { dx -= TAG.w; doraX.push(dx); dx -= TAG.gap; });
        dx -= 5;
        const doraLabel = dx - strWidth("宝牌", 15);
        dx = doraLabel - 10;
        const uraX = [];
        let uraLabel = 0;
        if (ura.length) {
            ura.forEach(() => { dx -= TAG.w; uraX.push(dx); dx -= TAG.gap; });
            dx -= 5;
            uraLabel = dx - strWidth("里", 15);
        }
        if (ura.length) {
            drawStr(cv, "里", uraLabel, HDR.y + 13, 15, PAL.dim);
            uraX.forEach((tx) => drawTile(cv, tx, HDR.y + 4, { back: true }, { w: TAG.w, h: TAG.h }));
        }
        drawStr(cv, "宝牌", doraLabel, HDR.y + 13, 15, PAL.dim);
        doraX.forEach((tx, i) => drawTile(cv, tx, HDR.y + 4, { id: snap.dora[i], red: false }, { w: TAG.w, h: TAG.h, mark: "dora" }));
    }
}

// ---------- 自己的手牌 ----------
function ownSeat(snap) {
    return snap.seatOfUser == null ? null : snap.seats[snap.seatOfUser];
}
function handRows(snap) {
    const s = ownSeat(snap);
    return s && s.hand.length ? Math.ceil(s.hand.length / HAND.cols) : 0;
}
function waitsRows(snap) {
    const s = ownSeat(snap);
    return s && s.waits && s.waits.length ? 1 : 0;
}
function handBlockHeight(snap) {
    if (!ownSeat(snap)) return 0;
    return 20 + handRows(snap) * (HAND.h + 4) + (waitsRows(snap) ? TAG.h + 8 : 0);
}
function revealBlockHeight(snap) {
    const rows = revealedSeats(snap);
    return rows.length ? 24 + rows.length * (REVEAL.h + 6) : 0;
}
function canvasHeight(snap) {
    return HAND_Y + handBlockHeight(snap) + revealBlockHeight(snap) + 8;
}

function drawOwnHand(cv, snap, y0) {
    const s = ownSeat(snap);
    if (!s) return;
    let y = y0;
    const label = "我 手牌 " + s.handCount + " 张";
    drawStr(cv, label, 16, y, 15, PAL.gold);
    if (snap.drawn && snap.turn === snap.seatOfUser) {
        drawStr(cv, "刚摸 " + T.tileName(snap.drawn.id), 16 + strWidth(label, 15) + 16, y, 15, PAL.mark);
    }
    y += 20;

    const total = Math.min(HAND.cols, s.hand.length) * (HAND.w + HAND.gap) - HAND.gap;
    const x0 = Math.round((W - total) / 2);
    s.hand.forEach((t, i) => {
        const col = i % HAND.cols, row = Math.floor(i / HAND.cols);
        // 刚摸的那张隔开一格，一眼看出哪张是这巡摸的
        const gap = snap.drawn && snap.turn === snap.seatOfUser && i === s.hand.length - 1 ? 10 : 0;
        drawTile(cv, x0 + col * (HAND.w + HAND.gap) + gap, y + row * (HAND.h + 4), t, { w: HAND.w, h: HAND.h });
    });
    if (!s.hand.length) centerText(cv, "没牌", CX, y + 16, 16, PAL.dim);
    y += handRows(snap) * (HAND.h + 4) + 2;

    // 待牌直接画小牌：听牌最多 11 种，写成牌名一长串反而看不出是什么
    if (s.waits && s.waits.length) {
        drawStr(cv, "听", x0 - strWidth("听", 15) - 8, y + 8, 15, PAL.mark);
        s.waits.forEach((id, i) => {
            drawTile(cv, x0 + i * (TAG.w + TAG.gap), y, { id: id, red: false }, { w: TAG.w, h: TAG.h });
        });
    }
}

// 结算亮牌：四个方位各一排，摆在桌子下面，谁也不压谁的牌河
function drawRevealBlock(cv, snap, y0) {
    const rows = revealedSeats(snap);
    if (!rows.length) return;
    let y = y0;
    // 「明」在这个点阵字号下笔画最密，字号给大一档才分得清
    drawStr(cv, "明牌", 16, y, 18, PAL.gold);
    y += 24;
    for (const s of rows) {
        const nm = showable(s.name, 6) || "";
        drawStr(cv, SEAT_CN[s.seat] + "家 " + nm, 16, y + 5, 13, PAL.white);
        const x0 = 132;
        s.hand.forEach((t, i) => {
            drawTile(cv, x0 + i * (REVEAL.w + REVEAL.gap), y, t, { w: REVEAL.w, h: REVEAL.h });
        });
        y += REVEAL.h + 6;
    }
}

function renderImage(snap) {
    const H = canvasHeight(snap);
    const cv = new Canvas(W, H, PAL.bg);
    drawTable(cv);
    drawHeader(cv, snap);
    drawCenter(cv, snap);
    for (let pos = 0; pos < 4; pos++) {
        const seat = seatAtPos(snap, pos);
        const s = snap.seats[seat];
        if (!s || !s.name) continue;
        drawRiver(cv, snap, seat, pos);
        drawMelds(cv, snap, seat, pos);
        drawCard(cv, snap, seat, pos);
    }
    drawOwnHand(cv, snap, HAND_Y);
    drawRevealBlock(cv, snap, HAND_Y + handBlockHeight(snap));
    return cv.toBuffer().toString("base64");
}

// ---------- 文字兜底 ----------
// 图上发不出去（比如某些客户端不收 base64）时用；牌名和 cc状态 保持一致
function renderText(snap) {
    const lines = [];
    lines.push("【" + snap.mode.name + "】第 " + snap.round + " 局　" + snap.honba + " 本棒　余牌 " + snap.wall +
        (snap.sticks ? "　立直棒 " + snap.sticks : ""));
    if (snap.dora && snap.dora.length) lines.push("宝牌指示：" + snap.dora.map(T.tileName).join(" "));
    for (const s of snap.seats) {
        const tag = [s.seat === snap.dealer ? "庄" : "", s.riichi ? "立直" : "", s.out ? "和了" : "",
            s.queSuit ? "缺" + { m: "万", p: "筒", s: "条" }[s.queSuit] : ""].filter(Boolean).join(" ");
        const melds = s.melds.map((m) => {
            const kind = m.type === "pon" ? "碰" : m.type === "chi" ? "吃" : m.concealed ? "暗杠" : "杠";
            return kind + m.tiles.map(T.tileShort).join("");
        }).join(" ");
        const hand = s.hand.length ? s.hand.map((t) => T.tileShort(t.id) + (t.red ? "赤" : "")).join(" ") : s.handCount + " 张";
        lines.push(SEAT_CN[s.seat] + "家" + (s.seat === snap.seatOfUser ? "(我)" : "") + " " +
            s.name + (tag ? " [" + tag + "]" : "") + " " + s.score + snap.mode.unit);
        lines.push("    手牌：" + hand + (melds ? "　副露：" + melds : ""));
        lines.push("    牌河：" + (s.river.length ? s.river.map((t) => T.tileShort(t.id)).join(" ") : "（空）"));
        if (s.waits && s.waits.length) lines.push("    待牌：" + s.waits.map(T.tileShort).join(" "));
    }
    if (snap.claim) {
        lines.push("→ " + snap.seats[snap.claim.from].name + " 打 " + T.tileName(snap.claim.tile) + "，要表态的已经私聊问了");
    }
    return lines.join("\n");
}

module.exports = { renderImage, renderText, drawStr, strWidth, COLOR: PAL, TW: HAND.w, TH: HAND.h };
