const axios = require('axios');

function wifeCommand(event, raw_message) {
    fetchData(raw_message.slice(2))
        .then(data => {
            console.log(data)
            event.reply(data.data)
        })
        .catch()
}

function fetchData(name) {
    return axios.get("https://api.lolimi.cn/API/fabing/fb.php?name=" + name)
        .then(response => response.data)
        .catch(error => {
            console.error('Error fetching data:', error);
        });
}


module.exports = {wifeCommand};
