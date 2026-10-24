"use strict";
// UNO 命令层：ccuno 上桌（第一个是房主）、房主 cc开始 开局、手牌私聊发、群内 cc出X / cc摸 / cc过。
const { client } = require("../../app");
const { UnoGame, cardText } = require("./game");

// room -> UnoGame（牌桌钉在 state/store.js，热重载不丢局）
const games = require("../../state/store").gameMaps.uno;

const FORMAT_HINT = "出牌 cc出红5 / cc出跳过 / cc出+2，万能 cc万能 蓝 / cc出+4 红，没得打 cc摸，不要 cc过";

function gameOf(event) {
    return games.get(event.group_id);
}

async function getUnoCommand(event, raw_message) {
    const text = String(raw_message || "").trim();
    if (!text) return;
    const t = text.toLowerCase();
    if (text.includes("结束")) return endCommand(event);
    if (text === "状态" || text.includes("战况")) return statusCommand(event);
    if (text === "投降") return surrenderCommand(event);
    if (text === "退出") return leaveCommand(event);
    if (text === "开始") return startCommand(event);
    if (t === "uno" || text === "上桌" || text === "加入") return await joinCommand(event);
    if (text === "手牌") return handCommand(event);
    if (text === "摸") return drawCommand(event);
    if (text === "过" || text === "不要") return passCommand(event);
    return playCommand(event, text);
}

async function joinCommand(event) {
    const room = event.group_id;
    const userId = event.sender.user_id;
    let game = gameOf(event);
    if (game && game.started) {
        event.reply("这局已经开打了，打完再开新桌（cc结束 可以散桌）");
        return;
    }
    // 手牌是私聊发的，不是好友收不到，坐下就是死局
    if (!(await client.isFriend(userId))) {
        event.reply("你还没加机器人为好友，收不到私聊发的手牌，先加好友再来上桌。");
        return;
    }
    if (!game) {
        game = new UnoGame();
        games.set(room, game);
    }
    if (game.players.some((p) => p.id === userId)) {
        event.reply("你已经在桌上了");
        return;
    }
    const r = game.addPlayer(userId, client.displayName(userId));
    if (!r.ok) { event.reply(r.reason); return; }
    const name = client.displayName(userId);
    if (game.players.length === 1) {
        event.reply("【UNO】" + name + " 开桌成功，你是房主\n" +
            "再拉 1-3 人发 ccuno 上桌，人齐了房主发 cc开始 开打\n" +
            "命令：ccuno 上桌 / cc退出 下桌 / cc结束 散桌 / cc状态 看牌桌");
    } else {
        const host = game.players.find((p) => p.id === game.host);
        event.reply("【UNO】" + name + " 上桌成功（" + game.players.length + "/4）\n" +
            "等房主 " + (host ? host.name : "?") + " 发 cc开始 开局");
    }
}

function leaveCommand(event) {
    const game = gameOf(event);
    if (!game) { event.reply("没有 UNO 牌桌"); return; }
    const r = game.removePlayer(event.sender.user_id);
    if (!r.ok) { event.reply(r.reason); return; }
    const host = game.players.find((p) => p.id === game.host);
    event.reply(client.displayName(event.sender.user_id) + " 下桌了（" + game.players.length + "/4）\n" +
        "房主：" + (host ? host.name : "无") + " 发 cc开始 开局");
}

function startCommand(event) {
    const game = gameOf(event);
    if (!game) { event.reply("这个群还没有 UNO 牌桌，发 ccuno 开一桌"); return; }
    const r = game.start(event.sender.user_id);
    if (!r.ok) { event.reply(r.reason); return; }
    for (const p of game.players) {
        client.sendTempMsg(event.group_id, p.id,
            "【UNO】开局！你的手牌：" + p.hand.map(cardText).join("，") + "\n" + FORMAT_HINT).then();
    }
    const first = game.players[game.currentIndex];
    event.reply(
        "【UNO】开局！" + first.name + " 先出\n" +
        "亮出的牌面：" + game.boardText() + "\n" +
        "各家手牌：" + game.countsText() + "\n" +
        FORMAT_HINT + "\n" +
        "cc状态 看牌局 / cc手牌 重看自己的牌 / cc投降 认负 / cc结束 散桌"
    );
}

