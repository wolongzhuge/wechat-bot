"use strict";
// 麻将牌面绘制：把一张牌画成「有圆角、有厚度、有花色」的实体牌，观感照雀魂那套来。
// 关键区别不再用文字牌面：筒子画圆点、条子画竹节、万子画「数字 + 萬」、字牌画字、白板画框。
// 手搓 PNG 没有 alpha 通道，所以阴影/渐变全用「预先算好的实色」画，靠调色板撑出质感。

const T = require("./tiles");
const { GLYPHS } = require("./glyphs");

const GLYPH_ALIAS = { "万": "萬" };
const glyphRows = (ch) => GLYPHS[GLYPH_ALIAS[ch] || ch];
const hasGlyph = (ch) => !!glyphRows(ch);

// 32x32 点阵缩到目标尺寸：一个目标像素覆盖 32/size 个源像素，「块里有点就算有」。
// 最近邻抽样会整行整列丢笔画（麻、萬这种密字直接少一半），缩图宁可糊也不能缺笔。
function drawGlyph(cv, ch, x, y, size, color) {
    const rows = glyphRows(ch);
    if (!rows) return false;
    for (let py = 0; py < size; py++) {
        const sy0 = Math.floor((py * 32) / size);
        const sy1 = Math.max(sy0 + 1, Math.floor(((py + 1) * 32) / size));
        for (let px = 0; px < size; px++) {
            const sx0 = Math.floor((px * 32) / size);
            const sx1 = Math.max(sx0 + 1, Math.floor(((px + 1) * 32) / size));
            let on = false;
            for (let sy = sy0; sy < sy1 && !on; sy++) {
                const row = rows[sy];
                if (!row) continue;
                for (let sx = sx0; sx < sx1; sx++) if (row & (1 << (31 - sx))) { on = true; break; }
            }
            if (on) cv.dot(x + px, y + py, color);
        }
    }
    return true;
}


const PAL = {
    // 桌面：雀魂那张蓝布方桌。中心被灯打亮、四角压暗，外面再套一圈木边。
    // 颜色是从 game.maj-soul.com 的实机截图上取的（scripts/pngread.js + probe-majsoul-pts.js）
    bg: [10, 10, 22],
    wood: [122, 72, 42], woodDark: [72, 40, 24], woodLit: [166, 116, 80],
    table0: [65, 97, 164], table1: [41, 69, 118], table2: [24, 44, 80],
    tableLine: [86, 120, 178],
    panel: [54, 48, 63], panelEdge: [92, 90, 102], panelTurn: [78, 72, 92],
    shadow: [10, 18, 36],
    // 牌：白面 + 一整圈橙边、上沿最厚，就是雀魂那句「看得见牌的侧厚度」
    tileTop: [252, 250, 244], tileBot: [224, 220, 206], tileEdge: [78, 74, 68],
    tileShade: [200, 196, 182],
    tileRim: [255, 168, 58], tileRimDark: [207, 128, 33],
    tileBackTop: [244, 152, 41], tileBackBot: [200, 122, 28], tileBackEdge: [140, 82, 16],
    redTileTop: [255, 246, 240], redTileBot: [242, 216, 206],
    ink: [26, 38, 64], red: [148, 24, 24], green: [24, 110, 60], blue: [30, 86, 160],
    gold: [244, 205, 112], goldDark: [92, 62, 8], goldDim: [200, 152, 60],
    white: [240, 244, 250], dim: [150, 168, 200], mark: [236, 84, 68],
    pill: [30, 32, 58], pillEdge: [96, 96, 134],
    bar: [26, 28, 52], barEdge: [74, 76, 116],
};

const lerp = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
];
const mix = lerp;

// 圆角矩形实心填充（逐行算左右缩进，不需要 alpha）
function roundRect(cv, x, y, w, h, r, color) {
    r = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    for (let i = 0; i < h; i++) {
        let inset = 0;
        const dy = i < r ? r - i : (i >= h - r ? r - (h - 1 - i) : -1);
        if (dy >= 0) inset = Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
        cv.lineH(y + i, x + inset, x + w - 1 - inset, color);
    }
}

// 圆角矩形描边：内外各画一次，靠「外色 - 内色」叠出一圈边
function roundRectBorder(cv, x, y, w, h, r, color) {
    roundRect(cv, x, y, w, h, r, color);
}

// 带渐变的圆角矩形（上浅下深），牌身/面板都用它
function gradRect(cv, x, y, w, h, r, top, bot) {
    r = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
    for (let i = 0; i < h; i++) {
        let inset = 0;
        const dy = i < r ? r - i : (i >= h - r ? r - (h - 1 - i) : -1);
        if (dy >= 0) inset = Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
        cv.lineH(y + i, x + inset, x + w - 1 - inset, lerp(top, bot, h > 1 ? i / (h - 1) : 0));
    }
}

