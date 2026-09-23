const ru = {
  title: 'Импорт данных',
  subtitle: 'Добавляйте профили и обновляйте справочники с проверкой перед применением.',
  admin: 'Для администратора',
  stepChoose: 'Выберите файлы',
  stepCheck: 'Проверьте набор',
  stepApply: 'Примените изменения',
  uploadTitle: 'Новый набор данных',
  uploadDescription: 'Выберите полный набор или отдельные файлы. Для новых профилей достаточно employees.json, историю можно добавить отдельно.',
  limit: 'JSON и CSV · до 10 MiB на весь запрос',
  optional: 'Необязательно',
  skills: 'Навыки',
  skillsDescription: 'Каталог навыков и требования к ролям',
  employees: 'Сотрудники',
  employeesDescription: 'Профили, оценки и карьерные цели',
  events: 'Активности',
  eventsDescription: 'Мероприятия и программы обучения',
  history: 'История участия',
  historyDescription: 'Участия, статусы и результаты обучения',
  choose: 'Выбрать файл',
  replace: 'Заменить файл',
  remove: 'Убрать файл',
  selected: 'Файл прочитан',
  reading: 'Чтение файла…',
  preview: 'Проверить набор',
  checking: 'Проверяем данные…',
  apply: 'Применить импорт',
  applying: 'Применяем изменения…',
  cancel: 'Отмена',
  previewNote: 'Проверка не меняет данные. Применение будет отдельным действием.',
  waitingTitle: 'Сначала проверим данные',
  waitingDescription: 'Выберите хотя бы один файл. После проверки здесь появится состав пакета и результат валидации.',
  previewTitle: 'Набор готов к применению',
  previewDescription: 'Формат и связи прошли проверку. При применении сервер проверит пакет ещё раз.',
  duplicateTitle: 'Этот набор уже загружен',
  duplicateDescription: 'Такой же пакет уже есть в истории. Повторное применение не требуется.',
  appliedTitle: 'Данные успешно импортированы',
  appliedDescription: 'Изменения сохранены. Новые данные доступны в пространстве и профилях.',
  countsNote: 'Это количество записей во входящем пакете, включая обновления, а не число новых записей.',
  roleProfiles: 'Профили ролей',
  historyRecords: 'Записи участия',
  hash: 'Отпечаток пакета',
  confirmTitle: 'Применить проверенный набор?',
  confirmDescription: 'Профили и справочники будут обновлены по данным выбранных файлов. Существующие сотрудники, которых нет в пакете, сохранятся. Ошибочный пакет не применяется частично.',
  confirmationFileCount: 'Файлов в проверенном пакете',
  recent: 'Последние загрузки',
  recentDescription: 'Последние 30 успешно применённых пакетов',
  refresh: 'Обновить историю',
  loadingHistory: 'Загружаем историю…',
  historyEmptyTitle: 'Загрузок пока нет',
  historyEmptyDescription: 'После первого применения здесь появится запись о пакете.',
  importedAt: 'Дата загрузки',
  dataset: 'Набор данных',
  package: 'Состав пакета',
  snapshot: 'Срез',
  version: 'Версия',
  unavailable: 'Не указано',
  noAccess: 'У вас нет доступа к импорту',
  noAccessDescription: 'Загружать данные может только администратор. Права проверяются сервером.',
  problems: 'Набор не прошёл проверку',
  problemsDescription: 'Исправьте ошибки в файлах, выберите их заново и повторите проверку.',
  detailFile: 'Файл',
  detailField: 'Поле',
  detailMessage: 'Причина',
  detailsLimit: 'Сервер показывает до 100 ошибок за одну проверку.',
  fileEmpty: 'Файл пустой. Выберите файл с данными.',
  fileJson: 'Не удалось прочитать JSON. Проверьте формат файла.',
  fileRead: 'Файл не удалось прочитать. Выберите его ещё раз.',
  fileTooLarge: 'Файл больше 10 MiB. Разделите его на меньшие файлы перед загрузкой.',
  fileShape: 'Неверная структура: нужны объект meta и массивы данных, соответствующие этому разделу.',
  fileType: 'Выберите JSON-файл для этого раздела.',
  csvType: 'Выберите CSV-файл с историей участия.',
  noFiles: 'Выберите хотя бы один файл.',
  fileNotReady: 'Дождитесь чтения файлов и исправьте отмеченные ошибки.',
  tooLarge: 'Размер JSON-запроса превышает 10 MiB. Разделите данные на несколько пакетов.',
  validationFailed: 'В данных найдены ошибки. Пакет не применён.',
  unauthorized: 'Сессия завершилась. Войдите снова.',
  forbidden: 'Сервер запретил импорт. Проверьте, что вы вошли как администратор.',
  csrfRejected: 'Сессия обновилась. Перезагрузите страницу и повторите проверку набора.',
  originRejected: 'Этот адрес приложения не разрешён сервером. Обратитесь к администратору.',
  invalidResponse: 'Сервер вернул неожиданный ответ. Повторите проверку набора.',
  databaseUnavailable: 'Данные временно недоступны. Повторите попытку позже.',
  requestFailed: 'Не удалось проверить пакет. Проверьте подключение и повторите попытку.',
  commitFailed: 'Не удалось подтвердить применение пакета. Повторите применение этого же набора: уже сохранённый пакет не создаст дубли.',
  historyFailed: 'Не удалось загрузить историю. Повторите попытку.',
  retry: 'Повторить',
  close: 'Закрыть',
} as const;

