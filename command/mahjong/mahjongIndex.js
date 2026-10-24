"use strict";
// 麻将命令层：群里发 cc 命令打牌，盘面出图发群，手牌私聊发给本人。
//
// 两条硬规矩：
// 1) 别人的手牌是隐私。群里的图只画牌河/副露/张数（snapshot(null)），
//    自己的手牌和待牌走私聊图；私聊发不到就先在群里点名让人加好友，绝不退化成群发。
// 2) 命令层不做任何判定。引擎返回 {ok, hint} 或 events，这里只把 events 翻成人话 + 一张图，
//    所以「打不出去」「和不了」的原因永远是引擎自己说的那句，不会两处各说一套。
//
// 立直和出牌是一条命令（用户指定）：cc三万立直。只发 cc立直 会被拒并提示带上牌。

const { client } = require("../../app");
const store = require("../../state/store");
const T = require("./tiles");
const Rules = require("./rules");
const N = require("./notation");
const { MahjongGame } = require("./game");
const { renderImage, renderText } = require("./render");

// state/store.js 是钉住模块，热重载换不掉：老进程里 gameMaps.mahjong 还不存在，
// 这里补一张同名 Map，新模式才能不重启机器人直接 cc热更上线（重启后走 store 里登记的那张）。
const games = store.gameMaps.mahjong || (store.gameMaps.mahjong = new Map());

const SEAT_LABEL = ["一家", "二家", "三家", "四家"];
const FORMAT_HINT =
    "打牌：cc + 要打的那张牌名（数字写法 cc5m 也认）｜立直：出牌后面加「立直」｜副露：cc碰 / cc吃34 / cc杠 / cc和 / cc自摸｜过牌：ccp\n" +
    "看盘：cc棋盘 / cc状态 / cc手牌 / cc战报 / cc点数｜其他：cc规则 / cc模式 血战 / cc下一局 / cc结束\n" +
    "碰不碰、和不和只私聊问那一家，私聊回和群里回都算";

function gameOf(event) { return games.get(event.group_id); }
function seatOf(event, game) { return game ? game.seatOf(event.sender.user_id) : undefined; }
function nameOf(game, seat) {
    if (seat == null || seat < 0) return "池子";
    const s = game.seats[seat];
    return s ? s.name : SEAT_LABEL[seat] + "家";
}
function tile(id) { return T.tileName(id); }

// 该不该催这个人动手：定缺 / 声明 / 轮到自己出牌
function waitingFor(game, seat) {
    if (seat == null || !game.seats[seat] || game.seats[seat].out) return null;
    if (game.phase === "que" && !game.seats[seat].queSuit) return "que";
    if (game.phase === "claim" && game.claim && game.claim.offers[seat] && !game.claim.answers[seat]) return "claim";
    if (game.phase === "discard" && game.turn === seat) return "discard";
    return null;
}

