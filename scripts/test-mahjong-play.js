"use strict";
// 麻将状态机的离线自打测试：四个机器人互相打完整局，检查「牌不会凭空多/少、
// 钱不会凭空多/少、流程不崩」。机器人能自打 = 引擎闭环通了，剩下的只是命令层。
//
// 跑法：node scripts/test-mahjong-play.js
// 注意：这个脚本只 require command/mahjong/*，绝不 require app.js，
// 否则会起第二个轮询实例抢 Sync 游标（= 掉线）。

const T = require("../command/mahjong/tiles");
const Rules = require("../command/mahjong/rules");
const { MahjongGame } = require("../command/mahjong/game");

let failed = 0;
let checks = 0;
function check(label, cond, extra) {
    checks++;
    if (cond) { console.log("ok   " + label); return; }
    failed++;
    console.log("FAIL " + label + (extra ? "  <" + extra + ">" : ""));
}
function objs(ids) {
    return ids.map((id) => ({ id, red: false }));
}
function makeGame(modeId, opts) {
    const game = new MahjongGame(Object.assign({ modeId, allowBotsOnly: true }, opts || {}));
    game.addPlayer("u1", "小明");
    return game;
}

// ---------- 不变量 ----------
function census(game) {
    const seen = new Map();
    let total = 0;
    const note = (tile) => {
        total++;
        const id = game.idOf(tile);
        seen.set(id, (seen.get(id) || 0) + 1);
    };
    for (const t of game.wall) note(t);
    for (const t of game.dead) note(t);
    for (const s of game.seats) {
        for (const t of s.hand) note(t);
        for (const t of s.river) note(t);
        for (const m of s.melds) for (const t of m.tiles) note(t);
    }
    return { total, seen };
}
const scoreSum = (game) => game.seats.reduce((a, s) => a + s.score, 0);
// 立直那 1000 点是从玩家账上扣进「池子」的，所以总账要连池子一起算
const moneySum = (game) => scoreSum(game) + game.riichiSticks * 1000;

function handShapeProblem(game) {
    for (const s of game.seats) {
        const n = s.hand.length + 3 * s.melds.length;
        if (n !== 13 && n !== 14) return s.name + " 手里 " + s.hand.length + " 张 + " +
            s.melds.length + " 组副露 = " + n + "（要 13 或 14）";
        const c = T.countsOf(s.hand.map((t) => game.idOf(t)));
        for (let id = 0; id < 34; id++) if (c[id] > 4) return s.name + " 有 " + c[id] + " 张 " + T.tileName(id);
    }
    return null;
}

// ---------- 1. 三种模式各自打 N 局 ----------
// 每局用固定种子发牌：一旦哪局出问题，把 seed 报出来就能原样重放（debug-mahjong-stall.js）
function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function stress(modeId, rounds) {
    const problems = [];
    const stats = { win: 0, draw: 0, melds: 0, kans: 0, riichi: 0, roundsWithEvents: 0, tiles: 0 };
    for (let r = 0; r < rounds; r++) {
        const game = new MahjongGame({ modeId, allowBotsOnly: true, rng: lcg(1000 + r) });   // 纯机器人桌：start() 一路打完一局
        const events = game.start();
        if (game.phase !== "round-over") {
            problems.push("seed " + (1000 + r) + " 没打完，停在 " + game.phase + "（turn=" + game.turn + " 轮到 " +
                (game.seats[game.turn] || {}).name + "，牌墙 " + game.wall.length + "，摸=" + game.idOf(game.drawn) +
                "，手里 " + game.seats.map((s) => s.hand.length).join("/") + "，副露 " +
                game.seats.map((s) => s.melds.map((m) => m.type).join("")).join("|") + "）");
            break;
        }
        const total = census(game).total;
        const want = Rules.buildWall(game.mode).length + game.phantomTiles;
        if (total !== want) {
            problems.push("seed " + (1000 + r) + " 牌数不守恒：" + total + " vs " + want +
                "（含 " + game.phantomTiles + " 张虚牌）");
        }
        for (const [id, n] of census(game).seen) {
            // 一炮多响/多人抢杠时同一枚牌会同时出现在两家手里（phantomTiles 记着有几枚这种分身）
            if (n > 4 + (game.phantomTiles || 0)) problems.push("seed " + (1000 + r) + " " + T.tileName(id) + " 出现 " + n + " 次");
        }
        if (moneySum(game) !== 4 * game.startScore) {
            problems.push("seed " + (1000 + r) + " 点数不守恒：" + moneySum(game) + " vs " + 4 * game.startScore);
        }
        const shape = handShapeProblem(game);
        if (shape) problems.push("seed " + (1000 + r) + " " + shape);
        if (!events.length) problems.push("seed " + (1000 + r) + " 没有任何事件");
        const winners = game.seats.filter((s) => s.out).length;
        if (winners) stats.win++; else stats.draw++;
        stats.melds += game.seats.reduce((a, s) => a + s.melds.length, 0);
        stats.kans += game.seats.reduce((a, s) => a + s.melds.filter((m) => m.type === "kan").length, 0);
        stats.riichi += game.seats.filter((s) => s.riichi).length;
    }
    return { problems, stats };
}

