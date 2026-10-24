const {chatCommand} = require("./ChatCommand")
// 根据message的内容，得到对应的命令
function getGptCommand(event,raw_message) {
    console.log("chatGpt start")
    if (event.message != null) {
        chatCommand(event, raw_message).then()
    }
}

module.exports = {
    getGptCommand
}
