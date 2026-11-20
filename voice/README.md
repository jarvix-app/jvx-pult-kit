# voice: обработчик голоса на компьютере продакта

Сервер jvx-pult голос не распознаёт. Голосовые из Telegram лежат на сервере в очереди; этот скрипт
на компьютере продакта забирает их, распознаёт локальной моделью GigaAM и сдаёт текст обратно.

Это **один проход и выход**, не вечный процесс. Планировщик заданий запускает его раз в 5 минут:

1. спрашивает сервер, что ждёт (`GET voice/pending`). **Очередь пуста: выход, модель не загружается**
   и видеокарту не занимает (память общая с другими программами);
2. берёт файл-замок: второй проход при живом первом сразу выходит;
3. загружает модель, затем по каждому голосовому: `claim`, скачать, распознать, записать текст рядом, сдать
   (`transcript`; сбой распознавания уходит как `failed` с причиной, остальные продолжаются);
4. выгружает модель и выходит.

Нет связи с сервером: проход обрывается без потерь. Захват на сервере протухает через 30 минут,
и строка сама возвращается в очередь.

## Что нужно

- Окружение с GigaAM: по умолчанию `D:\gigaam-test\.venv\Scripts\python.exe` (другое: переменная `PULT_VOICE_PYTHON`).
  В его каталоге ничего не пишется и не меняется; окружение только запускается. Ставить в него пакеты не нужно:
  скрипт использует стандартную библиотеку плюс `torch`, `gigaam`, `soundfile`, которые там уже есть.
- `ffmpeg` в PATH (его зовёт и сам gigaam).
- Токен с ролью `product` или `adjutant` (право `voice.process`). Настройки берутся те же, что у утилиты `pult`:
  переменные `PULT_TOKEN` и `PULT_SERVER`, иначе файл `%APPDATA%\pult\config.json` (его пишет `pult login`;
  путь можно задать `PULT_CONFIG`). Сервер обязан быть `https://`; открытый `http://` допустим только для
  `localhost`, `127.0.0.1` и `*.test`. Токен не печатается и не пишется в журнал.

## Запуск вручную

Папка `D:\Herd\jvx-pult-kit\voice`:

```powershell
cd D:\Herd\jvx-pult-kit\voice; .\run.cmd
```

Код выхода: `0` проход прошёл (в том числе очередь пуста или замок занят), `2` не хватает настроек
или адрес небезопасен, `3` нет связи или сервер отказал, `5` модель не загрузилась (видеокарта занята,
нет файла модели); при `5` ничего не взято, следующий проход повторит.

Параметры (`run.cmd --help`): `--data-dir`, `--keep-days` (по умолчанию 30), `--limit` (25 за проход),
`--model` (по умолчанию `multilingual_large_ctc`, как в `watch.py`; или переменная `GIGAAM_MODEL`).
Каталог данных можно задать и переменной `PULT_VOICE_DATA_DIR`.

## Подключить к Планировщику заданий

Задание запускается от имени вошедшего пользователя: так ему доступны его PATH (ffmpeg), видеокарта и
файл настроек в `%APPDATA%`. Папка `D:\Herd\jvx-pult-kit\voice`, одна команда целиком:

```powershell
cd D:\Herd\jvx-pult-kit\voice; $a = New-ScheduledTaskAction -Execute "D:\Herd\jvx-pult-kit\voice\run.cmd" -WorkingDirectory "D:\Herd\jvx-pult-kit\voice"; $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650); $s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Register-ScheduledTask -TaskName "jvx-pult voice" -Action $a -Trigger $t -Settings $s -Description "Распознавание голосовых jvx-pult"
```

Проверить, остановить, убрать (папка не важна, это настройки учётной записи):

```powershell
Start-ScheduledTask -TaskName "jvx-pult voice"
```

```powershell
Disable-ScheduledTask -TaskName "jvx-pult voice"
```

```powershell
Unregister-ScheduledTask -TaskName "jvx-pult voice" -Confirm:$false
```

Если токен не лежит в `%APPDATA%\pult\config.json`, задайте `PULT_TOKEN` и `PULT_SERVER` в переменных среды
пользователя: Планировщик их подхватит.

## Где лежат данные

`%LOCALAPPDATA%\jvx-pult\voice` (меняется `--data-dir`). Всё это **вне** `D:\gigaam-test`:

| Путь | Что |
|---|---|
| `work\` | то, что обрабатывается сейчас; брошенное при обрыве чистится через 2 дня |
| `done\` | успешно обработанное: `<id>.<расширение>` и `<id>.txt` с текстом; удаляется через `--keep-days` (30) |
| `failed\` | не прошедшее распознавание: аудио и `<id>.reason.txt`; **не удаляется само**, разбирать вручную |
| `logs\voice-ГГГГ-ММ-ДД.log` | журнал: время, id, длительность записи и распознавания, число знаков. **Текста расшифровки в нём нет** |
| `worker.lock` | замок прохода (pid и время); мёртвый замок снимается сам |

Текст записывается во временный файл рядом и подменяется целиком, поэтому читатель не увидит половину.
Файлы `done\` и `failed\` личные: каталог не должен попадать в репозитории и резервные копии на чужие диски.

## Как распознаются длинные записи

До 25 секунд: `model.transcribe`, ровно как в `watch.py`.

Длиннее 25 секунд `watch.py` зовёт `transcribe_longform`, а ему нужны `pyannote` и `HF_TOKEN`, которых в окружении
нет: он падает с `No module named 'pyannote'` (проверено на этом окружении). Поэтому запись режется
самим скриптом по паузам (энергетический детектор речи, идея из `longform_local.py`), каждый кусок до 22 секунд
распознаётся тем же `model.transcribe`, тексты склеиваются через пробел. Если паузы нет, режется в самом тихом
месте окна. Цена: без временных меток, перекрытия нет (слово на разрезе без паузы может исказиться),
куски идут по одному, без пакетной обработки.

## Тесты

Стандартная библиотека, без модели и видеокарты (поддельный сервер и поддельный распознаватель). Папка `D:\Herd\jvx-pult-kit\voice`:

```powershell
cd D:\Herd\jvx-pult-kit\voice; D:\gigaam-test\.venv\Scripts\python.exe -B -m unittest test_worker -v
```

Живая проверка с настоящей моделью и поддельным сервером (`smoke_real.py`, печатает начало текста, время и память видеокарты):

```powershell
cd D:\Herd\jvx-pult-kit\voice; D:\gigaam-test\.venv\Scripts\python.exe -B smoke_real.py путь\к\записи.oga
```