// 下一步能发什么命令，全列出来——回复宁可啰嗦，也别让人猜
// withWaits 只在私聊里传 true：「打这张听什么」是手牌信息，立直之前不往群里发
function actionHint(game, seat, withWaits) {
    const kind = waitingFor(game, seat);
    if (kind === "que") return "该你定缺：cc缺万 / cc缺筒 / cc缺条（手里哪门最少缺哪门）";
    if (kind === "claim") return "这张牌你可以：" + game.claimPrompt(seat);
    if (kind === "discard") {
        const s = game.seats[seat];
        // 立直后只能摸切，但「刚摸的是哪张」在打出去之前还是手牌信息：群里不点名
        const drawnId = game.drawn ? game.idOf(game.drawn) : null;
        let cmd;
        if (s.riichi) {
            cmd = withWaits && drawnId != null ? "cc" + tile(drawnId) + "（立直只能摸切）"
                : "打刚摸的那张（立直只能摸切；发 cc手牌 私聊看是哪张）";
        } else if (withWaits) {
            // 私聊里报一张自己手里的牌当写法样板：只说「cc三万」会让人以为在替你做决定
            const ids = game.concealedIds(seat);
            cmd = ids.length ? "cc" + tile(ids[0]) + "（就是这种写法，打哪张你定）"
                : "发 cc + 要打的那张牌名";
        } else {
            cmd = "发 cc + 要打的那张牌名（cc手牌 私聊看手里有什么）";
        }
        const lines = ["该你出牌：" + cmd];
        const opt = game.optionsFor(seat);
        if (opt.tsumo) lines.push("可以和牌：cc自摸（" + (opt.tsumo.label || "和了") + "）");
        // 能暗杠哪张 = 手里有哪四张，只有私聊能说
        if (withWaits && opt.ankan.length) lines.push("可以暗杠：cc暗杠" + T.tileShort(opt.ankan[0]));
        if (withWaits && opt.addKan.length) lines.push("可以补杠：cc补杠" + T.tileShort(opt.addKan[0]));
        if (withWaits && opt.waits.length && !s.riichi) {
            // 能不能立直跟门清挂钩：碰/吃/明杠过的只能听牌，不能说「可以立直」
            const canRiichi = game.mode.riichi && game.isMenzen(seat) && s.score >= 1000 && game.wall.length >= 4;
            lines.push((canRiichi ? "打这张就听牌（可以立直）：" : "打这张就听牌：") + opt.waits.map((w) =>
                T.tileName(w.discard) + "→听 " + w.tiles.map(T.tileName).join("/") +
                // 打出去的这张正好是自己待牌 = 自己牌河里有了，之后只能自摸
                (game.mode.furiten && w.tiles.includes(w.discard) ? "（打完会振听，只能自摸）" : "")).join("；"));
        }
        return lines.join("\n");
    }
    return "";
}

// ---------- 事件 -> 群里的话 ----------
function describe(game, events) {
    const unit = game.mode.unit;
    const lines = [];
    for (const e of events || []) {
        switch (e.type) {
            case "deal":
                lines.push("【麻将】" + game.mode.name + " 第 " + e.round + " 局开局，庄家 " + nameOf(game, e.dealer) +
                    "，牌墙 " + e.wall + " 张");
                break;
            case "need-que":
                lines.push("各家定缺：发 cc缺万 / cc缺筒 / cc缺条");
                break;
            case "que-set":
                lines.push(nameOf(game, e.seat) + " 定缺 " + game.suitName(e.suit));
                if (e.waiting && e.waiting.length) {
                    lines.push("还没定缺：" + e.waiting.map((s) => nameOf(game, s)).join("、"));
                }
                break;
            case "discard":
                lines.push(nameOf(game, e.seat) + " 打 " + tile(e.tile) + (e.red ? "（赤）" : "") +
                    (e.riichi ? "（立直宣言）" : ""));
                break;
            case "claim-open":
                lines.push("这张牌有人能表态，已经私聊问了，等回话");
                break;   // 只说「在等人」，谁能干什么不播报
            case "need-claim":
                break;   // 同上：谁能碰谁能和是隐私，notifyClaims() 私聊逐家问
            case "meld": {
                const who = nameOf(game, e.seat);
                if (e.kind === "pon") lines.push(who + " 碰 " + tile(e.tile) + "（从 " + nameOf(game, e.from) + "）");
                else if (e.kind === "minkan") lines.push(who + " 明杠 " + tile(e.tile) + "（从 " + nameOf(game, e.from) + "）");
                else if (e.kind === "ankan") lines.push(who + " 暗杠 " + tile(e.tile));
                else if (e.kind === "ranka") lines.push(who + " 补杠 " + tile(e.tile));
                else if (e.kind === "chi") lines.push(who + " 吃 " + e.tiles.map(tile).join("") + "（从 " + nameOf(game, e.from) + "）");
                break;
            }
            case "riichi":
                lines.push(nameOf(game, e.seat) + (e.double ? " 双立直！" : " 立直！") +
                    "打 " + tile(e.tile) + "　听 " + (e.waits || []).map(tile).join("/"));
                break;
            case "gang-score":
                lines.push(nameOf(game, e.seat) + " " + e.name + "：" + transferText(game, e.transfers, unit));
                break;
            case "win": {
                const from = e.selfDrawn ? "自摸" : "食 " + nameOf(game, e.from) + " 的炮";
                lines.push("【和牌】" + e.name + " " + from + " " + tile(e.tile) + "：" + (e.res.label || "和了"));
                const t = transferText(game, e.transfers, unit);
                if (t) lines.push("　结算：" + t);
                if (e.sticks) lines.push("　另收立直棒 " + e.sticks + " 根");
                break;
            }
            case "draw-settle":
                lines.push("【" + e.name + "】" + transferText(game, e.transfers, unit));
                break;
            case "round-end": {
                const ten = (e.tenpai || []).map((s) => nameOf(game, s)).join("、") || " none";
                lines.push("【本局结束】" + e.reason + (e.winners && e.winners.length ?
                    "，和牌：" + e.winners.map((s) => nameOf(game, s)).join("、") : "　听牌：" + ten));
                break;
            }
            case "standings":
                lines.push("【点数】" + e.scores.map((x) => nameOf(game, x.seat) + " " + x.score + unit).join("　") +
                    "　下局庄家 " + nameOf(game, e.dealer) + (e.keepDealer ? "（连庄 " + e.honba + " 本棒）" : ""));
                break;
            case "reject":
                lines.push("✗ " + e.text);
                break;
            case "info":
                lines.push("【麻将】" + e.text);
                break;
            default:
                break;   // draw / need-discard 是流程内部信号，群里不刷屏
        }
    }
    return lines;
}

