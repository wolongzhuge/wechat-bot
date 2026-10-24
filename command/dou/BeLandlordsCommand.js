// 抢地主命令：谁先抢谁立刻当地主（没有反抢），底牌当场并给地主
const { isPlayerInGame } = require("./utils");
const gameMap = require("./gameMap");
const { client } = require("../../app");

function beLandlordsCommand(event) {
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

    // 抢下就是地主：这一刻把三张底牌并进手牌，直接进入出牌阶段
    game.robLandlord(currentPlayer, true);
    game.drawBottomCards(game.landlord);
    client.sendTempMsg(
        room,
        currentPlayer.id,
        "您是地主，底牌已并入，您的牌（" + currentPlayer.cards.length + " 张）：" + currentPlayer.cards.join(",")
    ).then();
    event.reply(
        "斗地主游戏正式开始，地主是：" + currentPlayer.name + "\n" +
        "底牌是：" + game.bottomCards.join(",") + "\n" +
        currentPlayer.name + " 先出牌。出牌：cc334455 或 cc出334455，不要就 cc过"
    );
}

module.exports = { beLandlordsCommand };
