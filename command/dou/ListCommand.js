const fileUtil = require("../../utils/fileUtils");
const {client} = require("../../app");

function listCommand(event) {
    const list = fileUtil.getWinRate(client.displayName.bind(client));
    if (!list) {
        event.reply("暂无胜率榜")
    } else {
        event.reply(list);
    }
}

module.exports = {listCommand};