function transferText(game, transfers, unit) {
    return (transfers || []).map((t) =>
        nameOf(game, t.from) + "→" + nameOf(game, t.to) + " " + t.amount + unit + (t.why ? "（" + t.why + "）" : "")
    ).join("，");
}

// ---------- 出图 ----------
async function postImage(event, game, seat, tag) {
    const snap = game.snapshot(seat);
    let b64 = null;
    try {
        b64 = renderImage(snap);
    } catch (err) {
        console.error("麻将盘面渲染失败" + (tag ? "（" + tag + "）" : "") + ": " + err.message);
    }
    if (!b64) return event.reply(renderText(snap));
    // 图片发不出去（不是好友、服务端抽风）就退回文本盘面，别让这一步把整条命令抛出去
    try {
        return await event.reply({ image: b64 });
    } catch (err) {
        console.error("麻将盘面图片发送失败，改发文本: " + err.message);
        return event.reply(renderText(snap));
    }
}

// 群里的图不带手牌（seat=null），自己的手牌走私聊图
async function postBoard(event, game) {
    return postImage(event, game, null, "群");
}

// 私聊发东西：发不出去只在群里点名让人加好友，绝不把内容抄一份进群——手牌和声明选项都是隐私
async function sendPrivate(room, userId, lines) {
    try {
        await client.sendText(userId, lines.join("\n"));
        return true;
    } catch (err) {
        console.error("麻将私聊发送失败: " + err.message);
    }
    await client.sendText(room, "【麻将】私聊发给 " + client.displayName(userId) +
        " 发不出去，TA 需要先加机器人为好友。").catch(() => {});
    return false;
}

async function sendOwnHand(event, game, userId) {
    const seat = game.seatOf(userId);
    if (seat == null) return false;
    let shown = false;
    let b64 = null;
    try {
        b64 = renderImage(game.snapshot(seat));
    } catch (err) {
        console.error("麻将手牌图渲染失败: " + err.message);
    }
    if (b64) {
        try {
            await client.sendImage(userId, b64);
            shown = true;
        } catch (err) {
            console.error("麻将手牌私聊图失败，改发文字: " + err.message);
        }
    }
    // 图里只有手牌；「打哪张听什么」必须再补一句文字，图发成功也不能省
    const lines = shown ? [] : ["【麻将】你的手牌：" + game.handText(seat)];
    const hint = actionHint(game, seat, true);
    if (hint) lines.push(hint);
    if (!lines.length) return shown;
    const said = await sendPrivate(event.group_id, userId, lines);
    return shown || said;
}

// ---------- 声明：挨家私聊问，群里不播报谁能碰谁能和 ----------
async function notifyClaims(event, game, events) {
    for (const e of events || []) {
        if (e.type !== "need-claim") continue;
        const s = game.seats[e.seat];
        if (!s || s.bot) continue;
        await sendPrivate(event.group_id, s.id, [
            "【麻将】" + e.fromName + " 打 " + tile(e.tile) + "，你可以：",
            game.claimPrompt(e.seat),
            "你的手牌：" + game.handText(e.seat),
            "群里发或私聊发都行，不想动发 ccp",
        ]);
    }
}

