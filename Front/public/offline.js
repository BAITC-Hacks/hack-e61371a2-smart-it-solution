(() => {
  const language = (navigator.language || 'ru').slice(0, 2);
  const locale = language === 'ru' || language === 'kk' ? language : 'en';
  const messages = {
    ru: ['Нет подключения', 'Подключитесь к интернету, чтобы открыть своё пространство. Личные данные не сохраняются для просмотра без сети.', 'Открыть снова'],
    kk: ['Қосылым жоқ', 'Кеңістігіңізді ашу үшін интернетке қосылыңыз. Жеке деректер желісіз көру үшін сақталмайды.', 'Қайта ашу'],
    en: ['You are offline', 'Connect to the internet to open your workspace. Personal data is not stored for offline viewing.', 'Try again'],
  };
  document.documentElement.lang = locale;
  ['title', 'text', 'retry'].forEach((id, index) => {
    const element = document.getElementById(id);
    if (element) element.textContent = messages[locale][index];
  });
})();
