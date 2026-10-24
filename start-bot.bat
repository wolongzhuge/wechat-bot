@echo off
rem 启动微信机器人。窗口开着 = 机器人在跑；关掉这个窗口 = 机器人停止。
rem 崩溃会自动重启，日志追加写在 logs\bot.out。
title wechat-bot (keep this window open)
cd /d D:\wechat-bot
:loop
echo [%date% %time%] bot start
node app.js >> logs\bot.out 2>&1
echo [%date% %time%] bot exited, restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