const ROUNDS = Number(process.env.MJ_ROUNDS || 300);
for (const modeId of Rules.ORDER) {
    const res = stress(modeId, ROUNDS);
    const mode = Rules.get(modeId);
    check(mode.name + " " + ROUNDS + " 局自打：能打完、牌数守恒、点数守恒",
        res.problems.length === 0, res.problems.slice(0, 3).join(" | "));
    console.log("     " + mode.name + "：和牌 " + res.stats.win + " 局 / 流局 " + res.stats.draw +
        " 局，副露 " + res.stats.melds + " 组，其中杠 " + res.stats.kans + " 组，立直 " + res.stats.riichi + " 次");
}

// ---------- 2. 血战：定缺流程 ----------
{
    const game = makeGame("sichuan");
    game.start();
    check("血战起手先进入定缺阶段（真人还没定缺）", game.phase === "que", game.phase);
    check("机器人已经自己定好缺", game.seats.filter((s) => s.bot && s.queSuit).length === 3);
    const suit = T.suitOf(game.concealedIds(0)[0]) || "m";
    const r0 = game.discardBy("u1", game.concealedIds(0)[0]);
    check("没定缺就打牌会被拒", !r0.ok && /定缺/.test(r0.hint), r0.hint);
    const r4 = game.setQueBy("u1", "z");
    check("定缺只认万/筒/条", !r4.ok && /只认/.test(r4.hint), r4.hint);
    const r3 = game.setQueBy("u9", "s");
    check("不在桌上的人定不了缺", !r3.ok && /不在这桌上/.test(r3.hint), r3.hint);
    const r5 = game.setQueBy("u1", suit);
    check("定完缺就开打，轮到自己出牌", r5.ok && game.phase === "discard" && game.turn === 0,
        game.phase + " turn=" + game.turn + " / " + (r5.hint || ""));
    const offQue = game.concealedIds(0).find((id) => T.suitOf(id) && T.suitOf(id) !== suit);
    const r1 = game.discardBy("u1", offQue);
    const ev1 = r1.events && r1.events[0];
    check("缺门没打光时只能打缺门那张", !!ev1 && ev1.type === "reject" && /必须先打缺门/.test(ev1.text), JSON.stringify(ev1));
    const queId = game.concealedIds(0).find((id) => T.suitOf(id) === suit);
    const r2 = game.discardBy("u1", queId);
    check("打缺门那张放行", r2.ok && !(r2.events[0] && r2.events[0].type === "reject"), JSON.stringify(r2.events && r2.events[0]));
    check("花猪和不了牌", game.canTsumo(0) === null);
}

