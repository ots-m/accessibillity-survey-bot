const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
require("dotenv").config();

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

console.log("accessibility survey bot запущен");

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || "Пользователь";

  const welcomeText = `Добро пожаловать, ${userName}!`;

  bot.sendMessage(chatId, welcomeText);
});