type Copy = { [K in keyof typeof ru]: string };

const en: Copy = {
  title: 'Data import', subtitle: 'Add profiles and update catalogs with validation before applying.', admin: 'Administrator access',
  stepChoose: 'Select files', stepCheck: 'Validate dataset', stepApply: 'Apply changes',
  uploadTitle: 'New dataset', uploadDescription: 'Select a complete dataset or individual files. Additional profiles only need employees.json; participation history can be uploaded separately.',
  limit: 'JSON and CSV · 10 MiB maximum per request', optional: 'Optional', skills: 'Skills', skillsDescription: 'Skill catalog and role requirements',
  employees: 'Employees', employeesDescription: 'Profiles, assessments and career goals', events: 'Activities', eventsDescription: 'Events and learning programs',
  history: 'Participation history', historyDescription: 'Participation, status and learning results', choose: 'Choose file', replace: 'Replace file', remove: 'Remove file',
  selected: 'File loaded', reading: 'Reading file…', preview: 'Validate dataset', checking: 'Validating data…', apply: 'Apply import', applying: 'Applying changes…', cancel: 'Cancel',
  previewNote: 'Validation does not change data. You will apply changes in a separate step.',
  waitingTitle: 'Let’s validate your data first', waitingDescription: 'Select at least one file. After validation, the package contents and validation results will appear here.',
  previewTitle: 'Dataset ready to apply', previewDescription: 'The format and references passed validation. The server will validate the package again when it is applied.',
  duplicateTitle: 'This dataset was already imported', duplicateDescription: 'An identical package is already in your history. You do not need to apply it again.',
  appliedTitle: 'Data imported successfully', appliedDescription: 'Your changes are saved. The new data is available in the workspace and employee profiles.',
  countsNote: 'These are the records in the incoming package, including updates, rather than the number of new records.',
  roleProfiles: 'Role profiles', historyRecords: 'Participation records', hash: 'Package fingerprint',
  confirmTitle: 'Apply the validated dataset?', confirmDescription: 'Profiles and catalogs will be updated using the selected files. Existing employees missing from this package will be kept. An invalid package is never applied partially.',
  confirmationFileCount: 'Files in the validated package', recent: 'Recent imports', recentDescription: 'The latest 30 successfully applied packages', refresh: 'Refresh history',
  loadingHistory: 'Loading history…', historyEmptyTitle: 'No imports yet', historyEmptyDescription: 'After your first import, the package will appear here.',
  importedAt: 'Imported at', dataset: 'Dataset', package: 'Package contents', snapshot: 'Snapshot', version: 'Version', unavailable: 'Not provided',
  noAccess: 'You cannot access imports', noAccessDescription: 'Only administrators can import data. Permissions are checked by the server.',
  problems: 'Dataset validation failed', problemsDescription: 'Fix the errors in your files, select the files again and repeat validation.',
  detailFile: 'File', detailField: 'Field', detailMessage: 'Reason', detailsLimit: 'The server returns up to 100 errors per validation.',
  fileEmpty: 'This file is empty. Select a file with data.', fileJson: 'Unable to parse JSON. Check the file format.', fileRead: 'Unable to read this file. Select it again.',
  fileTooLarge: 'This file exceeds 10 MiB. Split it into smaller files before uploading.',
  fileShape: 'Invalid structure: a meta object and data arrays for this section are required.', fileType: 'Select a JSON file for this section.', csvType: 'Select a CSV file with participation history.',
  noFiles: 'Select at least one file.', fileNotReady: 'Wait for the files to load and resolve the highlighted errors.', tooLarge: 'The JSON request exceeds 10 MiB. Split the data into smaller packages.',
  validationFailed: 'The data contains errors. The package was not applied.', unauthorized: 'Your session has expired. Sign in again.', forbidden: 'The server denied this import. Make sure you are signed in as an administrator.',
  csrfRejected: 'Your session has changed. Reload the page and validate the dataset again.', originRejected: 'The server does not allow this application address. Contact your administrator.', invalidResponse: 'The server returned an unexpected response. Validate the dataset again.',
  databaseUnavailable: 'Data is temporarily unavailable. Please try again later.', requestFailed: 'Unable to validate this package. Check your connection and try again.',
  commitFailed: 'Unable to confirm the import. Apply this same package again: a package already saved will not create duplicates.', historyFailed: 'Unable to load import history. Try again.', retry: 'Try again', close: 'Close',
};