// ---------- 3. 立直一体命令：cc三万立直 ----------
{
    const game = makeGame("riichi", { startScore: 25000 });
    game.start();
    // 234m 567m 234p 567p 加一对 5m 单骑东：打 5m 或东都还有听，打 6m 就退回一向听
    game.seats[0].hand = objs([1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 27, 27, 27].slice(0, 13).concat([4]));
    game.turn = 0; game.phase = "discard"; game.drawn = game.seats[0].hand[13];
    const bad = game.riichiBy("u1", 5);
    check("打了还没听牌 → 立直被拒并提示", !bad.ok && /还没听牌/.test(bad.hint), bad.hint);
    const ok = game.riichiBy("u1", 4);
    check("cc五万立直：立直成立且同一命令里把那张打了", ok.ok && game.seats[0].riichi === true, ok.hint);
    check("立直扣 1000 点、桌上多一根棒", game.seats[0].score === 24000 && game.riichiSticks === 1,
        game.seats[0].score + " / 棒 " + game.riichiSticks);
    check("立直事件带着待牌（单骑等东风）", JSON.stringify(ok.events[0].waits) === "[27]", JSON.stringify(ok.events[0].waits));
    check("立直后事件流里有打出那张", ok.events.some((e) => e.type === "discard" && e.tile === 4), JSON.stringify(ok.events.map((e) => e.type)));
    const again = game.riichiBy("u1", 4);
    check("已经立直不能再立直", !again.ok, again.hint);
}

// ---------- 3b. 立直要门清：碰/吃/明杠过的不能立直，暗杠不破门清 ----------
{
    const game = makeGame("riichi", { startScore: 25000 });
    game.start();
    const s = game.seats[0];
    // 碰过红中：手牌 10 张 + 刚摸的东，打东就是单骑听东——牌型没问题，卡在「不门清」
    s.melds = [{ type: "pon", tiles: objs([31, 31, 31]), from: 1, concealed: false }];
    s.hand = objs([0, 1, 2, 12, 13, 14, 24, 25, 26, 27]);
    game.turn = 0; game.phase = "discard"; game.drawn = s.hand[9];
    const no = game.riichiBy("u1", 27);
    check("碰过牌不能立直（立直要门清）", !no.ok && /门清/.test(no.hint), no.hint);
    check("被拒之后没有白扣立直棒", s.score === 25000 && game.riichiSticks === 0 && !s.riichi,
        s.score + " / " + game.riichiSticks);

    const k = makeGame("riichi", { startScore: 25000 });
    k.start();
    const ks = k.seats[0];
    // 暗杠 1 筒（4 张不在手牌里）：手里 11 张，打南就是单骑听东
    ks.melds = [{ type: "kan", tiles: objs([9, 9, 9, 9]), from: null, concealed: true }];
    ks.hand = objs([0, 1, 2, 12, 13, 14, 24, 25, 26, 27, 28]);
    k.turn = 0; k.phase = "discard"; k.drawn = ks.hand[10];
    const ok = k.riichiBy("u1", 28);
    check("暗杠不破门清：暗杠后照样能立直", ok.ok, ok.hint);
    check("暗杠立直的待牌算对（单骑等东）", ok.ok && JSON.stringify(ok.events[0].waits) === "[27]",
        JSON.stringify(ok.events && ok.events[0] && ok.events[0].waits));

    // 暗杠报错会发到群里：只报他打错的那张，「另外还能杠哪张」是手牌信息
    const a = makeGame("riichi");
    a.start();
    const as = a.seats[0];
    as.hand = objs([9, 9, 9, 9, 0, 1, 2, 12, 13, 14, 24, 25, 26]);
    a.turn = 0; a.phase = "discard"; a.drawn = as.hand[12];
    const bad = a.doAnkanBy("u1", 27).events[0].text;
    check("暗杠报错不列「还能杠哪张」", !/能杠的/.test(bad) && !bad.includes(T.tileName(9)), bad);
}

// ---------- 4. 立直后只能摸切 ----------
{
    const game = makeGame("riichi");
    game.start();
    const s = game.seats[0];
    s.hand = objs([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 27]);
    s.riichi = true;
    game.turn = 0; game.phase = "discard";
    game.drawn = { id: 8, red: false };
    s.hand.push(game.drawn);
    const wrong = game.discardBy("u1", 0);
    check("立直家打非刚摸的牌会被拒", !wrong.ok && /只能摸切/.test(wrong.events[0].text), JSON.stringify(wrong.events[0]));
    const right = game.discardBy("u1", 8);
    check("立直家摸切放行", right.ok, right.hint);
    check("摸切的事件标了 tsumogiri", right.events[0].tsumogiri === true, JSON.stringify(right.events[0]));
}