// 桌面底：中间亮、四角暗的假径向（按到中心的距离逐行逐段插值，够用且快）
function paintFelt(cv, x, y, w, h) {
    const cx = x + w / 2, cy = y + h / 2, mr = Math.hypot(w / 2, h / 2);
    for (let py = y; py < y + h; py++) {
        for (let px = x; px < x + w; px++) {
            const d = Math.hypot(px - cx, py - cy) / mr;
            const t = Math.min(1, d * 1.15);
            cv.dot(px, py, t < 0.55 ? lerp(PAL.table0, PAL.table1, t / 0.55) : lerp(PAL.table1, PAL.table2, (t - 0.55) / 0.45));
        }
    }
}

// 木边：四道梯形条，靠「上亮下暗」假装有一圈倒角
function woodFrame(cv, x, y, w, h, t) {
    cv.rect(x, y, x + w - 1, y + t - 1, PAL.woodLit);
    cv.rect(x, y + h - t, x + w - 1, y + h - 1, PAL.woodDark);
    cv.rect(x, y, x + t - 1, y + h - 1, PAL.wood);
    cv.rect(x + w - t, y, x + w - 1, y + h - 1, PAL.wood);
    cv.lineH(y + t - 1, x, x + w - 1, PAL.woodDark);
    cv.lineH(y + h - t, x, x + w - 1, PAL.woodLit);
    cv.lineV(x + t - 1, y, y + h - 1, PAL.woodDark);
    cv.lineV(x + w - t, y, y + h - 1, PAL.woodLit);
}

// 切角方盘（雀魂中央信息盘、房间牌都是这个轮廓）：逐行算左右缩进，不需要 alpha
function octagon(cv, x, y, w, h, cut, color) {
    cut = Math.max(0, Math.min(cut, Math.floor(Math.min(w, h) / 2)));
    for (let i = 0; i < h; i++) {
        const inset = i < cut ? cut - i : (i >= h - cut ? i - (h - cut) + 1 : 0);
        cv.lineH(y + i, x + inset, x + w - 1 - inset, color);
    }
}

// ---------- 花色 ----------
// 筒：圆点阵。传统配色（1 筒大圆、9 筒三行红绿蓝）照抄，一眼能数清。
const PIN_POS = {
    1: [[.5, .5]],
    2: [[.5, .30], [.5, .70]],
    3: [[.26, .22], [.5, .5], [.74, .78]],
    4: [[.30, .30], [.70, .30], [.30, .70], [.70, .70]],
    5: [[.28, .26], [.72, .26], [.5, .5], [.28, .74], [.72, .74]],
    6: [[.30, .22], [.70, .22], [.30, .5], [.70, .5], [.30, .78], [.70, .78]],
    7: [[.24, .16], [.5, .24], [.76, .32], [.30, .60], [.70, .60], [.30, .84], [.70, .84]],
    8: [[.30, .16], [.70, .16], [.30, .39], [.70, .39], [.30, .62], [.70, .62], [.30, .85], [.70, .85]],
    9: [[.22, .20], [.5, .20], [.78, .20], [.22, .5], [.5, .5], [.78, .5], [.22, .80], [.5, .80], [.78, .80]],
};
const PIN_COL = {
    1: ["b"], 2: ["g", "g"], 3: ["b", "r", "g"], 4: ["b", "b", "g", "g"],
    5: ["b", "b", "r", "g", "g"], 6: ["r", "r", "g", "g", "b", "b"],
    7: ["g", "g", "g", "r", "r", "b", "b"], 8: ["b", "b", "g", "g", "g", "g", "r", "r"],
    9: ["r", "r", "r", "g", "g", "g", "b", "b", "b"],
};
const DOT = { r: PAL.red, g: PAL.green, b: PAL.blue };

function paintPin(cv, x, y, w, h, rank, ink) {
    const pos = PIN_POS[rank], cols = PIN_COL[rank];
    if (rank === 1) {
        // 一筒：大圆三重圈，蓝-白-红，小尺寸下也看得出是「一」
        const cx = x + w / 2, cy = y + h / 2, r = Math.max(5, Math.round(w * 0.30));
        cv.circle(cx, cy, r, ink || PAL.blue);
        cv.circle(cx, cy, Math.max(1, r - 2), [255, 255, 255]);
        cv.circle(cx, cy, Math.max(1, r - Math.max(2, Math.round(r * 0.45))), ink || PAL.red);
        return;
    }
    // 点要够大才数得清；牌越小、每行点越少就放得越开
    const r = Math.max(3, Math.round(w * (rank <= 4 ? 0.175 : rank <= 6 ? 0.145 : 0.12)));
    pos.forEach((p, i) => {
        const cx = Math.round(x + p[0] * w), cy = Math.round(y + p[1] * h);
        const base = ink || DOT[cols[i]];
        cv.circle(cx, cy, r, base);
        // 高光：左上偏一点画个浅色小圆，圆点就不像死色块了
        cv.circle(cx - Math.max(0, r >> 1), cy - Math.max(0, r >> 1), Math.max(1, r >> 1), mix(base, [255, 255, 255], 0.55));
    });
}