const kk: Copy = {
  title: 'Деректерді импорттау', subtitle: 'Алдын ала тексеру арқылы профильдерді қосып, анықтамалықтарды жаңартыңыз.', admin: 'Әкімшіге арналған',
  stepChoose: 'Файлдарды таңдаңыз', stepCheck: 'Жинақты тексеріңіз', stepApply: 'Өзгерістерді қолданыңыз',
  uploadTitle: 'Жаңа деректер жинағы', uploadDescription: 'Толық жинақты немесе жеке файлдарды таңдаңыз. Жаңа профильдер үшін employees.json жеткілікті, қатысу тарихын бөлек қосуға болады.',
  limit: 'JSON және CSV · бір сұрауға ең көбі 10 MiB', optional: 'Міндетті емес', skills: 'Дағдылар', skillsDescription: 'Дағдылар каталогы және рөл талаптары',
  employees: 'Қызметкерлер', employeesDescription: 'Профильдер, бағалаулар және мансаптық мақсаттар', events: 'Іс-шаралар', eventsDescription: 'Іс-шаралар мен оқу бағдарламалары',
  history: 'Қатысу тарихы', historyDescription: 'Қатысу, мәртебелер және оқу нәтижелері', choose: 'Файлды таңдау', replace: 'Файлды ауыстыру', remove: 'Файлды алып тастау',
  selected: 'Файл оқылды', reading: 'Файл оқылуда…', preview: 'Жинақты тексеру', checking: 'Деректер тексерілуде…', apply: 'Импортты қолдану', applying: 'Өзгерістер қолданылуда…', cancel: 'Бас тарту',
  previewNote: 'Тексеру деректерді өзгертпейді. Өзгерістерді бөлек әрекетпен қолданасыз.',
  waitingTitle: 'Алдымен деректерді тексерейік', waitingDescription: 'Кемінде бір файлды таңдаңыз. Тексеруден кейін жинақ құрамы мен нәтиже осы жерде көрсетіледі.',
  previewTitle: 'Жинақ қолдануға дайын', previewDescription: 'Пішім мен байланыстар тексеруден өтті. Қолдану кезінде сервер жинақты қайта тексереді.',
  duplicateTitle: 'Бұл жинақ бұрын жүктелген', duplicateDescription: 'Дәл осындай жинақ тарихта бар. Қайта қолдану қажет емес.',
  appliedTitle: 'Деректер сәтті импортталды', appliedDescription: 'Өзгерістер сақталды. Жаңа деректер кеңістікте және қызметкерлер профильдерінде қолжетімді.',
  countsNote: 'Бұл — жаңартуларды қоса алғанда, кіріс жинағындағы жазбалар саны. Жаңа жазбалар саны емес.',
  roleProfiles: 'Рөл профильдері', historyRecords: 'Қатысу жазбалары', hash: 'Жинақ таңбасы',
  confirmTitle: 'Тексерілген жинақты қолдану керек пе?', confirmDescription: 'Профильдер мен анықтамалықтар таңдалған файлдармен жаңартылады. Жинақта жоқ қызметкерлер сақталады. Қате жинақ ішінара қолданылмайды.',
  confirmationFileCount: 'Тексерілген жинақтағы файлдар', recent: 'Соңғы жүктеулер', recentDescription: 'Сәтті қолданылған соңғы 30 жинақ', refresh: 'Тарихты жаңарту',
  loadingHistory: 'Тарих жүктелуде…', historyEmptyTitle: 'Әзірше жүктеулер жоқ', historyEmptyDescription: 'Алғашқы импорттан кейін жинақ осы жерде көрсетіледі.',
  importedAt: 'Жүктелген күні', dataset: 'Деректер жинағы', package: 'Жинақ құрамы', snapshot: 'Деректер күні', version: 'Нұсқа', unavailable: 'Көрсетілмеген',
  noAccess: 'Импортқа қолжетімділік жоқ', noAccessDescription: 'Деректерді тек әкімші жүктей алады. Құқықтарды сервер тексереді.',
  problems: 'Жинақ тексеруден өтпеді', problemsDescription: 'Файлдардағы қателерді түзетіп, оларды қайта таңдап, тексеруді қайталаңыз.',
  detailFile: 'Файл', detailField: 'Өріс', detailMessage: 'Себебі', detailsLimit: 'Сервер бір тексеруде 100 қатеге дейін көрсетеді.',
  fileEmpty: 'Файл бос. Деректері бар файлды таңдаңыз.', fileJson: 'JSON оқылмады. Файл пішімін тексеріңіз.', fileRead: 'Файл оқылмады. Оны қайта таңдаңыз.',
  fileTooLarge: 'Файл 10 MiB шегінен асты. Жүктемес бұрын оны кішірек файлдарға бөліңіз.',
  fileShape: 'Құрылым қате: meta нысаны мен осы бөлімге сәйкес деректер массивтері қажет.', fileType: 'Бұл бөлім үшін JSON файлын таңдаңыз.', csvType: 'Қатысу тарихы бар CSV файлын таңдаңыз.',
  noFiles: 'Кемінде бір файлды таңдаңыз.', fileNotReady: 'Файлдардың оқылуын күтіп, белгіленген қателерді түзетіңіз.', tooLarge: 'JSON сұрауы 10 MiB шегінен асты. Деректерді бірнеше жинаққа бөліңіз.',
  validationFailed: 'Деректерде қателер бар. Жинақ қолданылмады.', unauthorized: 'Сессия аяқталды. Қайта кіріңіз.', forbidden: 'Сервер импортқа рұқсат бермеді. Әкімші ретінде кіргеніңізді тексеріңіз.',
  csrfRejected: 'Сессия жаңарды. Бетті жаңартып, жинақты қайта тексеріңіз.', originRejected: 'Сервер бұл қолданба мекенжайына рұқсат бермейді. Әкімшіге хабарласыңыз.', invalidResponse: 'Сервер күтпеген жауап қайтарды. Жинақты қайта тексеріңіз.',
  databaseUnavailable: 'Деректер уақытша қолжетімсіз. Кейінірек қайталап көріңіз.', requestFailed: 'Жинақ тексерілмеді. Қосылымды тексеріп, қайталап көріңіз.',
  commitFailed: 'Импорттың қолданылғаны расталмады. Осы жинақты қайта қолданыңыз: сақталған жинақ қайталанбайды.', historyFailed: 'Импорт тарихы жүктелмеді. Қайталап көріңіз.', retry: 'Қайталау', close: 'Жабу',
};

