// 加入游戏命令：上桌前先验好友——牌是私聊发的，不是好友收不到
const { isPlayerInGame, sendHands, startRobText } = require("./utils");
const gameMap = require("./gameMap");
const { client } = require("../../app");

async function joinGameCommand(event, raw_message) {
    const room = event.group_id;

    const userId = event.sender.user_id;
    // 获取游戏
    const game = gameMap.get(room);
    // 如果游戏不存在
    if (!game) {
        event.reply("游戏不存在，请先创建游戏");
        return;
    }

    // iPad 协议没有临时会话，私聊发牌必须先互为好友，否则坐下就是死局
    if (!(await client.isFriend(userId))) {
        event.reply("您还不是机器人的好友，收不到私聊发的牌，先加机器人好友再来上桌。");
        return;
    }

    // 如果已经在游戏中
    if (isPlayerInGame(game, userId)) {
        event.reply("您已经在游戏中，请勿重复加入");
        return;
    }

    // 如果游戏已经开始
    if (game.status >= 1) {
        event.reply("游戏已经开始，无法加入");
        return;
    }

    game.addPlayer(userId, client.displayName(userId));
    event.reply("加入游戏成功，当前游戏人数：" + game.players.length);

    // 当游戏人数达到3人时，开始分牌
    if (game.players.length === 3) {
        game.initGame();
        // 随机选一个玩家先表态抢地主
        game.currentPlayerIndex = Math.floor(Math.random() * game.players.length);
        sendHands(game, room);
        event.reply(startRobText(game));
    }
}

module.exports = { joinGameCommand };
