const gameMap = require("./gameMap");
const {FindMusic} = require("./api/souge/findMusic")

function souGeCommand(event, raw_message) {
    const contentTrim = raw_message; //过滤出说话内容

    const souGeName = "souge:" + event.group_id;
    let game = gameMap.get(souGeName); //设置搜索歌曲房间信息
    console.log("开始找歌")
    if (contentTrim.startsWith("搜歌")) {
        console.log("搜歌")
        gameMap.delete(souGeName);

        const souGe = new FindMusic();

        gameMap.set(souGeName, souGe);
        souGe.initMusic(contentTrim.slice(2)).then(data => {
            // let word = "";
            // data.content.forEach(item => {     //遍历json
            //     word += (item + "\n");
            // });
            event.reply(data);
        });
    } else if (contentTrim.startsWith("选歌")) {
        if (!game) {
            event.reply("还没开始搜歌")
        } else {
            game.getMusic(contentTrim.slice(2)).then(data => {
                //const jsonDataString = JSON.stringify(data.data); // 将JSON数据转换为字符串
                event.reply(data);
            });
        }

    }
}

module.exports = {souGeCommand};

