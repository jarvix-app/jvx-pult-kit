// Ритм адъютанта из настроек команды (`pult settings`): чистые функции без ввода-вывода, Node 20+.
//
// Часы плановых запусков (/utro, /den, /vecher), интервал сторожа и минимальный промежуток побудки - настройки
// команды: меняет продакт на экране сервера, в тексте инструкций и в Планировщике их нет. Сторож берёт их отсюда.
// Здесь только разбор ответа сервера и арифметика времени по поясу команды; сеть и файлы - в watchdog.mjs.

export const DEFAULT_RHYTHM = Object.freeze({
  utro_at: '09:00',
  den_at: '14:00',
  vecher_at: '19:00',
  watchdog_interval_minutes: 5,
  wake_min_interval_minutes: 15,
  // Слои пульса: неделя в этот день недели (ISO, 5 = пятница), месяц в последний рабочий день. Оба идут после вечернего
  // запуска того же дня: слой дня должен быть написан раньше слоя недели.
  nedelya_day: 5,
  nedelya_at: '19:30',
  mesyac_at: '19:30',
  workdays: Object.freeze([1, 2, 3, 4, 5]),
});

/** Плановые запуски по порядку дня: имя, ключ настройки, ключ настройки конца окна (null - до конца суток). */
const RITUALS = [
  ['utro', 'utro_at', 'den_at'],
  ['den', 'den_at', 'vecher_at'],
  ['vecher', 'vecher_at', null],
];

// Слои пульса: не окна дня, а события дня недели и месяца. Идут после вечернего запуска; неделя раньше месяца.
export const LAYER_RITUALS = ['nedelya', 'mesyac'];

export const RITUAL_NAMES = [...RITUALS.map(([name]) => name), ...LAYER_RITUALS];

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
const isPositiveInt = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;

function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return typeof zone === 'string' && zone !== '';
  } catch {
    return false;
  }
}

/**
 * Ответ `pult settings --section adjutant --json` -> ритм. Ответ не того вида -> null: тогда плановые запуски по
 * часам команды не проверяются, а интервал побудки остаётся умолчанием. Отдельные испорченные значения заменяются
 * умолчанием, а не отбрасывают всё.
 */
export function normalizeRhythm(body) {
  const team = body?.team;
  const section = body?.settings?.adjutant;

  if (!team || !validZone(team.timezone) || !section || typeof section !== 'object') return null;

  const rhythm = { timezone: team.timezone };

  for (const key of ['utro_at', 'den_at', 'vecher_at']) {
    rhythm[key] = typeof section[key] === 'string' && HM.test(section[key]) ? section[key] : DEFAULT_RHYTHM[key];
  }

  // День недельного слоя приходит строкой ('5'): так хранит перечисление сервер.
  const weekday = Number(section.nedelya_day);
  rhythm.nedelya_day = Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday : DEFAULT_RHYTHM.nedelya_day;

  for (const key of ['nedelya_at', 'mesyac_at']) {
    rhythm[key] = typeof section[key] === 'string' && HM.test(section[key]) ? section[key] : DEFAULT_RHYTHM[key];
  }

  const workdays = Array.isArray(team.workdays) ? [...new Set(team.workdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort() : [];
  rhythm.workdays = workdays.length > 0 ? workdays : [...DEFAULT_RHYTHM.workdays];

  rhythm.watchdog_interval_minutes = isPositiveInt(section.watchdog_interval_minutes, 60) ? section.watchdog_interval_minutes : DEFAULT_RHYTHM.watchdog_interval_minutes;
  rhythm.wake_min_interval_minutes = isPositiveInt(section.wake_min_interval_minutes, 240) ? section.wake_min_interval_minutes : DEFAULT_RHYTHM.wake_min_interval_minutes;

  // Порядок дня обязателен: без него окна запусков накладываются. Сервер его проверяет, здесь страховка.
  if (!(toMinutes(rhythm.utro_at) < toMinutes(rhythm.den_at) && toMinutes(rhythm.den_at) < toMinutes(rhythm.vecher_at))) {
    Object.assign(rhythm, { utro_at: DEFAULT_RHYTHM.utro_at, den_at: DEFAULT_RHYTHM.den_at, vecher_at: DEFAULT_RHYTHM.vecher_at });
  }

  return rhythm;
}

/** Дата и минуты от полуночи в поясе команды для момента `ms`. */
export function teamClock(ms, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );

  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** День недели ISO (1 = понедельник) для даты ГГГГ-ММ-ДД: дата уже по поясу команды, поэтому считаем в UTC. */
export function isoWeekday(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Последний рабочий день месяца этой даты? Рабочие дни - дни дейлика команды. */
export function isLastWorkdayOfMonth(date, workdays) {
  if (!workdays.includes(isoWeekday(date))) return false;

  const [y, m, d] = date.split('-').map(Number);

  for (let next = d + 1; new Date(Date.UTC(y, m - 1, next)).getUTCMonth() === m - 1; next += 1) {
    const iso = new Date(Date.UTC(y, m - 1, next)).getUTCDay() || 7;
    if (workdays.includes(iso)) return false;
  }

  return true;
}

/**
 * Какой плановый запуск пора сделать сейчас: тот, чьё окно (от его часа до часа следующего, вечернему до конца
 * суток) открыто и который сегодня ещё не запускался. Пропущенное окно (компьютер был выключен) не догоняется:
 * утренний разбор в обед не нужен, его место займёт дневной. Запись `done` - дата запуска по каждому имени.
 *
 * @returns {string|null} utro, den, vecher или null
 */
export function dueRitual(rhythm, done, ms) {
  if (!rhythm) return null;

  const { date, minutes } = teamClock(ms, rhythm.timezone);

  for (const [name, startKey, endKey] of RITUALS) {
    const start = toMinutes(rhythm[startKey]);
    const end = endKey === null ? 24 * 60 : toMinutes(rhythm[endKey]);

    if (minutes >= start && minutes < end) {
      // Окно открыто и запуск не состоялся: он. Состоялся - слой пульса (после вечернего) может ждать своего часа.
      if (done?.[name] !== date) return name;
      break;
    }
  }

  return dueLayer(rhythm, done, date, minutes);
}

/**
 * Слои пульса. Недельный - в день недели из настроек, месячный - в последний рабочий день месяца; оба не раньше своего
 * часа и только когда сегодняшний вечерний запуск уже был (слой дня пишется в нём), недельный раньше месячного.
 * Пропущенное здесь не догоняется: недостающие слои адъютант дописывает при первом запуске (pult digest missing).
 */
function dueLayer(rhythm, done, date, minutes) {
  if (done?.vecher !== date) return null;

  const weekDue = isoWeekday(date) === rhythm.nedelya_day;

  if (weekDue && minutes >= toMinutes(rhythm.nedelya_at) && done?.nedelya !== date) return 'nedelya';

  const weekPending = weekDue && done?.nedelya !== date;

  if (!weekPending && minutes >= toMinutes(rhythm.mesyac_at) && done?.mesyac !== date && isLastWorkdayOfMonth(date, rhythm.workdays)) {
    return 'mesyac';
  }

  return null;
}
