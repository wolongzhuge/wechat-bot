const axios = require("axios");
const { reply_normal_message } = require("../api/openai_api");

class ChatGpt {
    constructor() {
        this.lolimi = "https://api.lolimi.cn/API/AI";
    }

    async _lolimi(kind, msg, event) {
        const res = await axios.get(this.lolimi + "/" + kind + ".php", { params: { msg }, timeout: 20000 });
        const out = res.data && res.data.data && res.data.data.output;
        if (!out) throw new Error("lolimi 接口没有返回内容");
        event.reply(String(out));
        return String(out);
    }

    // 姐姐/妹妹 走 lolimi 的人设接口，其余走 .env 里配置的 OpenAI 兼容接口
    async post(prompt, id, event) {
        if (prompt.startsWith("姐姐")) return this._lolimi("jj", prompt.slice(2), event);
        if (prompt.startsWith("妹妹")) return this._lolimi("mm", prompt.slice(2), event);
        return reply_normal_message(id, prompt);
    }
}

module.exports = { ChatGpt };
