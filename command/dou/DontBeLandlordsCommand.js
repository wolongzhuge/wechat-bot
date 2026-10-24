// 不抢地主命令：轮到谁表态就回「不抢」；三个人都不抢就重新发牌
const { isPlayerInGame, sendHands, startRobText } = require("./utils");
const gameMap = require("./gameMap");

function dontBeLandlordsCommand(event) {
    const room = event.group_id;
    const userId = event.sender.user_id;
    const game = gameMap.get(room);
    if (!game) {
        event.reply("游戏不存在，请创建游戏");
        return;
    }
    if (!isPlayerInGame(game, userId)) {
        event.reply("您不在游戏中，请先加入游戏");
        return;
    }
    if (game.status !== 1) {
        event.reply("游戏不处于抢地主阶段，发 cc状态 看看现在什么情况");
        return;
    }
    const currentPlayer = game.getCurrentPlayer();
    if (currentPlayer.id !== userId) {
        event.reply("未到您进行抢地主");
        return;
    }

    game.robLandlord(currentPlayer, false);
    // 三个人都不抢 → 重洗重发，重选一个人先表态
    if (game.notRobLandlordCount >= game.players.length) {
        event.reply("三个人都不抢地主，重新发牌。");
        redeal(game);
        sendHands(game, room);
        event.reply(startRobText(game));
        return;
    }
    event.reply(currentPlayer.name + " 不抢地主，轮到 " + game.getCurrentPlayer().name + " 表态：cc抢 / cc不");
}

// 重新发牌：留人、清手牌、重洗重叫
function redeal(game) {
    const players = game.players;
    for (const player of players) {
        player.cards = [];
    }
    game.reset();
    game.players = players;
    game.initGame();
    game.currentPlayerIndex = Math.floor(Math.random() * players.length);
}

module.exports = { dontBeLandlordsCommand };
