"use strict";
// 文件监听：message/ command/ 下任意 .js 变化，防抖 300ms 后整树热重载。
// 只监听不改代码，重载逻辑全在 reloader.js。env 里 hot_reload=false 可以关掉。

const fs = require("fs");
const path = require("path");
const { reloadAll } = require("./reloader");

function startWatcher() {
    const root = path.join(__dirname, "..");
    let timer = null;
    const pending = new Set();

    for (const dir of ["message", "command", "dou"]) {
        const abs = path.join(root, dir);
        const watcher = fs.watch(abs, { recursive: true }, (eventType, filename) => {
            if (!filename || !filename.endsWith(".js")) return;
            pending.add(path.join(dir, filename));
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const changed = [...pending];
                pending.clear();
                console.log("检测到代码变化：" + changed.join("、") + "，热重载中");
                const report = reloadAll();
                console.log("热重载完成：\n  " + report.join("\n  "));
            }, 300);
        });
        watcher.on("error", (err) => console.error("监听 " + abs + " 失败: " + err.message));
    }
    console.log("热更新监听已开启（改 message/ command/ dou/ 下的 .js 即自动生效，无需重启）");
}

module.exports = { startWatcher };
