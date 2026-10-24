"use strict";

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
require("dotenv").config();

const default_system_role = process.env.system_role || "";
const clear_keywords = (process.env.clear_keywords || "清空,早安,午安,晚安").split(",").map((s) => s.trim()).filter(Boolean);
const openai_api_key = process.env.openai_api_key;
const base_path = process.env.base_path || "https://api.openai.com/v1";
const model = process.env.model || "gpt-3.5-turbo";

let temperature = parseFloat(process.env.temperature);
if (isNaN(temperature) || temperature < 0 || temperature > 2) temperature = 1.0;
let max_token = parseInt(process.env.max_token, 10);
if (!max_token || max_token <= 0) max_token = 2048;

const client = openai_api_key && !/xxxx/.test(openai_api_key)
    ? new OpenAI({ apiKey: openai_api_key, baseURL: base_path })
    : null;

const HISTORY_DIR = path.join(__dirname, "..", "data", "chat");

function historyFile(uid) {
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    // wxid 里带 @ 和 = 等字符，落到文件名前要安全化
    return path.join(HISTORY_DIR, String(uid).replace(/[^A-Za-z0-9_.-]/g, "_") + ".json");
}

function read_history(uid) {
    const file = historyFile(uid);
    if (!fs.existsSync(file)) return [];
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        console.error(err);
        return [];
    }
}

function save_history(uid, history) {
    try {
        // 只保留最近 20 轮，避免上下文无限膨胀
        fs.writeFileSync(historyFile(uid), JSON.stringify(history.slice(-40)), "utf8");
    } catch (err) {
        console.error(err);
    }
}

function clear_history(uid) {
    const file = historyFile(uid);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

function should_clear(message) {
    return clear_keywords.some((k) => k && message.includes(k));
}

// 只保留最近若干条，超过就掐头，微信消息比 QQ 更容易踩 token 上限
function trim_messages(messages) {
    const system = messages.slice(0, 1);
    const rest = messages.slice(1);
    const MAX_CHARS = 12000;
    let total = rest.reduce((n, m) => n + m.content.length, 0);
    while (rest.length > 2 && total > MAX_CHARS) {
        total -= rest.shift().content.length;
    }
    return system.concat(rest);
}

async function reply_normal_message(uid = "default", received_message = "") {
    if (should_clear(received_message)) {
        clear_history(uid);
        return "好的，我们重新认识一下。";
    }
    if (!client) {
        return "还没配置 openai_api_key，我先回你一句：" + received_message;
    }

    const history = read_history(uid);
    const messages = [
        { role: "system", content: default_system_role || "你是一个友好的聊天机器人，用简洁口语化的中文回复。" },
        ...history,
        { role: "user", content: received_message },
    ];

    try {
        const completion = await client.chat.completions.create({
            model: model,
            messages: trim_messages(messages),
            max_tokens: max_token,
            temperature: temperature,
        });
        const reply = completion.choices[0].message.content || "(空回复)";
        history.push({ role: "user", content: received_message });
        history.push({ role: "assistant", content: reply });
        save_history(uid, history);
        return reply;
    } catch (error) {
        const detail = error.response && error.response.data && error.response.data.error
            ? error.response.data.error.message
            : error.message;
        console.error("OpenAI 调用失败: " + detail);
        return "我这边接口出错了：" + detail;
    }
}

module.exports = { reply_normal_message, should_clear, clear_history, read_history };