// ---------- 公共出口：执行一条引擎命令 ----------
async function run(event, game, res) {
    const userId = event.sender.user_id;
    if (!res) return;
    if (!res.ok) {
        return event.reply("【麻将】" + res.hint + "\n" + game.statusText() + "\n" + FORMAT_HINT);
    }
    const lines = describe(game, res.events);
    const seat = game.seatOf(userId);
    const mine = waitingFor(game, seat);
    const head = lines.length ? lines.join("\n") : game.statusText();
    // 轮到出牌 / 定缺可以写在群里（本来就知道是谁），声明选项只能出现在私聊里
    const tail = mine && mine !== "claim" ? "\n" + actionHint(game, seat) : "";
    await event.reply(head + tail);
    await postBoard(event, game);
    if (mine === "claim") await sendPrivate(event.group_id, userId, ["【麻将】你可以：", game.claimPrompt(seat)]);
    else if (mine) await sendOwnHand(event, game, userId);
    await notifyClaims(event, game, res.events);
}

// ---------- 上桌 / 开局 ----------
async function joinCommand(event) {
    const room = event.group_id;
    const userId = event.sender.user_id;
    const name = client.displayName(userId);
    // 手牌只走私聊，不是好友就坐不下这张桌。必须在动桌子之前查：
    // 先 addPlayer 再 delete 会把别人正在打的牌桌连带删掉。
    if (!(await client.isFriend(userId))) {
        const old = gameOf(event);
        return event.reply("【麻将】你还没加机器人为好友，收不到私聊的手牌，先加好友再来上桌" +
            "（刚加完的话等几秒，再发一次 cc麻将 就好）。" +
            (old ? "\n" + old.statusText() : ""));
    }
    let game = gameOf(event);
    if (!game) {
        game = new MahjongGame({ modeId: Rules.DEFAULT_MODE, room, shuffleSeats: true });
        games.set(room, game);
    }
    const added = game.addPlayer(userId, name);
    if (!added.ok) {
        // 已经坐过了 / 桌子开打了 —— 都先把当前局面回给人家
        return event.reply("【麻将】" + added.reason + "\n" + game.statusText());
    }
    const humans = game.humans();
    if (game.phase !== "lobby") {
        return event.reply("【麻将】" + name + " 上桌（" + SEAT_LABEL[added.seat] + "）\n" + game.statusText());
    }
    return event.reply(
        "【麻将】" + name + " 上桌，你是" + SEAT_LABEL[added.seat] + "（当前玩法：" + game.mode.name + "）\n" +
        "现在桌上 " + humans.length + " 个人，其余位置机器人补满，随时可以开：\n" +
        "cc开局 发牌开打　cc模式 血战 换玩法（血战到底 / 广东鸡平胡）\n" +
        FORMAT_HINT
    );
}

async function startCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没上桌，发 cc麻将 上桌（人不够机器人补满）。");
    if (game.seatOf(event.sender.user_id) == null) return event.reply("【麻将】你不在这桌上，先发 cc麻将 上桌。");
    if (game.phase !== "lobby") {
        return event.reply("【麻将】这局已经在打了。\n" + game.statusText() + "\n打完发 cc下一局 开下一局。");
    }
    return run(event, game, { ok: true, events: game.start() });
}

async function nextRoundCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没上桌，发 cc麻将 上桌。");
    if (game.seatOf(event.sender.user_id) == null) return event.reply("【麻将】你不在这桌上，先发 cc麻将 上桌。");
    if (game.phase !== "round-over") return event.reply("【麻将】这一局还没打完。\n" + game.statusText());
    return run(event, game, { ok: true, events: game.nextRound() });
}

// ---------- 打牌 ----------
async function queCommand(event, suit) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没上桌，发 cc麻将 上桌。");
    if (!suit) return event.reply("【麻将】定缺写法：cc缺万 / cc缺筒 / cc缺条");
    return run(event, game, game.setQueBy(event.sender.user_id, suit));
}

