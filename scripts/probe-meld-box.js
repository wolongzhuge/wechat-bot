"use strict";
// 临时探针：照着 probe-mahjong-render.js 的推牌过程，在抓「melds」那张图的同一时刻
// 打印每家副露、牌河、卡片按 render.js 当前常量算出来的落点，用来核对图里看到的牌到底是谁的。
const { MahjongGame } = require("../command/mahjong/game");
const T = require("../command/mahjong/tiles");

function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const HUMAN = "u1";
const RIVER = { w: 26, h: 36, gap: 3, cols: 6, rows: 3 };
const MELD = { w: 20, h: 26, gap: 2, perRow: 16 };
const RIVER_BOX = [{ x: 405, y: 494, dx: 1, dy: 1 }, { x: 632, y: 349, dx: 1, dy: 1 },
    { x: 405, y: 282, dx: 1, dy: -1 }, { x: 322, y: 349, dx: -1, dy: 1 }];
const MELD_BOX = [{ x: 405, y: 612 }, { x: 604, y: 297 }, { x: 405, y: 170 }, { x: 20, y: 297 }];
const CARD_BOX = [{ x: 406, y: 642, w: 168, h: 92 }, { x: 838, y: 331, w: 116, h: 150 },
    { x: 406, y: 74, w: 168, h: 92 }, { x: 26, y: 331, w: 116, h: 150 }];

const game = new MahjongGame({ modeId: "riichi", rng: lcg(7) });
game.addPlayer(HUMAN, "小明");
game.start();
const snap = () => game.snapshot(game.seatOf(HUMAN));

let lastMelds = 0;
let shots = 0;
while (shots < 3000) {
    shots++;
    if (game.phase === "claim") { game.claimBy(HUMAN, { claim: "pass" }); continue; }
    if (game.phase === "round-over") { console.log("先到结算了"); break; }
    const seat = game.seatOf(HUMAN);
    if (game.turn === seat) {
        const ids = game.concealedIds(seat);
        let r = null;
        for (const id of ids.slice().reverse()) { r = game.discardBy(HUMAN, id); if (r.ok) break; }
        if (!r || !r.ok) break;
        const m = game.seats.reduce((a, s) => a + s.melds.length, 0);
        if (m - lastMelds >= 3) { lastMelds = m; break; }
    }
}

const s = snap();
const viewer = s.seatOfUser;
console.log("viewer seat " + viewer + "  phase " + s.phase + " turn " + s.turn);
s.seats.forEach((st) => {
    const pos = (st.seat - viewer + 4) % 4;
    const used = st.melds.reduce((n, m) => n + 1 + m.tiles.length, 0);
    const off = Math.max(0, Math.floor((MELD.perRow - used) / 2)) * (MELD.w + MELD.gap);
    const mb = MELD_BOX[pos];
    console.log("seat " + st.seat + " pos " + pos + " " + st.name +
        " | 副露 " + (st.melds.map((m) => m.type + "[" + m.tiles.map((t) => T.tileShort(t)).join("") + "]").join(" ") || "无") +
        " | meld x " + (mb.x + off) + ".." + (mb.x + off + used * (MELD.w + MELD.gap) - MELD.gap) + " y " + mb.y);
    const rb = RIVER_BOX[pos];
    const n = st.river ? st.river.length : 0;
    const lastX = rb.x + (Math.min(n - 1, RIVER.cols - 1)) * (RIVER.w + RIVER.gap) * rb.dx;
    const lastRow = Math.max(0, Math.ceil(n / RIVER.cols) - 1);
    console.log("       牌河 " + n + " 张 x " + Math.min(rb.x, lastX) + ".." + Math.max(rb.x, lastX) + " +" + RIVER.w +
        " y " + Math.min(rb.y, rb.y + lastRow * (RIVER.h + RIVER.gap) * rb.dy) + ".." +
        (Math.max(rb.y, rb.y + lastRow * (RIVER.h + RIVER.gap) * rb.dy) + RIVER.h) +
        " | card " + CARD_BOX[pos].x + "," + CARD_BOX[pos].y + " " + CARD_BOX[pos].w + "x" + CARD_BOX[pos].h);
});
process.exit(0);
