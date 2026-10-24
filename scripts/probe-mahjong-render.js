"use strict";
// 麻将渲染的离线探针：把一局牌推到「有副露 / 有立直 / 有声明窗口 / 结算亮牌」这些状态，
// 每个状态存一张 PNG 到 scripts/out/，人眼看一眼前端才能判断牌河清不清楚。
// 顺带把渲染时用到的汉字和 glyphs.js 的字模对一遍，缺字直接报出来（缺字在图上是空白）。
//
// 跑法：node scripts/probe-mahjong-render.js [riichi|sichuan|gd] [seed]
// 注意：只 require command/mahjong/*，绝不 require app.js（会抢 Sync 游标 = 掉线）。

const fs = require("fs");
const path = require("path");

const glyphs = require("../command/mahjong/glyphs");
const missingGlyphs = new Set();
glyphs.GLYPHS = new Proxy(glyphs.GLYPHS, {
    get(target, key) {
        // 只盯汉字：数字/字母/标点走 png.js 那套 8x8，本来就不在这张表里
        if (typeof key === "string" && key.charCodeAt(0) > 0x2000 && !(key in target)) missingGlyphs.add(key);
        return target[key];
    },
});

const T = require("../command/mahjong/tiles");
const { MahjongGame } = require("../command/mahjong/game");
const R = require("../command/mahjong/render");

const OUT = path.join(__dirname, "out");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const HUMAN = "u1";
function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function save(tag, b64) {
    const file = path.join(OUT, tag + ".png");
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    console.log("  写出 " + path.relative(process.cwd(), file) + "  " + (fs.statSync(file).size) + " 字节");
}

function meldCount(game) {
    return game.seats.reduce((a, s) => a + s.melds.length, 0);
}
function anyRiichi(game) {
    return game.seats.some((s) => s.riichi);
}

function drive(modeId, seed) {
    const game = new MahjongGame({ modeId, rng: lcg(seed) });
    game.addPlayer(HUMAN, "小明");
    game.start();

    const base = modeId + "-" + seed;
    let shots = 0;
    const snap = () => game.snapshot(game.seatOf(HUMAN));
    const grab = (why) => {
        shots++;
        save(base + "-" + shots + "-" + why, R.renderImage(snap()));
    };

    grab("start");
    let steps = 0;
    let lastMelds = 0;
    let sawClaim = false;
    let sawRiichi = false;
    while (steps++ < 3000) {
        if (game.phase === "que") {
            const seat = game.seatOf(HUMAN);
            const ids = game.concealedIds(seat);
            const per = { m: 0, p: 0, s: 0 };
            for (const id of ids) { const su = T.suitOf(id); if (su) per[su]++; }
            const suit = per.m <= per.p && per.m <= per.s ? "m" : per.p <= per.s ? "p" : "s";
            const r = game.setQueBy(HUMAN, suit);
            if (!r.ok) { console.log("  定缺失败：" + r.hint); break; }
            continue;
        }
        if (game.phase === "claim") {
            if (!sawClaim) { sawClaim = true; grab("claim"); }
            const r = game.claimBy(HUMAN, { claim: "pass" });
            if (!r.ok) { console.log("  声明失败：" + r.hint); break; }
            continue;
        }
        if (game.phase === "round-over") { grab("over"); break; }
        const seat = game.seatOf(HUMAN);
        if (game.turn === seat && !game.seats[seat].out) {
            if (!sawRiichi && anyRiichi(game)) { sawRiichi = true; grab("riichi"); }
            const ids = game.concealedIds(seat);
            const que = game.seats[seat].queSuit;
            // 血战必须先打光缺门（引擎按规则拒收别的）；平时打刚摸的那张，牌河才像真人打的
            const queTiles = que ? ids.filter((id) => T.suitOf(id) === que) : [];
            const order = queTiles.length ? queTiles.reverse() : ids.slice().reverse();
            let r = null;
            for (const id of order) {
                r = game.discardBy(HUMAN, id);
                if (r.ok) break;
            }
            if (!r || !r.ok) { console.log("  打不出去：" + (r ? r.hint : "手里没牌")); break; }
            const m = meldCount(game);
            if (m - lastMelds >= 3) { lastMelds = m; grab("melds"); }
            continue;
        }
        // 轮到机器人：引擎里机器人是就地打完的，走到这里说明状态卡住了
        console.log("  卡住了：" + game.phase + " / 轮到 " + game.turn + " / " + game.statusText().replace(/\n/g, " / "));
        break;
    }
    fs.writeFileSync(path.join(OUT, base + "-text.txt"), R.renderText(snap()), "utf8");
    return { shots, steps };
}

const modeArg = process.argv[2] || "riichi";
const seedArg = Number(process.argv[3] || 3);
const modes = modeArg === "all" ? ["riichi", "sichuan", "gd"] : [modeArg];
for (const m of modes) {
    console.log("== " + m + " seed " + seedArg);
    const r = drive(m, seedArg);
    console.log("  出图 " + r.shots + " 张，推进 " + r.steps + " 步");
}
// 文字盘面的汉字不需要字模，只有图里画的才算
console.log(missingGlyphs.size ? "缺字模：" + [...missingGlyphs].join(" ") : "字模齐全");
process.exit(missingGlyphs.size ? 1 : 0);