async function riichiCommand(event, text) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没上桌，发 cc麻将 上桌。");
    const p = N.parseRiichi(text);
    if (!p) return;
    if (p.needTile) {
        return event.reply("【麻将】立直和出牌是一条命令：把「立直」跟在要打的那张后面一起发（例：cc5m立直）。\n" +
            "不知道打哪张？发 cc手牌，私聊发你手牌时会附上「打这张听什么」。\n" +
            "立直要门清：碰/吃/明杠过就不能立直（暗杠不算破门清）。");
    }
    if (p.badTile) return event.reply("【麻将】认不出「" + p.badTile + "」是哪张牌。写法：cc + 牌名 + 立直（例：cc5m立直）");
    return run(event, game, game.riichiBy(event.sender.user_id, p.tile));
}

async function claimCommand(event, parsed) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没上桌，发 cc麻将 上桌。");
    const userId = event.sender.user_id;
    if (parsed.claim === "tsumo") return run(event, game, game.tsumoBy(userId));
    if (parsed.claim === "ron") return run(event, game, game.ronBy(userId));
    if (parsed.claim === "ankan") {
        if (parsed.tile == null) return event.reply("【麻将】暗杠写法：cc暗杠五筒（能暗杠的牌 cc状态 里有）");
        return run(event, game, game.doAnkanBy(userId, parsed.tile));
    }
    if (parsed.claim === "ranka") {
        if (parsed.tile == null) return event.reply("【麻将】补杠写法：cc补杠五筒（要先把那副牌碰出来）");
        return run(event, game, game.doAddKanBy(userId, parsed.tile));
    }
    return run(event, game, game.claimBy(userId, parsed));
}

async function discardCommand(event, tileId) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没上桌，发 cc麻将 上桌（人不够机器人补满）。");
    return run(event, game, game.discardBy(event.sender.user_id, tileId));
}

// ---------- 查询 ----------
async function boardCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没牌桌，发 cc麻将 上桌。");
    await event.reply(game.statusText());
    await postBoard(event, game);
    if (game.seatOf(event.sender.user_id) != null) await sendOwnHand(event, game, event.sender.user_id);
}

async function handCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没牌桌，发 cc麻将 上桌。");
    const seat = game.seatOf(event.sender.user_id);
    if (seat == null) return event.reply("【麻将】你不在这桌上，发 cc麻将 上桌。");
    await sendOwnHand(event, game, event.sender.user_id);
    return event.reply("【麻将】手牌已私聊发给 " + game.seats[seat].name + "（别人的手牌只有机器人和自己看得见）");
}

// 能往群里贴的那半句提示：声明选项不在其中（只走私聊）
function groupHint(game, seat) {
    const kind = waitingFor(game, seat);
    return kind && kind !== "claim" ? actionHint(game, seat) : "";
}

async function statusCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没牌桌，发 cc麻将 上桌。");
    const seat = game.seatOf(event.sender.user_id);
    const hint = groupHint(game, seat);
    await event.reply("【麻将】" + game.statusText() + (hint ? "\n" + hint : "") + "\n" + FORMAT_HINT);
    if (seat != null && waitingFor(game, seat) === "claim") {
        await sendPrivate(event.group_id, event.sender.user_id,
            ["【麻将】这张牌你可以：", game.claimPrompt(seat)]);
    }
}

function scoreCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没牌桌，发 cc麻将 上桌。");
    const lines = ["【麻将】" + game.mode.name + " 点数　第 " + game.roundNumber + " 局　" + game.honba + " 本棒"];
    game.seats.forEach((s, i) => {
        lines.push(SEAT_LABEL[i] + " " + s.name + (i === game.dealerSeat ? "（庄）" : "") + (s.bot ? "（机器人）" : "") +
            "　" + s.score + game.mode.unit + (s.riichi ? "　立直" : "") + (s.out ? "　已和" : ""));
    });
    if (game.mode.riichi) lines.push("立直棒 " + game.riichiSticks + " 根　宝牌指示 " +
        (game.doraIndicators.length ? game.doraIndicators.map(tile).join(" ") : "无"));
    return event.reply(lines.join("\n"));
}

function reportCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里还没牌桌，发 cc麻将 上桌。");
    if (!game.tail.length) return event.reply("【麻将】还没有打完的局，打完每局都会在这里留一条战报。");
    const lines = ["【麻将】最近 " + game.tail.length + " 局战报："];
    for (const round of game.tail.slice(-5)) {
        for (const e of round) {
            if (e.type === "win") {
                lines.push("　" + e.name + (e.selfDrawn ? " 自摸 " : " 荣和 ") + tile(e.tile) + "：" + (e.res.label || "和了"));
            } else if (e.type === "round-end") {
                lines.push("　" + e.reason + (e.winners.length ? "（" + e.winners.map((s) => nameOf(game, s)).join("、") + "）" : ""));
            } else if (e.type === "draw-settle") {
                lines.push("　" + e.name + "：" + transferText(game, e.transfers, game.mode.unit));
            }
        }
    }
    return event.reply(lines.join("\n"));
}

function modeCommand(event, text) {
    const room = event.group_id;
    const wanted = N.normalizeText(String(text || "").replace(/^.*?模式/, "").trim());
    const list = Rules.list();
    if (!wanted) {
        return event.reply("【麻将】可选玩法：\n" +
            list.map((m) => "　cc模式 " + m.name + "：" + (m.que ? "定缺、不能吃、一炮多响、杠有即时分" :
                m.riichi ? "立直、能吃、振听、宝牌" : "不吃立直，鸡平胡算番，3 番封顶")).join("\n") +
            "\n默认" + Rules.get(Rules.DEFAULT_MODE).name + "，换玩法发 cc模式 血战");
    }
    const mode = Rules.byName(wanted);
    if (!mode) return event.reply("【麻将】没这个玩法，可选：" + list.map((m) => m.name).join(" / "));
    const game = gameOf(event);
    if (game && game.phase !== "lobby") {
        return event.reply("【麻将】" + game.mode.name + " 这局已经在打了，换玩法要先 cc结束 散桌。");
    }
    const fresh = new MahjongGame({ modeId: mode.id, room, shuffleSeats: true });
    if (game) for (const s of game.seats) if (s && !s.bot) fresh.addPlayer(s.id, s.name);
    games.set(room, fresh);
    return event.reply("【麻将】换到 " + mode.name + "（" + mode.unit + "计）\n" +
        (fresh.humans().length ? "人还在桌上，发 cc开局 开打" : "先 cc麻将 上桌") + "\n" + FORMAT_HINT);
}

function endCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【麻将】这里没有牌桌。");
    const summary = game.mode.name + " 打到第 " + game.roundNumber + " 局，" +
        game.humans().map((s) => s.name + " " + s.score + game.mode.unit).join("、");
    games.delete(event.group_id);
    return event.reply("【麻将】已散桌（" + summary + "）。想再玩发 cc麻将。");
}

function rulesCommand(event) {
    const game = gameOf(event);
    const mode = game ? game.mode : Rules.get(Rules.DEFAULT_MODE);
    return event.reply(
        "【麻将】1~3 个真人上桌，机器人补满四家，机器人当裁判\n" +
        "上桌：cc麻将 → cc开局 发牌（庄家先打）\n" +
        "出牌：cc + 牌名（cc5m、cc五万 都认）；立直和出牌一起发：cc5m立直\n" +
        "副露：cc碰 / cc吃34（写顺子头两张的点数）/ cc杠 / cc暗杠五筒 / cc补杠五筒\n" +
        "和牌：别人打的那张能和发 cc和，自己摸到发 cc自摸；不想动发 ccp（cc过 也行）\n" +
        "碰不碰、和不和只私聊问那一家，不让别人知道你手上有什么；私聊回、群里回都算数\n" +
        (mode.que ? "定缺：开局先 cc缺万/缺筒/缺条，缺门没打光不能和（花猪要赔）\n" : "") +
        (mode.riichi ? "立直：门清 + 打完就听 + 有 1000 点，立直后只能摸切；振听不能荣和\n" : "") +
        "当前玩法：" + mode.name + "（" + mode.unit + "计，" + (mode.fanCap ? mode.fanCap + " 番封顶" : "无封顶") + "）\n" +
        "看图：cc棋盘（牌河、副露、最后一手都画在图里；你的手牌私聊发你）\n" +
        "其他：cc状态 / cc手牌 / cc点数 / cc战报 / cc下一局 / cc结束 / cc模式 血战\n" + FORMAT_HINT
    );
}

