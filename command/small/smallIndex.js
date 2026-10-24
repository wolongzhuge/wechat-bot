const { souGeCommand } = require("./SouGeCommand");
const { wifeCommand } = require("./WifeCommand");
const { KFCvFiftyCommand } = require("./KFCvFiftyCommand");
const { suijiCommand } = require("./SuijiCommand");
const { reply_weather } = require("../../api/weather_api");
const { reloadAll } = require("../../hot/reloader");

// 手动触发热重载：改完代码不用重启，发 cc热更 立刻生效（牌局状态保留）
function hotReloadCommand(event) {
    const report = reloadAll();
    const failed = report.filter((line) => line.startsWith("FAIL"));
    if (!failed.length) {
        return event.reply("热更完成，已重载 " + report.length + " 个处理器（牌局状态已落盘保留）。");
    }
    return event.reply("热更部分失败，旧代码继续在跑：\n" + failed.join("\n"));
}

// 根据message的内容，得到对应的命令
function getSmallCommand(event, raw_message) {
    if (raw_message.startsWith("搜歌") || raw_message.startsWith("选歌")) {
        souGeCommand(event, raw_message);
    } else if (raw_message.startsWith("发病")) {
        wifeCommand(event, raw_message);
    } else if (raw_message.startsWith("肯德基")) {
        KFCvFiftyCommand(event, raw_message);
    } else if (raw_message.startsWith("随机图片")) {
        suijiCommand(event, raw_message);
    } else if (raw_message.startsWith("天气")) {
        reply_weather(raw_message, event);
    } else if (raw_message.startsWith("热更") || raw_message.startsWith("热重载")) {
        hotReloadCommand(event);
    }
}

module.exports = {
    getSmallCommand,
};
