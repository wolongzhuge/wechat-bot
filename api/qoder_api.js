"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config();

const clear_keywords = (process.env.clear_keywords || "清空,再见,早安,午安,晚安").split(",").map((s) => s.trim()).filter(Boolean);

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

// Qoder CLI 是一次性问答，没有会话续接，所以把历史压进 prompt 前面。
// 上限按字符掐，微信一条消息 2000 字就会被协议层切开。
function build_prompt(history, received_message) {
    const persona = process.env.system_role || "你在扮演一个微信聊天机器人，用简洁口语化的中文回复，不要长篇大论。";
    const recent = history.slice(-12);
    let transcript = "";
    let budget = 6000;
    for (let i = recent.length - 1; i >= 0; i--) {
        const line = (recent[i].role === "user" ? "对方: " : "我: ") + recent[i].content + "\n";
        if (budget - line.length < 0) break;
        budget -= line.length;
        transcript = line + transcript;
    }
    const head = persona + "\n\n" + (transcript ? "前面的对话：\n" + transcript + "\n" : "");
    return head + "对方现在说：" + received_message;
}

function resolveCli() {
    const bin = process.env.qoder_cli_bin || "qoderclicn";
    return { bin, needsShell: /\.(cmd|bat)$/i.test(bin) || !process.env.qoder_cli_bin };
}

// 管理员终端要按模型切换，模型参数走这个模板（qoderclicn 用 -m）
const modelArgTemplate = process.env.qoder_cli_model_arg || "-m {model}";

function runQoder(prompt, opts) {
    const { bin, needsShell } = resolveCli();
    let parts = (process.env.qoder_cli_args || "-p {prompt}").split(" ");
    if (opts && opts.model) {
        const extra = modelArgTemplate.replace("{model}", opts.model).trim();
        if (extra) parts = parts.concat(extra.split(" "));
    }
    const args = parts.map((a) => (a === "{prompt}" ? prompt : a.replace("{prompt}", prompt)));
    const timeoutMs = parseInt(process.env.qoder_timeout_ms || "180000", 10);

    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true, shell: needsShell });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Qoder 回答超时（" + Math.round(timeoutMs / 1000) + "s）"));
        }, timeoutMs);
        child.stdout.on("data", (b) => (out += b));
        child.stderr.on("data", (b) => (err += b));
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e.code === "ENOENT"
                ? new Error("找不到 Qoder CLI（" + bin + "）。装它，或在 .env 里写 qoder_cli_bin=<绝对路径>")
                : e);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0 && !out.trim()) return reject(new Error("Qoder CLI 退出码 " + code + " " + err.slice(0, 200)));
            resolve(out.trim());
        });
    });
}

async function reply_normal_message(uid = "default", received_message = "") {
    if (should_clear(received_message)) {
        clear_history(uid);
        return "好的，我们重新认识一下。";
    }

    const history = read_history(uid);
    try {
        const reply = (await runQoder(build_prompt(history, received_message))) || "(空回复)";
        history.push({ role: "user", content: received_message });
        history.push({ role: "assistant", content: reply });
        save_history(uid, history);
        return reply;
    } catch (error) {
        console.error("Qoder 调用失败: " + error.message);
        return "我这边问 Qoder 失败了：" + error.message;
    }
}

module.exports = { reply_normal_message, should_clear, clear_history, read_history, runQoder };