// 条：竹节。每根一小段竖竹，中间一道亮色节口；一/五/七条按传统点红。
const SOU_ROWS = {
    1: [[1]], 2: [[1], [1]], 3: [[1], [2]], 4: [[2], [2]], 5: [[2], [1], [2]],
    6: [[3], [3]], 7: [[1], [3], [3]], 8: [[3], [2], [3]], 9: [[3], [3], [3]],
};
function paintSou(cv, x, y, w, h, rank, ink) {
    if (rank === 1) {
        // 一条是只鸟，画不成鸟就画一根最粗的红绿竹，比硬凑的图案耐看
        const cx = x + w / 2, sw = Math.max(4, Math.round(w * 0.20));
        stick(cv, cx, y + h * 0.14, y + h * 0.86, sw, ink || PAL.red);
        return;
    }
    const rows = SOU_ROWS[rank];
    const n = rows.length;
    const sw = Math.max(3, Math.round(w * 0.145));
    rows.forEach((row, ri) => {
        const cy = y + h * (n === 1 ? 0.5 : (0.18 + (0.64 * ri) / (n - 1)));
        const cnt = row[0];
        const rowH = (h * 0.5) / n;
        for (let i = 0; i < cnt; i++) {
            const cx = x + w * (cnt === 1 ? 0.5 : (0.24 + (0.52 * i) / (cnt - 1)));
            const red = (rank === 5 && ri === 1) || (rank === 7 && ri === 0) || (rank === 9 && ri === 1);
            stick(cv, cx, cy - rowH * 0.42, cy + rowH * 0.42, sw, ink || (red ? PAL.red : PAL.green));
        }
    });
}
function stick(cv, cx, y0, y1, sw, color) {
    const a = Math.round(y0), b = Math.round(y1);
    cv.rect(Math.round(cx - sw / 2), a, Math.round(cx + sw / 2 - 1), b, color);
    cv.lineV(Math.round(cx - sw / 2), a, b, mix(color, [0, 0, 0], 0.35));
    const mid = Math.round((a + b) / 2);
    cv.lineH(mid, Math.round(cx - sw / 2), Math.round(cx + sw / 2 - 1), mix(color, [255, 255, 255], 0.6));
    cv.lineH(mid + 1, Math.round(cx - sw / 2), Math.round(cx + sw / 2 - 1), mix(color, [255, 255, 255], 0.3));
}

// ---------- 牌 ----------
// tile: {id, red} | {back:true} | {badge:"碰"} | null（背面）
// opt: {w,h,mark:"dora"|"",dim:false}
function drawTile(cv, x, y, tile, opt) {
    const w = (opt && opt.w) || 30, h = (opt && opt.h) || 40;
    const r = Math.max(2, Math.round(w * 0.16));
    const rim = Math.max(3, Math.round(h * 0.13));      // 上沿那道橙边（牌的侧厚度）
    cv.rect(x + 1, y + 3, x + w, y + h + 2, PAL.shadow); // 投影：贴在牌的右下
    if (!tile || tile.back) { drawBack(cv, x, y, w, h, r, rim); return; }
    if (tile.badge) { drawBadge(cv, x, y, w, h, r, tile.badge); return; }

    const red = !!tile.red;
    // 宝牌先铺一圈金 halo，牌身盖在上面，剩下来的就是那 2px 金边
    if (opt && opt.mark === "dora") roundRect(cv, x - 2, y - 2, w + 4, h + 4, r + 2, PAL.gold);
    // 先铺一整圈橙边，再把白面盖在上面：上沿留 rim 厚，四周留 1px
    gradRect(cv, x, y, w, h, r, PAL.tileRim, PAL.tileRimDark);
    gradRect(cv, x + 1, y + rim, w - 2, h - rim - 1, Math.max(1, r - 1),
        red ? PAL.redTileTop : PAL.tileTop, red ? PAL.redTileBot : PAL.tileBot);
    outlineTile(cv, x, y, w, h, r);
    cv.lineH(y + 1, x + r, x + w - 1 - r, mix(PAL.tileRim, [255, 255, 255], 0.5));   // 橙边上的高光

    const fx = x + 2, fy = y + rim + 1, fw = w - 4, fh = h - rim - 3;
    const id = tile.id;
    const ink = red ? PAL.red : null;
    if (T.isNum(id)) {
        const suit = T.suitOf(id), rank = T.rankOf(id);
        if (suit === "p") paintPin(cv, fx, fy, fw, fh, rank, ink);
        else if (suit === "s") paintSou(cv, fx, fy, fw, fh, rank, ink);
        else paintMan(cv, fx, fy, fw, fh, rank, red);
        return;
    }
    if (T.isHonor(id)) { paintHonor(cv, fx, fy, fw, fh, id); return; }
    if (T.isFlower(id)) { paintFlower(cv, fx, fy, fw, fh, id); return; }
    cv.rect(fx, fy, fx + 2, fy + 2, PAL.ink);
}

