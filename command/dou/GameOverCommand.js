// 结束命令
const {isPlayerInGame} = require("./utils");
const gameMap = require("./gameMap");

function gameOverCommand(event, raw_message) {
    const room = event.group_id;
    const contact = event.sender.user_id;
    // 获取游戏
    const game = gameMap.get(room);
    // 如果游戏不存在
    if (!game) {
        event.reply("游戏已经结束");
        return;
    }

    // 不在游戏中
    if (!isPlayerInGame(game, contact)) {
        event.reply("您不在游戏中，无法结束游戏");
        return;
    }


    if (game && game.status <= 1) {
        if (raw_message.includes("结束")) {
            event.reply("本次斗地主结束");
            gameMap.delete(room);
        }
    } else {
        event.reply("游戏已经开始，无法结束");

    }
}


module.exports = {gameOverCommand};
