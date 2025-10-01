require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const CONFIG = {
  telegram: {
    token: process.env.BOT_TOKEN,
    options: { polling: true },
  },
  api: {
    baseUrl: process.env.API_BASE_URL,
    formId: process.env.FORM_ID,
  },
  yandex: {
    apiKey: process.env.YANDEX_API_KEY,
    ttsUrl: "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize",
    sttUrl: "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
  },
};

const bot = new TelegramBot(CONFIG.telegram.token, CONFIG.telegram.options);
const userSessions = new Map();

class YandexSpeech {
  static async textToSpeech(chatId, text) {
    try {
      const response = await axios.post(
        CONFIG.yandex.ttsUrl,
        new URLSearchParams({
          text: text,
          lang: "ru-RU",
          voice: "alena",
          emotion: "neutral",
          speed: "0.9",
          format: "oggopus",
        }),
        {
          headers: {
            Authorization: `Api-Key ${CONFIG.yandex.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          responseType: "arraybuffer",
        }
      );

      const fileName = `voice_${chatId}_${Date.now()}.ogg`;
      const filePath = path.join(__dirname, "temp", fileName);

      if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      }
      fs.writeFileSync(filePath, Buffer.from(response.data));

      await bot.sendVoice(chatId, filePath, { contentType: "audio/ogg" });

      setTimeout(() => {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }, 5000);
    } catch (error) {
      console.error("TTS Error:", error.message);
    }
  }
  static async speechToText(audioBuffer) {
    try {
      const response = await axios.post(CONFIG.yandex.sttUrl, audioBuffer, {
        headers: {
          Authorization: `Api-Key ${CONFIG.yandex.apiKey}`,
          "Content-Type": "audio/ogg",
        },
        params: {
          lang: "ru-RU",
        },
      });
      return response.data.result || "";
    } catch (error) {
      console.error("STT Error:", error.message);
      return null;
    }
  }
}

class FormAPI {
  static async getQuestions(formId) {
    try {
      const response = await axios.get(
        `${CONFIG.api.baseUrl}/api/form/${formId}/questions/`
      );
      return response.data;
    } catch (error) {
      console.error("API Error (get questions):", error.message);
      throw new Error("Не удалось загрузить вопросы формы");
    }
  }

  static async submitAnswers(formId, answers) {
    try {
      const response = await axios.post(
        `${CONFIG.api.baseUrl}/api/form/${formId}/submit/`,
        answers,
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error("API Error (submit):", error.message);
      throw new Error("Не удалось отправить ответы");
    }
  }
}

class UserSession {
  constructor(userId, respondentId) {
    this.userId = userId;
    this.respondentId = respondentId;
    this.questions = [];
    this.currentQuestionIndex = 0;
    this.answers = {};
    this.waitingForAnswer = false;
  }

  getCurrentQuestion() {
    return this.questions[this.currentQuestionIndex] || null;
  }

  saveAnswer(questionId, answer) {
    this.answers[questionId] = answer;
  }

  nextQuestion() {
    this.currentQuestionIndex++;
    return this.getCurrentQuestion();
  }

  previousQuestion() {
    if (this.currentQuestionIndex > 0) {
      this.currentQuestionIndex--;
    }
    return this.getCurrentQuestion();
  }

  skipQuestion() {
    const current = this.getCurrentQuestion();
    if (current && !current.required) {
      this.currentQuestionIndex++;
      return true;
    }
    return false;
  }

  getProgress() {
    return `Вопрос ${this.currentQuestionIndex + 1} из ${
      this.questions.length
    }`;
  }

  prepareSubmitData() {
    const transformedAnswers = Object.entries(this.answers).map(
      ([questionId, value]) => ({
        question_id: questionId,
        value: value,
      })
    );

    return {
      source: "telegram-bot",
      respondent_identifier: this.respondentId,
      answers: transformedAnswers,
    };
  }
}

function createOptionsKeyboard(options, canSkip = false) {
  const keyboard = [];

  options.forEach((option, index) => {
    keyboard.push([
      {
        text: `${index + 1}. ${option}`,
        callback_data: `answer_${index}`,
      },
    ]);
  });

  const actionRow = [];
  actionRow.push({ text: "Повторить", callback_data: "repeat" });
  actionRow.push({
    text: "Предыдущий вопрос",
    callback_data: "previous_question",
  });

  if (canSkip) {
    actionRow.push({ text: "Пропустить вопрос", callback_data: "skip" });
  }

  keyboard.push(actionRow);

  return {
    inline_keyboard: keyboard,
  };
}

function createControlKeyboard(canSkip = false) {
  const keyboard = [
    [
      { text: "Повторить вопрос", callback_data: "repeat" },
      { text: "Предыдущий вопрос", callback_data: "previous_question" },
    ],
  ];

  if (canSkip) {
    keyboard.push([{ text: "Пропустить вопрос", callback_data: "skip" }]);
  }

  return {
    inline_keyboard: keyboard,
  };
}

async function sendQuestion(chatId, session) {
  const question = session.getCurrentQuestion();

  if (!question) {
    await completeForm(chatId, session);
    return;
  }

  session.waitingForAnswer = true;

  let messageText = `${session.getProgress()}\n\n`;
  messageText += `${question.text}`;

  if (question.hint) {
    messageText += `\n${question.hint}`;
  }

  if (question.required) {
    messageText += `\nОбязательный вопрос`;
  }

  switch (question.q_type) {
    case "select":
      if (question.options_list.length > 0) {
        messageText += `\n\nВыберите вариант ответа или введите его номер:`;

        question.options_list.forEach((option, index) => {
          messageText += `\n${index + 1}. ${option}`;
        });

        await bot.sendMessage(chatId, messageText, {
          parse_mode: "Markdown",
          reply_markup: createOptionsKeyboard(
            question.options_list,
            !question.required
          ),
        });
      }
      break;

    case "checkbox":
      messageText += `\n\nНажмите на кнопку  или введите: 1`;
      await bot.sendMessage(chatId, messageText, {
        parse_mode: "Markdown",
        reply_markup: createOptionsKeyboard(
          question.options_list || ["Да"],
          !question.required
        ),
      });
      break;

    case "date":
      messageText += `\n\nВведите дату в формате полного календарного формата даты через точку (например, 15.03.1990)`;
      await bot.sendMessage(chatId, messageText, {
        parse_mode: "Markdown",
        reply_markup: createControlKeyboard(!question.required),
      });
      break;

    case "textarea":
      messageText += `\n\nВведите развернутый ответ`;
      await bot.sendMessage(chatId, messageText, {
        parse_mode: "Markdown",
        reply_markup: createControlKeyboard(!question.required),
      });
      break;

    default:
      messageText += `\n\nВведите ваш ответ`;
      await bot.sendMessage(chatId, messageText, {
        parse_mode: "Markdown",
        reply_markup: createControlKeyboard(!question.required),
      });
      break;
  }
  await YandexSpeech.textToSpeech(chatId, messageText);
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  await YandexSpeech.textToSpeech(
    chatId,
    "Добро пожаловать в бот для анкетирования! Выберите версию опроса. 1 - Версия для незрячих 2 - Стандартная верси. Вы можете нажать на кнопку или ввести номер варианта."
  );

  const keyboard = {
    inline_keyboard: [
      [{ text: "Версия для незрячих", callback_data: "blind_version" }],
      [{ text: "Стандартная версия", callback_data: "standard_version" }],
    ],
  };

  await bot.sendMessage(
    chatId,
    "Добро пожаловать в бот для анкетирования!\n\nВыберите версию опроса:\n\n1 - Версия для незрячих\n2 - Стандартная версия\n\nВы можете нажать на кнопку или ввести номер варианта.",
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const respondentId = query.from.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  const session = userSessions.get(chatId);

  switch (data) {
    case "blind_version":
      await startBlindVersion(chatId, respondentId);
      break;

    case "standard_version":
      await bot.sendMessage(
        chatId,
        "Для прохождения стандартной версии опроса, пожалуйста, перейдите по ссылке:\n\n[Открыть форму](https://forms.yandex.ru)",
        { parse_mode: "Markdown" }
      );
      break;

    case "repeat":
      if (session) {
        await sendQuestion(chatId, session);
      }
      break;

    case "previous_question":
      if (session) {
        await session.previousQuestion();
        await YandexSpeech.textToSpeech(chatId, "Предыдущий вопрос");
        await bot.sendMessage(chatId, "Предыдущий вопрос");
        await sendQuestion(chatId, session);
      }
      break;

    case "skip":
      if (session) {
        const skipped = session.skipQuestion();
        if (skipped) {
          await YandexSpeech.textToSpeech(chatId, "Вопрос пропущен");
          await bot.sendMessage(chatId, "Вопрос пропущен");
          await sendQuestion(chatId, session);
        } else {
          await YandexSpeech.textToSpeech(
            chatId,
            "Этот вопрос обязателен для ответа"
          );
          await bot.sendMessage(chatId, "Этот вопрос обязателен для ответа");
        }
      }
      break;

    case "restart":
      await startBlindVersion(chatId, respondentId);
      break;

    case "home":
      await YandexSpeech.textToSpeech(
        chatId,
        "Добро пожаловать в бот для анкетирования! Выберите версию опроса. 1 - Версия для незрячих 2 - Стандартная верси. Вы можете нажать на кнопку или ввести номер варианта."
      );

      const keyboard = {
        inline_keyboard: [
          [{ text: "Версия для незрячих", callback_data: "blind_version" }],
          [{ text: "Стандартная версия", callback_data: "standard_version" }],
        ],
      };

      await bot.sendMessage(
        chatId,
        "Добро пожаловать в бот для анкетирования!\n\nВыберите версию опроса:\n\n1 - Версия для незрячих\n2 - Стандартная версия\n\nВы можете нажать на кнопку или ввести номер варианта.",
        { parse_mode: "Markdown", reply_markup: keyboard }
      );
      userSessions.delete(chatId);
      break;

    default:
      if (data.startsWith("answer_")) {
        if (session) {
          const optionIndex = parseInt(data.split("_")[1]);
          const question = session.getCurrentQuestion();

          if (question && question.options_list[optionIndex]) {
            await processAnswer(
              chatId,
              session,
              question.options_list[optionIndex]
            );
          }
        }
      }
      break;
  }
});

async function startBlindVersion(chatId, respondentId) {
  try {
    const questions = await FormAPI.getQuestions(CONFIG.api.formId);

    const session = new UserSession(chatId, respondentId);
    session.questions = questions;
    userSessions.set(chatId, session);

    const instructionText =
      "Инструкция по работе с ботом:\n\n" +
      "Бот будет задавать вопросы по одному\n" +
      "Вы можете отвечать текстом или голосом\n" +
      "Для выбора варианта введите его номер\n" +
      "Введите 0 или нажмите кнопку для повтора или скажите фразу 'повторить' или 'повторить вопрос' в голосовое сообщение\n" +
      "Для возврата к предыдущему вопросу нужно ввести или отправить голосовое сообщение с словом 'назад' или 'предыдущий вопрос'\n" +
      "Необязательные вопросы можно пропустить с помощью написания или отправки голосового сообщения со словом 'пропустить' или 'пропустить вопрос'\n\n" +
      "Начинаем!";

    await bot.sendMessage(chatId, instructionText, { parse_mode: "Markdown" });
    await YandexSpeech.textToSpeech(chatId, instructionText);

    await sendQuestion(chatId, session);
  } catch (error) {
    await YandexSpeech.textToSpeech(
      chatId,
      "Ошибка при загрузке вопросов. Попробуйте позже."
    );
    await bot.sendMessage(
      chatId,
      "Ошибка при загрузке вопросов. Попробуйте позже."
    );
    console.error("Form loading error:", error);
  }
}

bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const respondentId = msg.from.id;
  const text = msg.text ? msg.text.trim().toLowerCase() : "";

  if (text === "1" && !userSessions.has(chatId)) {
    await startBlindVersion(chatId, respondentId);
    return;
  }

  if (text === "2" && !userSessions.has(chatId)) {
    await bot.sendMessage(
      chatId,
      "Для прохождения стандартной версии опроса, пожалуйста, перейдите по ссылке:\n\n[Открыть форму](https://forms.yandex.ru)",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const session = userSessions.get(chatId);

  if (!session) return;

  if (text === "0" || text === "повторить" || text === "повторить вопрос") {
    await sendQuestion(chatId, session);
    return;
  }

  if (text === "назад" || text === "предыдущий вопрос") {
    await session.previousQuestion();
    await YandexSpeech.textToSpeech(chatId, "Предыдущий вопрос");
    await bot.sendMessage(chatId, "Предыдущий вопрос");
    await sendQuestion(chatId, session);
    return;
  }

  if (text === "пропустить" || text === "пропустить вопрос") {
    const skipped = session.skipQuestion();
    if (skipped) {
      await YandexSpeech.textToSpeech(chatId, "Вопрос пропущен");
      await bot.sendMessage(chatId, "Вопрос пропущен");
      await sendQuestion(chatId, session);
    } else {
      await YandexSpeech.textToSpeech(
        chatId,
        "Этот вопрос обязателен для ответа"
      );
      await bot.sendMessage(chatId, "Этот вопрос обязателен для ответа");
    }
    return;
  }

  if (!session.waitingForAnswer) {
    if (text === "1") {
      await startBlindVersion(chatId, respondentId);
      return;
    }
    if (text === "2" || text === "на главную") {
      bot.emit("message", {
        chat: { id: chatId },
        from: { id: respondentId },
        text: "/start",
      });
      return;
    }
    return;
  }

  const question = session.getCurrentQuestion();
  if (!question) return;

  if (
    (question.q_type === "select" || question.q_type === "checkbox") &&
    question.options_list.length > 0
  ) {
    const num = parseInt(text);
    if (num > 0 && num <= question.options_list.length) {
      await processAnswer(chatId, session, question.options_list[num - 1]);
      return;
    }
  }

  if (msg.text && msg.text.trim()) {
    await processAnswer(chatId, session, msg.text.trim());
  }
});

bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);

  if (!session || !session.waitingForAnswer) return;

  try {
    await bot.sendMessage(chatId, "Распознавание речи...");

    const fileId = msg.voice.file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${CONFIG.telegram.token}/${file.file_path}`;

    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const audioBuffer = Buffer.from(response.data);

    const recognizedText = await YandexSpeech.speechToText(audioBuffer);

    if (recognizedText) {
      await YandexSpeech.textToSpeech(
        chatId,
        `Распознано: "${recognizedText}"`
      );
      await bot.sendMessage(chatId, `Распознано: "${recognizedText}"`);

      const normalizedText = recognizedText.trim().toLowerCase();
      const question = session.getCurrentQuestion();

      if (
        normalizedText === "повторить" ||
        normalizedText === "повторить вопрос" ||
        normalizedText === "0"
      ) {
        await sendQuestion(chatId, session);
        return;
      }

      if (
        normalizedText === "назад" ||
        normalizedText === "предыдущий вопрос"
      ) {
        await session.previousQuestion();
        await YandexSpeech.textToSpeech(chatId, "Предыдущий вопрос");
        await bot.sendMessage(chatId, "Предыдущий вопрос");
        await sendQuestion(chatId, session);
        return;
      }

      if (
        normalizedText === "пропустить" ||
        normalizedText === "пропустить вопрос"
      ) {
        const skipped = session.skipQuestion();
        if (skipped) {
          await YandexSpeech.textToSpeech(chatId, "Вопрос пропущен");
          await bot.sendMessage(chatId, "Вопрос пропущен");
          await sendQuestion(chatId, session);
        } else {
          await YandexSpeech.textToSpeech(
            chatId,
            "Этот вопрос обязателен для ответа"
          );
          await bot.sendMessage(chatId, "Этот вопрос обязателен для ответа");
        }
        return;
      }

      if (
        question &&
        (question.q_type === "select" || question.q_type === "checkbox") &&
        question.options_list.length > 0
      ) {
        const num = parseInt(normalizedText);
        if (num > 0 && num <= question.options_list.length) {
          await processAnswer(chatId, session, question.options_list[num - 1]);
          return;
        }

        const matchedOption = question.options_list.find(
          (option) => option.toLowerCase() === normalizedText
        );

        if (matchedOption) {
          await processAnswer(chatId, session, matchedOption);
          return;
        }

        const partialMatch = question.options_list.find(
          (option) =>
            option.toLowerCase().includes(normalizedText) ||
            normalizedText.includes(option.toLowerCase())
        );

        if (partialMatch) {
          await YandexSpeech.textToSpeech(
            chatId,
            `Вы имели в виду вариант: "${partialMatch}"? Подтвердите или повторите ответ.`
          );
          await bot.sendMessage(
            chatId,
            `Вы имели в виду вариант: "${partialMatch}"?\n\nНажмите кнопку для подтверждения или повторите ответ.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: `Да, ${partialMatch}`,
                      callback_data: `answer_${question.options_list.indexOf(
                        partialMatch
                      )}`,
                    },
                  ],
                  [{ text: "Повторить вопрос", callback_data: "repeat" }],
                ],
              },
            }
          );
          return;
        }

        await YandexSpeech.textToSpeech(
          chatId,
          `Ответ не соответствует доступным вариантам. Введите номер варианта от 1 до ${question.options_list.length} или произнесите точное название варианта.`
        );
        await bot.sendMessage(
          chatId,
          `Ответ не соответствует доступным вариантам.\n\nДоступные варианты:\n${question.options_list
            .map((opt, i) => `${i + 1}. ${opt}`)
            .join(
              "\n"
            )}\n\nВведите номер варианта или произнесите точное название.`
        );
        return;
      }

      await processAnswer(chatId, session, recognizedText);
    } else {
      await YandexSpeech.textToSpeech(
        chatId,
        "Не удалось распознать речь. Попробуйте еще раз."
      );
      await bot.sendMessage(
        chatId,
        "Не удалось распознать речь. Попробуйте еще раз."
      );
    }
  } catch (error) {
    console.error("Voice processing error:", error);
    await YandexSpeech.textToSpeech(
      chatId,
      "Ошибка обработки голосового сообщения"
    );
    await bot.sendMessage(chatId, "Ошибка обработки голосового сообщения");
  }
});

async function processAnswer(chatId, session, answer) {
  const question = session.getCurrentQuestion();

  if (!question) return;

  if (question.q_type === "date") {
    const dateRegex = /^\d{2}\.\d{2}\.\d{4}$/;
    if (!dateRegex.test(answer)) {
      await YandexSpeech.textToSpeech(
        chatId,
        "Неверный формат даты. Используйте полный календарный формато даты (например, 15.03.1990)"
      );
      await bot.sendMessage(
        chatId,
        "Неверный формат даты. Используйте полный календарный формато даты (например, 15.03.1990)"
      );
      return;
    }
  }

  if (
    question.q_type === "text" &&
    question.hint &&
    question.hint.includes("+7")
  ) {
    if (!answer.startsWith("+7") && !answer.startsWith("8")) {
      await YandexSpeech.textToSpeech(
        chatId,
        "Номер телефона должен начинаться с +7 или 8"
      );
      await bot.sendMessage(
        chatId,
        "Номер телефона должен начинаться с +7 или 8"
      );
      return;
    }
  }

  session.saveAnswer(question.id, answer);
  session.waitingForAnswer = false;

  await YandexSpeech.textToSpeech(chatId, `Ответ сохранен: ${answer}`);
  await bot.sendMessage(chatId, `Ответ сохранен: ${answer}`);

  session.nextQuestion();

  setTimeout(() => {
    sendQuestion(chatId, session);
  }, 500);
}

async function completeForm(chatId, session) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "Заполнить форму еще раз", callback_data: "restart" }],
      [{ text: "На главную", callback_data: "home" }],
    ],
  };
  try {
    const submitData = session.prepareSubmitData();

    await YandexSpeech.textToSpeech(chatId, "Отправка ответов...");
    await bot.sendMessage(chatId, "Отправка ответов...");

    await FormAPI.submitAnswers(CONFIG.api.formId, submitData);
    await YandexSpeech.textToSpeech(
      chatId,
      "Опрос завершен. Спасибо за ваши ответы. 1 - Заполнить форму еще раз 2 - Вернуться на главную"
    );
    await bot.sendMessage(
      chatId,
      "Опрос завершен!\n\nСпасибо за ваши ответы.\n\nВведите:\n1 - Заполнить форму еще раз\n2 - Вернуться на главную",
      { parse_mode: "Markdown", reply_markup: keyboard }
    );

    userSessions.delete(chatId);
  } catch (error) {
    userSessions.delete(chatId);
    await YandexSpeech.textToSpeech(
      chatId,
      "Произошла ошибка при отправке ответов. Попробуйте позже.",
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    await bot.sendMessage(
      chatId,
      "Произошла ошибка при отправке ответов. Попробуйте позже.",
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
    console.error("Submit error:", error);
  }
}

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

const tempDir = path.join(__dirname, "temp");
if (fs.existsSync(tempDir)) {
  fs.readdirSync(tempDir).forEach((file) => {
    fs.unlinkSync(path.join(tempDir, file));
  });
}

console.log("Бот запущен и готов к работе");
console.log(`ID формы: ${CONFIG.api.formId}`);
console.log(`API: ${CONFIG.api.baseUrl}`);
