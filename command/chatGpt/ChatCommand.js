const { ChatGpt } = require("../../gpt/gpt");

const GPT = new ChatGpt();

async function chatCommand(event, raw_message) {
    // 按「群+人」隔离上下文，比 QQ 版按群共享更贴合微信的用法
    const uid = event.type === "group" ? event.group_id + ":" + event.sender.user_id : event.sender.user_id;
    const reply = await GPT.post(raw_message, uid, event);
    if (reply) event.reply(reply);
}

module.exports = { chatCommand };