// ---------- 5. 振听 ----------
{
    const game = makeGame("riichi");
    game.start();
    const s = game.seats[0];
    // 234m 567m 234p 567p + 单张 3s：断幺九有役，待牌就是 3s(20)
    s.hand = objs([1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 20]);
    s.river = objs([20]);
    const fu = game.canRon(0, { id: 20, red: false }, 1);
    check("待牌里有自己打过的 → 振听，不能荣和", fu && fu.furiten && fu.by === "own", JSON.stringify(fu));
    s.river = objs([4]);
    const can = game.canRon(0, { id: 20, red: false }, 1);
    check("现物不是待牌时正常能和", can && can.ok && !can.furiten, JSON.stringify(can && can.reason));
    const off = game.canRon(0, { id: 21, red: false }, 1);
    check("待牌以外的牌和不了", off === null, String(off));
}

// ---------- 5b. 真流程：别家打出待牌必须能和 ----------
// 以前同巡振听拿 lastDiscard 当牌河，正在和的那张永远在里面，日麻谁都没和过。
{
    const game = makeGame("riichi");
    game.start();
    const me = game.seats[0];
    me.hand = objs([1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 20]);
    me.river = objs([4]);
    // 另外两家给一手跟 3 条完全无关的牌，免得机器人抢着碰/和把窗口关掉
    for (const i of [2, 3]) {
        game.seats[i].hand = objs([0, 1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 14, 15]);
        game.seats[i].melds = [];
    }
    const from = game.seats[1];
    from.hand = objs([0, 2, 2, 3, 3, 6, 7, 7, 9, 9, 16, 16, 20]);
    from.melds = [];
    game.phase = "discard"; game.turn = 1; game.drawn = from.hand[12];
    game._discard(1, 20);
    const offer = game.claim && game.claim.offers[0];
    check("别家打出待牌会开声明窗口并给 cc和", game.phase === "claim" && offer && !!offer.ron && !offer.furiten,
        JSON.stringify(offer && { ron: offer.ron && offer.ron.label, furiten: offer.furiten }));
    check("声明提示里有 cc和", /cc和/.test(game.claimPrompt(0)), game.claimPrompt(0));

    game.claimBy("u1", { claim: "pass" });
    check("放过的待牌记进同巡振听", game.tempFuriten[0].includes(20), JSON.stringify(game.tempFuriten));
    const now = game.canRon(0, { id: 20, red: false }, 2);
    check("同巡再打同一张不能荣和", now && now.furiten && now.by === "same-turn", JSON.stringify(now));
    game._beginTurn(0);
    check("自己一摸牌同巡振听就清空", game.tempFuriten[0].length === 0, JSON.stringify(game.tempFuriten));
}

// ---------- 6. 碰：牌河挖掉那张、赤牌跟着走 ----------
{
    const game = makeGame("riichi");
    game.start();
    const redFive = { id: 4, red: true };
    game.seats[3].river = [redFive];
    game.seats[0].hand = [redFive, { id: 4, red: false },
        ...objs([0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 27])];
    const before = census(game).total;
    const ev = game._doPon(0, 3, redFive);
    check("碰牌成功", ev.some((e) => e.type === "meld" && e.kind === "pon"), JSON.stringify(ev[0]));
    check("碰完牌河少一张", game.seats[3].river.length === 0);
    const meld = game.seats[0].melds[0];
    check("副露里赤牌标记没丢", meld.tiles.some((t) => t.red === true), JSON.stringify(meld.tiles.map((t) => t)));
    check("碰完手里 11 张 + 一组副露 = 14（待出牌）",
        game.seats[0].hand.length + 3 * game.seats[0].melds.length === 14,
        game.seats[0].hand.length + "");
    check("碰这一步牌没多没少", census(game).total === before, before + " -> " + census(game).total);
    check("碰完轮到这家出牌", game.turn === 0 && game.phase === "discard");
}