// ---------- 分发 ----------
async function getMahjongCommand(event, raw_message) {
    const text = N.normalizeText(raw_message);
    if (!text) return;

    // 上桌 / 开局 / 下一局：桌子级命令先认，别被后面的牌名解析抢走
    if (/^(麻将|上桌|加入|坐)/.test(text)) return joinCommand(event);
    if (/^(开局|开始|开打|发牌)/.test(text)) return startCommand(event);
    if (/^(下一局|继续|再来一局|下一把)/.test(text)) return nextRoundCommand(event);
    if (/^模式/.test(text)) return modeCommand(event, text);
    if (/^(规则|怎么玩|帮助)/.test(text)) return rulesCommand(event);

    const q = N.parseQuery(text);
    if (q === "board") return boardCommand(event);
    if (q === "hand") return handCommand(event);
    if (q === "status") return statusCommand(event);
    if (q === "score") return scoreCommand(event);
    if (q === "quit") return endCommand(event);
    if (q === "rules") return rulesCommand(event);
    if (q === "mode") return modeCommand(event, text);

    if (/^(战报|亮子|上一局)/.test(text)) return reportCommand(event);
    if (/^定缺|^缺/.test(text)) {
        const p = N.parseClaim(text);
        return queCommand(event, p && p.suit);
    }
    if (N.RIICHI.test(text)) return riichiCommand(event, text);

    const parsed = N.parseClaim(text);
    if (parsed && parsed.claim) return claimCommand(event, parsed);

    const tileId = N.parseDiscard(text);
    if (tileId != null) return discardCommand(event, tileId);

    const game = gameOf(event);
    const seat = game ? game.seatOf(event.sender.user_id) : undefined;
    if (!game) return event.reply("【麻将】发 cc麻将 上桌，人不够机器人补满；cc规则 看玩法。");
    const hint = groupHint(game, seat);
    return event.reply("【麻将】没看懂「" + String(raw_message).slice(0, 20) + "」。" +
        (hint ? "\n" + hint : "") + "\n" + FORMAT_HINT);
}

// ---------- 私聊入口：声明、出牌、查询在私聊里同样收 ----------
// 只认「在这桌上确实算一句命令」的文本，闲聊一律不接，免得群里莫名冒出一句「没看懂」。
const TRIGGERS = (process.env.trigger_prefix || "cc").split(",").map((s) => s.trim()).filter(Boolean);
const TABLE_WORDS = /^(麻将|上桌|开局|开始|开打|发牌|下一局|继续|再来一局|下一把|战报|亮子|上一局)/;

function looksLikeCommand(text) {
    if (!text) return false;
    if (TABLE_WORDS.test(text) || N.RIICHI.test(text)) return true;
    if (N.parseQuery(text) || N.parseClaim(text)) return true;
    return N.parseDiscard(text) != null;
}

// 这个人的桌子：正在等他表态的那张优先，其余取他坐着的任意一张
function roomOf(userId) {
    let any = null;
    for (const [room, game] of games) {
        if (!game) continue;
        const seat = game.seatOf(userId);
        if (seat == null) continue;
        if (waitingFor(game, seat) === "claim") return room;
        if (!any) any = room;
    }
    return any;
}

function groupEventFor(room, userId) {
    const event = {
        type: "group",
        group_id: room,
        sender: { user_id: userId, nick: client.displayName(userId) },
        message: [],
        atme: false,
        client,
    };
    event.reply = (content) => client.reply(event, content);
    return event;
}

// 返回 true 表示这句私聊已经被麻将收下了，private.js 就不用再往下走
async function handlePrivateMessage(userId, raw) {
    const room = roomOf(userId);
    if (!room) return false;
    let text = N.normalizeText(raw);
    for (const p of TRIGGERS) {
        if (text.startsWith(p)) { text = text.slice(p.length).trim(); break; }
    }
    if (!looksLikeCommand(text)) return false;
    await getMahjongCommand(groupEventFor(room, userId), text);
    return true;
}

module.exports = { getMahjongCommand, handlePrivateMessage, games };
