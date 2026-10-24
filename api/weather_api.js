"use strict";

const axios = require("axios");
require("dotenv").config();

const weather_api_key = process.env.weather_api_key || "";
const is_weather_on = (process.env.weather || "false") === "true";

const GEO_URL = "https://geoapi.qweather.com/v2/city/lookup";
const NOW_URL = "https://devapi.qweather.com/v7/weather/now";

async function getCity(city_name) {
    const res = await axios.get(GEO_URL, { params: { key: weather_api_key, location: city_name }, timeout: 15000 });
    if (!res.data || res.data.code !== "200" || !res.data.location || !res.data.location.length) {
        throw new Error("找不到城市：" + city_name);
    }
    return res.data.location[0];
}

async function getWeatherInternal(location_id) {
    const res = await axios.get(NOW_URL, { params: { key: weather_api_key, location: location_id }, timeout: 15000 });
    return res.data;
}

async function getWeatherText(city_name) {
    const city = await getCity(city_name);
    const data = await getWeatherInternal(city.id);
    if (!data || data.code !== "200" || !data.now) {
        return "查询失败：" + (data && data.code ? data.code : "无返回");
    }
    const now = data.now;
    let text = `${city.name} ${now.obsTime || ""}\n${now.text} ${now.temp}℃  体感 ${now.feelsLike}℃  湿度 ${now.humidity}%`;
    text += `\n风：${now.windDir} ${now.windScale}级 ${now.windSpeed}km/h`;
    if (Number(now.precip) > 0) text += `\n降水：${now.precip}mm`;
    return text;
}

async function reply_weather(city_name, event) {
    if (!is_weather_on || !weather_api_key) {
        return event.reply("天气功能未开启，请在 .env 里配置 weather=true 与 weather_api_key");
    }
    try {
        event.reply(await getWeatherText(city_name.replace(/^天气/, "").trim()));
    } catch (err) {
        event.reply("查询失败：" + err.message);
    }
}

module.exports = { reply_weather, getWeatherText };
