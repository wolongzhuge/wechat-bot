// 根据message的内容，得到对应的命令
const { beLandlordsCommand } = require("./BeLandlordsCommand")
const { createGameCommand } = require("./CreateGameCommand")
const { dontBeLandlordsCommand } = require("./DontBeLandlordsCommand")
const { listCommand } = require("./ListCommand")
const { statusCommand } = require("./StatusCommand")
const { surrenderCommand } = require("./SurrenderCommand")
const { joinGameCommand } = require("./JoinGameCommand")
const { playCardCommand } = require("./PlayCardCommand")
const { gameOverCommand } = require("./GameOverCommand")

function getDouCommand(event, raw_message) {
    if (raw_message == null) return;
    if (raw_message.includes("胜率榜")) {
        listCommand(event)
    } else if (raw_message === "状态" || raw_message.includes("战况")) {
        statusCommand(event)
    } else if (raw_message.includes("结束")) {
        gameOverCommand(event, raw_message)
    } else if (raw_message === "投降") {
        surrenderCommand(event)
    } else if (raw_message === "抢" || raw_message === "抢地主" || raw_message === "y") {
        beLandlordsCommand(event)
    } else if (raw_message === "不" || raw_message === "不抢" || raw_message === "n") {
        dontBeLandlordsCommand(event)
    } else if (raw_message.includes("斗地主")) {
        return createGameCommand(event)
    } else if (raw_message.includes("上桌")) {
        return joinGameCommand(event)
    } else {
        playCardCommand(event, raw_message)
    }
}

module.exports = {
    getDouCommand
}