export const importsCopy: Record<'ru' | 'kk' | 'en', Copy> = { ru, kk, en };
export type ImportsCopy = Copy;

// The current API returns field errors as English text without language codes.
// Translate known reasons, while keeping unknown reasons intact for diagnosis.
export function localizeImportIssue(message: string, locale: 'ru' | 'kk' | 'en'): string {
  if (locale === 'en') return message;
  const exact: Record<string, [string, string]> = {
    'Expected an object': ['Ожидается объект данных', 'Деректер нысаны қажет'],
    'Provide history or historyCsv, not both': ['Передайте только один формат истории: history или historyCsv', 'Тарихтың тек бір пішімін беріңіз: history немесе historyCsv'],
    'Expected CSV text': ['Ожидается текст CSV', 'CSV мәтіні қажет'],
    'Malformed CSV': ['Некорректный CSV: проверьте столбцы и кавычки', 'CSV қате: бағандар мен тырнақшаларды тексеріңіз'],
    'Empty dataset': ['Набор данных пуст', 'Деректер жинағы бос'],
    'Snapshot dates differ': ['Даты среза в файлах не совпадают', 'Файлдардағы деректер күндері сәйкес емес'],
    'Unknown role/grade': ['Роль или грейд отсутствует в справочнике', 'Рөл немесе деңгей анықтамалықта жоқ'],
    'Unknown career goal': ['Карьерная цель отсутствует в справочнике', 'Мансаптық мақсат анықтамалықта жоқ'],
    'Employee date is after snapshot': ['Дата в профиле сотрудника позже даты среза', 'Қызметкер профиліндегі күн деректер күнінен кейін'],
    'Manager must exist, be Lead and belong to the same department': ['Руководитель должен существовать, иметь грейд Lead и работать в том же отделе', 'Басшы профильде болуы, Lead деңгейіне ие болуы және сол бөлімде жұмыс істеуі керек'],
    'Manager cycle': ['Обнаружен цикл в подчинении руководителям', 'Басшыларға бағыну тізбегінде цикл бар'],
    'Unknown employee': ['Неизвестный сотрудник', 'Белгісіз қызметкер'],
    'Unknown event': ['Неизвестное мероприятие', 'Белгісіз іс-шара'],
    'Self-paced event cannot have no_show': ['Самостоятельное обучение не может иметь статус no_show', 'Өз бетінше оқуда no_show мәртебесі болмайды'],
    'Existing record differs; corrections require a separate audited operation': ['Запись с таким ID уже существует с другими данными. Исправление требует отдельной операции с аудитом', 'Осы ID бар жазба басқа деректермен сақталған. Түзету үшін аудиті бар бөлек әрекет қажет'],
    'Initial import requires metadata': ['Для первого импорта нужны метаданные из JSON-файла', 'Алғашқы импорт үшін JSON файлындағы метадеректер қажет'],
    'Snapshot changes require a dedicated migration': ['Дата среза должна совпадать с текущим набором. Для смены даты нужна отдельная миграция', 'Деректер күні қазіргі жинақпен сәйкес болуы керек. Күнді өзгерту үшін бөлек көшіру қажет'],
    'completed requires 100': ['Для статуса completed значение completion_pct должно быть 100', 'completed мәртебесі үшін completion_pct мәні 100 болуы керек'],
    'Invalid ISO date': ['Некорректная дата: используйте ГГГГ-ММ-ДД', 'Күн қате: ЖЖЖЖ-АА-КК пішімін қолданыңыз'],
  };
  const languageIndex = locale === 'ru' ? 0 : 1;
  const direct = exact[message];
  if (direct) return direct[languageIndex];
  const prefixes: [string, string, string][] = [
    ['Duplicate: ', 'Повторяющееся значение: ', 'Қайталанған мән: '],
    ['Unknown skill: ', 'Неизвестный навык: ', 'Белгісіз дағды: '],
    ['Unknown role: ', 'Неизвестная роль: ', 'Белгісіз рөл: '],
    ['Missing requirement: ', 'Не задано требование к навыку: ', 'Дағды талабы берілмеген: '],
    ['Invalid option: expected one of ', 'Допустимые значения: ', 'Рұқсат етілген мәндер: '],
    ['Unrecognized key: ', 'Неизвестное поле: ', 'Белгісіз өріс: '],
    ['Unrecognized keys: ', 'Неизвестные поля: ', 'Белгісіз өрістер: '],
  ];
  for (const [prefix, russian, kazakh] of prefixes) {
    if (message.startsWith(prefix)) return (locale === 'ru' ? russian : kazakh) + message.slice(prefix.length);
  }
  const typeError = /^Invalid input: expected (.+), received (.+)$/.exec(message);
  if (typeError) {
    const types: Record<string, [string, string]> = { string: ['текст', 'мәтін'], number: ['число', 'сан'], int: ['целое число', 'бүтін сан'], boolean: ['логическое значение', 'логикалық мән'], array: ['массив', 'массив'], object: ['объект', 'нысан'], undefined: ['значение отсутствует', 'мән жоқ'], null: ['null', 'null'], NaN: ['нечисловое значение', 'сан емес мән'] };
    const expected = types[typeError[1]!]?.[languageIndex] ?? typeError[1];
    const received = types[typeError[2]!]?.[languageIndex] ?? typeError[2];
    return locale === 'ru' ? `Ожидается ${expected}; получено: ${received}` : `${expected} қажет; алынған мән: ${received}`;
  }
  const numberError = /^Too (small|big): expected number to be (>=|<=|>|<)(.+)$/.exec(message);
  if (numberError) return locale === 'ru' ? `Значение должно быть ${numberError[2]} ${numberError[3]}` : `Мән ${numberError[2]} ${numberError[3]} болуы керек`;
  const lengthError = /^Too (small|big): expected (string|array) to have (>=|<=)(\d+) (characters|items)$/.exec(message);
  if (lengthError) {
    const unit = locale === 'ru' ? (lengthError[2] === 'string' ? 'символов' : 'элементов') : (lengthError[2] === 'string' ? 'таңба' : 'элемент');
    return locale === 'ru' ? `Требуется ${lengthError[3]} ${lengthError[4]} ${unit}` : `${lengthError[3]} ${lengthError[4]} ${unit} қажет`;
  }
  return message;
}