// ---------- 6b. 明杠：杠完必须把回合交给杠家（机器人打牌、人来杠，turn 还挂在机器人那桌就死住） ----------
{
    const game = makeGame("riichi");
    game.start();
    game.turn = 3;                                   // 刚是机器人丁那巡
    const tile = { id: 30, red: false };
    game.seats[3].river = [tile];
    game.seats[0].hand = [tile, { id: 30, red: false }, { id: 30, red: false },
        ...objs([0, 1, 2, 3, 4, 5, 6, 7, 9, 10])];
    const ev = game._doMinkan(0, 3, tile);
    check("明杠成立", ev.some((e) => e.type === "meld" && e.kind === "minkan"), JSON.stringify(ev[0]));
    check("杠完回合交给杠家，不是留在杠别人牌的那家",
        game.turn === 0 && game.phase === "discard", "turn=" + game.turn + " phase=" + game.phase);
    check("杠完摸了一张岭上牌", game.seats[0].hand.length + 4 === 15, game.seats[0].hand.length + "");
    check("杠完这张牌还能正常打出去", game.discardBy(game.seats[0].id, game.seats[0].hand[10].id).ok === true);
}

// ---------- 6c. 吃：点数写法要认「手牌那两张」（用户实际就这么打：cc吃46） ----------
{
    const N = require("../command/mahjong/notation");
    const parsed = N.parseClaim("吃46");
    check("cc吃46 解析成「吃 4 万 6 万」", parsed && parsed.claim === "chi" &&
        JSON.stringify(parsed.ranks) === "[4,6]", JSON.stringify(parsed));

    const game = makeGame("riichi");
    game.start();
    const five = { id: 4, red: false };                       // 上家打 5万
    game.seats[3].river = [five];
    game.seats[0].hand = objs([3, 5, 0, 1, 2, 6, 7, 9, 10, 11, 27, 28, 29]);
    game.claim = { tile: 4, tileObj: five, from: 3, offers: { 0: { chi: [[3, 5]] } }, answers: {} };
    const prompt = game.claimPrompt(0);
    check("私聊提示教的吃法是 cc吃46 这种两字写法", /cc吃46/.test(prompt), prompt);
    game.claim = null;
    const ev = game._doChi(0, 3, five, { claim: "chi", ranks: [4, 6] });
    check("cc吃46（手里的 4万6万）吃得到 5万", ev.some((e) => e.type === "meld" && e.kind === "chi"),
        JSON.stringify(ev[0]));
    check("吃下去的是 4-5-6 万", game.seats[0].melds.length === 1 &&
        game.seats[0].melds[0].tiles.map((t) => game.idOf(t)).sort((a, b) => a - b).join(",") === "3,4,5",
        JSON.stringify(game.seats[0].melds[0] && game.seats[0].melds[0].tiles.map((t) => game.idOf(t))));
    check("吃完整副 4 张 + 手里 11 张 = 14 张待打", game.seats[0].hand.length === 11 && game.turn === 0,
        game.seats[0].hand.length + "");
}

// ---------- 6d. 吃：整副三张的写法也认；三解不猜、错点数要回能吃的 ----------
{
    const game = makeGame("riichi");
    game.start();
    const five = { id: 4, red: false };
    game.seats[3].river = [five];
    game.seats[0].hand = objs([3, 5, 0, 1, 2, 6, 7, 9, 10, 11, 27, 28, 29]);
    const ev = game._doChi(0, 3, five, { claim: "chi", ranks: [4, 5, 6] });
    check("cc吃456（整副三个点数）也吃得到", ev.some((e) => e.type === "meld" && e.kind === "chi"),
        JSON.stringify(ev[0]));
}
{
    const game = makeGame("riichi");
    game.start();
    const five = { id: 4, red: false };
    game.seats[3].river = [five];
    game.seats[0].hand = objs([2, 3, 5, 6, 0, 1, 7, 9, 10, 11, 27, 28, 29]);   // 34 / 46 / 67 三种吃法
    const ev = game._doChi(0, 3, five, { claim: "chi" });
    check("能吃三副又没说吃哪副时不替人瞎挑", ev[0].type === "reject" && /34|67/.test(ev[0].text),
        JSON.stringify(ev[0]));
    const bad = game._doChi(0, 3, five, { claim: "chi", ranks: [1, 2] });
    check("点数不对时回「能吃的是 34/46/67」", bad[0].type === "reject" && /34/.test(bad[0].text),
        JSON.stringify(bad[0]));
}