function outlineTile(cv, x, y, w, h, r) {
    const e = PAL.tileEdge;
    // 上下左右四条边（避开圆角），再补四个角点
    cv.lineH(y, x + r, x + w - 1 - r, e);
    cv.lineH(y + h - 1, x + r, x + w - 1 - r, e);
    cv.lineV(x, y + r, y + h - 1 - r, e);
    cv.lineV(x + w - 1, y + r, y + h - 1 - r, e);
    for (const [sx, sy] of [[r, r], [w - 1 - r, r], [r, h - 1 - r], [w - 1 - r, h - 1 - r]]) {
        cv.dot(x + sx, y + sy, e);
    }
}

function drawBack(cv, x, y, w, h, r, rim) {
    gradRect(cv, x, y, w, h, r, PAL.tileBackTop, PAL.tileBackBot);
    cv.lineH(y + 1, x + r, x + w - 1 - r, mix(PAL.tileBackTop, [255, 255, 255], 0.55));
    cv.lineH(y + h - 1, x + r, x + w - 1 - r, PAL.tileBackEdge);
    // 牌背下沿那一线白，是「这张牌立着」的边，雀魂墙牌就是这么画的
    cv.rect(x + 1, y + h - rim, x + w - 2, y + h - 2, mix(PAL.tileBackBot, [255, 250, 240], 0.62));
    outlineTile(cv, x, y, w, h, r);
}

function drawBadge(cv, x, y, w, h, r, ch) {
    roundRect(cv, x, y + 2, w, h - 6, r, PAL.pill);
    roundRect(cv, x + 1, y + 3, w - 2, h - 8, Math.max(1, r - 1), PAL.pillEdge);
    const size = Math.min(w - 6, h - 12);
    drawGlyph(cv, ch, x + Math.round((w - size) / 2), y + Math.round((h - size) / 2) - 1, size, PAL.white);
}

// 万：上中文数字（墨蓝）下「萬」（朱红），赤五整张红
function paintMan(cv, x, y, w, h, rank, red) {
    const g = T.NUM_CHARS[rank - 1];
    const size = Math.min(Math.round(w * 0.80), Math.round(h * 0.42));
    const color = red ? PAL.red : PAL.ink;
    drawGlyph(cv, g, x + Math.round((w - size) / 2), y + Math.round(h * 0.04), size, color);
    drawGlyph(cv, "萬", x + Math.round((w - size) / 2), y + h - size - Math.round(h * 0.04), size, PAL.red);
}

function paintHonor(cv, x, y, w, h, id) {
    const ch = T.HONOR_NAMES[id - 27];
    if (id === 33) {   // 白板：画框不画字，传统写法
        const e = PAL.blue;
        cv.rect(x + 2, y + 1, x + w - 3, y + h - 2, e);
        cv.rect(x + 4, y + 3, x + w - 5, y + h - 4, [255, 255, 255]);
        return;
    }
    const color = id === 31 ? PAL.red : id === 32 ? PAL.green : PAL.ink;
    const size = Math.min(Math.round(w * 0.88), Math.round(h * 0.64));
    drawGlyph(cv, ch, x + Math.round((w - size) / 2), y + Math.round((h - size) / 2), size, color);
}

const FLOWER_COL = [PAL.green, PAL.red, PAL.blue, PAL.ink, PAL.red, PAL.green, PAL.ink, PAL.blue];
function paintFlower(cv, x, y, w, h, id) {
    const size = Math.min(Math.round(w * 0.78), Math.round(h * 0.58));
    drawGlyph(cv, T.FLOWER_NAMES[id - 34], x + Math.round((w - size) / 2), y + Math.round((h - size) / 2), size, FLOWER_COL[(id - 34) % 8]);
}

module.exports = { PAL, lerp, mix, roundRect, gradRect, octagon, paintFelt, woodFrame, drawTile,
    drawGlyph, hasGlyph, paintPin, paintSou };