function playCommand(event, text) {
    const game = gameOf(event);
    if (!game) { event.reply("这个群没有 UNO 牌桌，发 ccuno 开一桌"); return; }
    if (!game.started) { event.reply("还没开局，房主发 cc开始 才开打"); return; }
    const r = game.tryPlay(event.sender.user_id, text);
    if (!r.ok) { event.reply(r.hint); return; }
    const lines = [r.player + " 出了 " + r.played + " → 牌面：" + r.board];
    if (r.effects) lines.push(r.effects);
    if (r.over) {
        lines.push(r.winner.name + " 出完了，获胜！");
        lines.push("各家剩余：" + r.counts);
        lines.push("cc结束 清桌，或 ccuno 再开新桌");
        event.reply(lines.join("\n"));
        return;
    }
    if (r.uno) lines.push(r.player + " 只剩 1 张，记得喊 UNO！");
    lines.push("轮到 " + r.next + " 出牌");
    lines.push("各家：" + r.counts);
    event.reply(lines.join("\n"));
    const p = game.players.find((x) => x.id === event.sender.user_id);
    if (p) client.sendTempMsg(event.group_id, p.id, "你的手牌剩：" + p.hand.map(cardText).join("，")).then();
}

function drawCommand(event) {
    const game = gameOf(event);
    if (!game) { event.reply("这个群没有 UNO 牌桌，发 ccuno 开一桌"); return; }
    if (!game.started) { event.reply("还没开局，房主发 cc开始 才开打"); return; }
    const r = game.tryDraw(event.sender.user_id);
    if (!r.ok) { event.reply(r.hint); return; }
    if (r.playable) {
        event.reply(r.player + " 摸到 " + r.drew + "，能出！\n" + r.hint);
    } else {
        event.reply(r.player + " 摸到 " + r.drew + "，不能出，自动过\n" +
            "轮到 " + r.next + " 出牌\n各家：" + r.counts);
    }
    const p = game.players.find((x) => x.id === event.sender.user_id);
    if (p) client.sendTempMsg(event.group_id, p.id, "你的手牌：" + p.hand.map(cardText).join("，")).then();
}

function passCommand(event) {
    const game = gameOf(event);
    if (!game) { event.reply("这个群没有 UNO 牌桌，发 ccuno 开一桌"); return; }
    if (!game.started) { event.reply("还没开局，房主发 cc开始 才开打"); return; }
    const r = game.tryPass(event.sender.user_id);
    if (!r.ok) { event.reply(r.hint); return; }
    event.reply(client.displayName(event.sender.user_id) + " 过了\n" +
        "轮到 " + r.next + " 出牌\n各家：" + r.counts);
}

function handCommand(event) {
    const game = gameOf(event);
    if (!game) { event.reply("这个群没有 UNO 牌桌，发 ccuno 开一桌"); return; }
    const p = game.players.find((x) => x.id === event.sender.user_id);
    if (!p) { event.reply("你不在桌上"); return; }
    if (!game.started) { event.reply("还没发牌，开局后手牌私聊发给你"); return; }
    client.sendTempMsg(event.group_id, p.id,
        "【UNO】你的手牌：" + p.hand.map(cardText).join("，") + "\n" + FORMAT_HINT).then();
    event.reply("手牌已私聊发给你");
}

function surrenderCommand(event) {
    const game = gameOf(event);
    if (!game) { event.reply("没有 UNO 牌桌"); return; }
    const r = game.surrender(event.sender.user_id);
    if (!r.ok) { event.reply(r.reason); return; }
    if (r.over) {
        event.reply(r.dropped + " 认负离场，只剩 " + r.winner.name + "，直接获胜！\n" +
            "cc结束 清桌，或 ccuno 再开新桌");
        return;
    }
    event.reply(r.dropped + " 认负离场\n轮到 " + r.next + " 出牌\n各家：" + r.counts);
}

function statusCommand(event) {
    const game = gameOf(event);
    if (!game) { event.reply("这个群没有 UNO 牌桌，发 ccuno 开一桌（2-4 人）"); return; }
    event.reply(game.statusText(event.sender.user_id));
}

function endCommand(event) {
    const room = event.group_id;
    if (!games.has(room)) { event.reply("没有 UNO 牌桌"); return; }
    games.delete(room);
    event.reply("UNO 牌桌已散，发 ccuno 重新开一桌");
}

module.exports = { getUnoCommand, games };
