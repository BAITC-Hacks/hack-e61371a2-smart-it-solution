const ru = {
  personal:'Моё пространство', learning:'Развитие', organization:'Организация', administration:'Управление',
  overview:'Обзор', development:'Карьера и навыки', events:'Обучение', growth:'Планы и достижения', history:'История обучения',
  guide:'Путеводитель', assistant:'Помощник', hr:'HR-аналитика', eventsAdmin:'Мероприятия', guideAdmin:'База знаний', growthAdmin:'Программы развития',
  settings:'Настройки организации', notifications:'Уведомления', install:'Установить приложение', installHint:'Открывайте Career Quest в отдельном окне.',
  pageError:'Не удалось показать страницу', pageErrorText:'Попробуйте открыть её ещё раз. Если ошибка повторится, сообщите администратору.', retry:'Повторить',
  profileDevelopment:'Карьера и навыки', profileHistory:'История обучения', toolsTitle:'Всё для следующего шага', toolsText:'Посмотрите возможности обучения, спланируйте развитие и найдите ответ на рабочий вопрос.',
  eventsText:'Каталог, условия участия и ближайшие сессии', guideText:'Проверенные инструкции и каналы обращения', assistantText:'Вопросы о развитии и рабочих ситуациях', growthText:'Планы, наставники и личные достижения', hrText:'Компетенции, участие и следующие шаги команды',
};
type Copy = {[K in keyof typeof ru]: string};
const en:Copy = {
  personal:'My workspace',learning:'Development',organization:'Organization',administration:'Manage',
  overview:'Overview',development:'Career & skills',events:'Learning',growth:'Plans & achievements',history:'Learning history',
  guide:'Employee guide',assistant:'Assistant',hr:'HR insights',eventsAdmin:'Manage activities',guideAdmin:'Knowledge base',growthAdmin:'Development programs',
  settings:'Organization settings',notifications:'Notifications',install:'Install app',installHint:'Open Career Quest in its own window.',
  pageError:'This page could not be displayed',pageErrorText:'Try opening it again. If the problem continues, contact your administrator.',retry:'Try again',
  profileDevelopment:'Career & skills',profileHistory:'Learning history',toolsTitle:'Everything for your next step',toolsText:'Explore learning opportunities, plan your development and find answers to workplace questions.',
  eventsText:'Activities, participation requirements and upcoming sessions',guideText:'Verified instructions and support channels',assistantText:'Questions about development and workplace situations',growthText:'Plans, mentors and private achievements',hrText:'Skills, participation and next steps for the team',
};
const kk:Copy = {
  personal:'Менің кеңістігім',learning:'Даму',organization:'Ұйым',administration:'Басқару',
  overview:'Шолу',development:'Мансап пен дағдылар',events:'Оқу',growth:'Жоспарлар мен жетістіктер',history:'Оқу тарихы',
  guide:'Қызметкер нұсқаулығы',assistant:'Көмекші',hr:'HR-талдау',eventsAdmin:'Іс-шаралар',guideAdmin:'Білім базасы',growthAdmin:'Даму бағдарламалары',
  settings:'Ұйым баптаулары',notifications:'Хабарландырулар',install:'Қолданбаны орнату',installHint:'Career Quest қолданбасын бөлек терезеде ашыңыз.',
  pageError:'Бетті көрсету мүмкін болмады',pageErrorText:'Қайта ашып көріңіз. Қате қайталанса, әкімшіге хабарласыңыз.',retry:'Қайталау',
  profileDevelopment:'Мансап пен дағдылар',profileHistory:'Оқу тарихы',toolsTitle:'Келесі қадамға қажеттінің бәрі',toolsText:'Оқу мүмкіндіктерін қараңыз, дамуды жоспарлаңыз және жұмыс сұрағына жауап табыңыз.',
  eventsText:'Каталог, қатысу шарттары және алдағы сессиялар',guideText:'Расталған нұсқаулықтар мен байланыс арналары',assistantText:'Даму және жұмыс жағдайлары туралы сұрақтар',growthText:'Жоспарлар, тәлімгерлер және жеке жетістіктер',hrText:'Команда дағдылары, қатысуы және келесі қадамдары',
};
export const navigationCopy = {ru,en,kk};
