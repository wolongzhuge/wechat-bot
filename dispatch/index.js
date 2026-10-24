"use strict";
// 稳定的消息分发器：client.on 只在这里注册一次（钉住，不参与热重载）。
// message/ 下的处理器热重载时只换槽位 —— 加载成功才替换，失败旧代码原样继续跑，
// 也永远不会出现监听器挂两遍的问题。

const { client } = require("../app");

const handlers = {
    group: null,   // (event) => void
    private: null, // (event) => void
};

client.on("message.group", (event) => {
    if (handlers.group) handlers.group(event);
});
client.on("message.private", (event) => {
    if (handlers.private) handlers.private(event);
});

module.exports = {
    register(kind, fn) {
        handlers[kind] = fn;
    },
    // 暴露给测试用：断言热重载后槽位确实换了、失败时确实没换
    handlers,
};