// ---------- 6e. 上桌座位随机（线上桌子不能永远「我坐一家 / 我东家」） ----------
{
    const seats = new Set();
    for (let i = 0; i < 40; i++) {
        const g = new MahjongGame({ modeId: "riichi", allowBotsOnly: true, shuffleSeats: true });
        g.addPlayer("u1", "小明");
        seats.add(g.players.u1);
    }
    check("上桌座位随机：40 次里不是永远同一家", seats.size > 1, [...seats].join(","));
    const fixed = new MahjongGame({ modeId: "riichi", allowBotsOnly: true });
    fixed.addPlayer("u1", "小明");
    fixed.start();
    check("不开 shuffle 的测试桌保持 0 号位+东家（复盘可复现）",
        fixed.players.u1 === 0 && fixed.dealerSeat === 0, fixed.players.u1 + "/" + fixed.dealerSeat);
}

// ---------- 6f. 快照往返回来还能碰（JSON 会把声明窗口那张牌复制成另一枚，碰完就多 1 张） ----------
{
    const game = makeGame("riichi");
    game.start();
    const tile = { id: 4, red: true };
    game.seats[3].river = [tile];
    game.seats[0].hand = [{ id: 4, red: false }, { id: 4, red: false },
        ...objs([0, 1, 2, 3, 5, 6, 7, 9, 10, 11])];
    game.claim = { tile: 4, tileObj: tile, from: 3, offers: { 0: { pon: true } }, answers: {} };
    game.phase = "claim";
    const before = census(game).total;
    const back = Object.assign(Object.create(Object.getPrototypeOf(game)), JSON.parse(JSON.stringify(game)));
    check("快照往返后声明牌和牌河那张不是同一枚了（问题根源）", back.claim.tileObj !== back.seats[3].river[0]);
    back.relinkRefs();
    check("relink 后声明牌重新指回牌河原件", back.claim.tileObj === back.seats[3].river[0]);
    const ev = back._doPon(0, 3, back.claim.tileObj);
    check("恢复后碰牌成立", ev.some((e) => e.type === "meld" && e.kind === "pon"), JSON.stringify(ev[0]));
    check("恢复后碰牌把牌河那张挖掉了", back.seats[3].river.length === 0, back.seats[3].river.length + "");
    check("恢复后碰牌牌数没多没少", census(back).total === before, before + " -> " + census(back).total);
}

// ---------- 7. 血战刮风下雨 ----------
{
    const game = makeGame("sichuan");
    game.fillBots();
    for (const s of game.seats) { s.queSuit = "m"; s.hand = objs([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); }
    game.seats[0].hand = objs([13, 13, 13, 13, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const base = scoreSum(game);
    const ev = game._doAnkan(0, 13);
    check("暗杠成立并结即时分", ev.some((e) => e.type === "gang-score" && /暗杠/.test(e.name)), JSON.stringify(ev.slice(0, 2)));
    check("暗杠即时分零和（三家各付 2 倍底给杠家）", scoreSum(game) === base,
        scoreSum(game) + " vs " + base);
    check("杠家收到三家的钱", game.seats[0].score === base / 4 + 6, game.seats[0].score + "");
    const add = game._doAddKan(0, 13);
    check("没碰过的牌补杠被拒", add[0].type === "reject", JSON.stringify(add[0]));
    const gang = Rules.get("sichuan").gangSettle({ kind: "diangang", seat: 0, discarderSeat: 2, otherSeats: [1, 2, 3], base: 2 });
    check("点杠只有放杠那一家付", gang.transfers.length === 1 && gang.transfers[0].from === 2 && gang.transfers[0].to === 0,
        JSON.stringify(gang.transfers));
}

// ---------- 8. 流局查花猪 / 查叫 ----------
{
    const game = makeGame("sichuan");
    game.fillBots();
    // 0：清一色听八筒（没听错）；1：花猪以外的没听；2：手里还攥着万 = 花猪；3：缺条、手里没条也没听
    game.seats[0].hand = objs([10, 11, 12, 13, 14, 15, 19, 20, 21, 22, 23, 24, 16]); game.seats[0].queSuit = "m";
    game.seats[1].hand = objs([9, 11, 13, 15, 17, 18, 20, 22, 24, 10, 12, 14, 16]); game.seats[1].queSuit = "m";
    game.seats[2].hand = objs([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); game.seats[2].queSuit = "m";
    game.seats[3].hand = objs([0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 13, 15, 17]); game.seats[3].queSuit = "s";
    const base = scoreSum(game);
    const ev = game._endRound("draw");
    const settle = ev.find((e) => e.type === "draw-settle");
    check("流局会结查花猪/查叫", !!settle && settle.transfers.length > 0, JSON.stringify(settle));
    const pigPays = (settle ? settle.transfers : []).filter((t) => t.why === "查花猪");
    check("花猪那家（2 家）赔给另外三家", pigPays.length === 3 && pigPays.every((t) => t.from === 2), JSON.stringify(pigPays));
    const callPays = (settle ? settle.transfers : []).filter((t) => t.why === "查叫");
    check("没听牌的赔听牌的（两家 → 听牌的那家）", callPays.length === 2 && callPays.every((t) => t.to === 0), JSON.stringify(callPays));
    check("查叫/查花猪也是零和", scoreSum(game) === base, scoreSum(game) + " vs " + base);
    check("流局后进入 round-over", game.phase === "round-over");
    check("结算图之后各家点数能查", ev.some((e) => e.type === "standings"));
    const next = game.nextRound();
    check("cc下一局 能真的重开一局", next.some((e) => e.type === "deal") && game.phase !== "round-over", JSON.stringify(next[0]));
    check("新一局各家 13 张", game.seats.every((s) => s.hand.length === 13), game.seats.map((s) => s.hand.length).join(","));
    const tooSoon = game.nextRound();
    check("还在打的时候不能开下一局", tooSoon.some((e) => e.type === "info"), JSON.stringify(tooSoon[0]));
}

// ---------- 9. 轮庄 / 本棒 ----------
{
    const a = makeGame("riichi");
    a.fillBots();
    const dealer = a.dealerSeat;
    a._endRound("win", null, [dealer]);
    check("庄家和了 → 连庄、本棒 +1", a.dealerSeat === dealer && a.honba === 1,
        JSON.stringify(a.seats.map((s) => s.score)));

    const b = makeGame("riichi");
    b.fillBots();
    b._endRound("win", null, [(b.dealerSeat + 1) % 4]);
    check("子家和了 → 庄家换下家、本棒清零", b.dealerSeat === (dealer + 1) % 4 && b.honba === 0);

    const c = makeGame("riichi");
    c.fillBots();
    c.seats[dealer].hand = objs([1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 20]);
    c.seats[(dealer + 1) % 4].hand = objs([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
    const sumBefore = moneySum(c);
    c._endRound("draw");
    check("流局：庄家听牌则连庄", c.dealerSeat === dealer && c.honba === 1);
    check("流局罚符零和", moneySum(c) === sumBefore, moneySum(c) + " vs " + sumBefore);
    const noten = c.seats[(dealer + 1) % 4].score;
    check("没听牌的那家付出罚符", noten < 0 || noten === 0, noten + "");
    c._endRound("draw");
    check("同一局不会重复结算", c.phase === "round-over");

    const d = makeGame("riichi");
    d.fillBots();
    d.dealerSeat = 2;
    d.roundDealer = 2;
    d._endRound("win", null, [0]);
    const dsnap = d.snapshot(null);
    check("结算盘面按本局庄家画风位（dealerSeat 已经轮给下局）",
        dsnap.dealer === 2 && dsnap.nextDealer === 3, dsnap.dealer + "/" + dsnap.nextDealer);
}

// ---------- 10. 命令层要用的提示都不空 ----------
{
    const game = makeGame("riichi");
    check("没上桌时状态文案教怎么上桌", /cc麻将/.test(game.statusText()), game.statusText());
    game.start();
    game.turn = 2;
    check("没轮到自己不能打", !game.discardBy("u1", game.concealedIds(0)[0]).ok);
    game.turn = 0; game.phase = "discard";
    const ok = game.discardBy("u1", game.concealedIds(0)[0]);
    check("轮到自己能打", ok.ok, ok.hint);
    check("状态文案里有「轮到」", /轮到|打 /.test(game.statusText()), game.statusText());
    check("手牌文案有牌名", /\S\s\S/.test(game.handText(0)), game.handText(0));
    check("牌河文案不空", game.riverText(0).length > 0, game.riverText(0));
    const snap = game.snapshot(0);
    check("snapshot 给自己家看手牌", snap.seats[0].hand.length === 13 || snap.seats[0].hand.length === 14,
        snap.seats[0].hand.length + "");
    check("snapshot 不漏别家手牌", snap.seats[1].hand.length === 0 && snap.seats[1].handCount > 0);
    check("snapshot 带上宝牌指示牌", snap.dora.length === 1 && snap.deadWall.length === 14,
        JSON.stringify(snap.dora) + "/" + snap.deadWall.length);
    check("不在桌上的人打牌被拒", !game.discardBy("u9", 0).ok);
    // 上面那一步打出去之后牌局自己往下走了（机器人会接着摸打），
    // 这三条要的是「没有声明窗口 / 没轮到你」的兜底提示，所以先把牌局按在指定状态
    const idle = makeGame("riichi");
    idle.fillBots();
    check("没有声明窗口时 cc过 有提示", !idle.claimBy("u1", { claim: "pass" }).ok, idle.phase);
    idle.phase = "discard"; idle.turn = 2;
    const ronOutside = idle.ronBy("u1");
    check("声明窗口外的 cc和 会指路", !ronOutside.ok && /和牌要在别人刚打完/.test(ronOutside.hint), ronOutside.hint);
    const tsumoOff = idle.tsumoBy("u1");
    check("没轮到自己时 cc自摸 有提示", !tsumoOff.ok && /没轮到你/.test(tsumoOff.hint), tsumoOff.hint);
}

// ---------- 11. 一炮多响 / 三家和 ----------
{
    const game = makeGame("sichuan");
    game.fillBots();
    // 门清 234p 567p 234s 567s 单钓八筒，缺万（手里一张万都没有）
    const win = objs([10, 11, 12, 13, 14, 15, 19, 20, 21, 22, 23, 24, 16]);
    game.seats[0].hand = win; game.seats[0].queSuit = "m";
    game.seats[1].hand = win.map((t) => ({ id: t.id, red: false })); game.seats[1].queSuit = "m";
    game.seats[2].hand = objs([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]); game.seats[2].queSuit = "m";
    game.seats[3].river = [{ id: 16, red: false }];
    const base = scoreSum(game);
    const tile = game.seats[3].river[0];
    const offers = { 0: { ron: true, pon: false, kan: false, chi: [] }, 1: { ron: true, pon: false, kan: false, chi: [] } };
    const ev = game._resolveClaims(3, tile, offers, { 0: { claim: "ron" }, 1: { claim: "ron" } });
    const wins = ev.filter((e) => e.type === "win");
    check("血战一炮多响：两家都和", wins.length === 2, JSON.stringify(ev.map((e) => e.type)));
    check("一炮多响放炮家付两份", scoreSum(game) === base, scoreSum(game) + " vs " + base);
    check("放炮家牌河里的那张被挖走", game.seats[3].river.length === 0);
    check("虚牌被记账（牌数检查用得上）", game.phantomTiles === 1, game.phantomTiles + "");
    const end = ev.filter((e) => e.type === "round-end");
    check("一炮多响只结算一次", end.length === 1, end.length + "");

    const r = makeGame("riichi");
    r.fillBots();
    const h = objs([1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 20]);
    r.seats[0].hand = h; r.seats[1].hand = objs([1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 21]);
    r.seats[2].hand = objs([2, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 16, 22]);
    r.seats[3].river = [{ id: 20, red: false }];
    const three = { 0: { ron: {} }, 1: { ron: {} }, 2: { ron: {} } };
    const ev3 = r._resolveClaims(3, r.seats[3].river[0], three, { 0: { claim: "ron" }, 1: { claim: "ron" }, 2: { claim: "ron" } });
    check("日麻三家和 = 中途流局", ev3.some((e) => e.type === "round-end" && /三家和/.test(e.reason)),
        JSON.stringify(ev3.map((e) => e.reason || e.type)));
}

console.log("\n" + (checks - failed) + "/" + checks + " 通过");
process.exit(failed ? 1 : 0);
