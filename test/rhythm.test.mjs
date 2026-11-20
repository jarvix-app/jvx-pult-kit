import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RHYTHM, LAYER_RITUALS, RITUAL_NAMES, dueRitual, isLastWorkdayOfMonth, isoWeekday, normalizeRhythm, teamClock } from '../scheduler/rhythm.mjs';

/* Ритм адъютанта из настроек команды: разбор ответа `pult settings` и окна плановых запусков по поясу команды. */

const body = (adjutant = {}, timezone = 'Asia/Tashkent') => ({
  team: { timezone, language: 'ru', now: '2026-11-04T10:00:00+05:00' },
  settings: { adjutant: { utro_at: '09:00', den_at: '14:00', vecher_at: '19:00', watchdog_interval_minutes: 5, wake_min_interval_minutes: 15, ...adjutant } },
});

// 04:05 UTC = 09:05 в Ташкенте (+5). Дата 2026-11-04.
const at = (iso) => Date.parse(iso);

test('ответ сервера разбирается; свои часы команды сохраняются', () => {
  const r = normalizeRhythm(body({ utro_at: '08:30', vecher_at: '20:15', watchdog_interval_minutes: 10, wake_min_interval_minutes: 30 }));

  assert.deepEqual(r, {
    timezone: 'Asia/Tashkent',
    utro_at: '08:30',
    den_at: '14:00',
    vecher_at: '20:15',
    nedelya_day: 5,
    nedelya_at: '19:30',
    mesyac_at: '19:30',
    workdays: [1, 2, 3, 4, 5],
    watchdog_interval_minutes: 10,
    wake_min_interval_minutes: 30,
  });
});

test('ответ не того вида: null, а не выдуманные часы', () => {
  for (const bad of [null, undefined, {}, { team: { timezone: 'Mars/Base' }, settings: { adjutant: {} } }, { team: { timezone: 'UTC' } }, { team: { timezone: 'UTC' }, settings: { adjutant: 5 } }, 'строка']) {
    assert.equal(normalizeRhythm(bad), null, JSON.stringify(bad));
  }
});

test('испорченное значение заменяется умолчанием, остальные остаются', () => {
  const r = normalizeRhythm(body({ utro_at: '9:0', watchdog_interval_minutes: 0, wake_min_interval_minutes: 'часто', den_at: '13:00' }));

  assert.equal(r.utro_at, DEFAULT_RHYTHM.utro_at);
  assert.equal(r.den_at, '13:00');
  assert.equal(r.watchdog_interval_minutes, DEFAULT_RHYTHM.watchdog_interval_minutes);
  assert.equal(r.wake_min_interval_minutes, DEFAULT_RHYTHM.wake_min_interval_minutes);
});

test('часы не по порядку дня не принимаются: окна запусков не должны накладываться', () => {
  const r = normalizeRhythm(body({ utro_at: '20:00', den_at: '14:00', vecher_at: '19:00' }));

  assert.deepEqual([r.utro_at, r.den_at, r.vecher_at], [DEFAULT_RHYTHM.utro_at, DEFAULT_RHYTHM.den_at, DEFAULT_RHYTHM.vecher_at]);
});

test('часы команды: дата и минуты считаются в её поясе, а не в поясе компьютера', () => {
  assert.deepEqual(teamClock(at('2026-11-04T05:30:00Z'), 'Asia/Tashkent'), { date: '2026-11-04', minutes: 10 * 60 + 30 });
  // Через сутки на другом поясе: у Ташкента уже 5 ноября, у Гонолулу (-10) ещё 4-е.
  assert.deepEqual(teamClock(at('2026-11-04T20:00:00Z'), 'Asia/Tashkent'), { date: '2026-11-05', minutes: 60 });
  assert.deepEqual(teamClock(at('2026-11-04T20:00:00Z'), 'Pacific/Honolulu'), { date: '2026-11-04', minutes: 10 * 60 });
  // Полночь - ноль минут, а не 24 часа.
  assert.deepEqual(teamClock(at('2026-11-03T19:00:00Z'), 'Asia/Tashkent'), { date: '2026-11-04', minutes: 0 });
});

test('окна запусков: утро до дня, день до вечера, вечер до конца суток; до утра ничего', () => {
  const r = normalizeRhythm(body());
  // Ташкент +5: час команды H -> UTC H-5.
  const due = (utc, done = {}) => dueRitual(r, done, at(`2026-11-04T${utc}Z`));

  assert.equal(due('03:59'), null); // 08:59
  assert.equal(due('04:00'), 'utro'); // 09:00
  assert.equal(due('08:59'), 'utro'); // 13:59
  assert.equal(due('09:00'), 'den'); // 14:00
  assert.equal(due('13:59'), 'den'); // 18:59
  assert.equal(due('14:00'), 'vecher'); // 19:00
  assert.equal(due('18:59'), 'vecher'); // 23:59
  assert.equal(due('19:00', {}), null); // 00:00 следующих суток: окон нет до 09:00
});

test('сегодня уже запускался: повторно нет; вчерашняя отметка не мешает', () => {
  const r = normalizeRhythm(body());
  const now = at('2026-11-04T04:05:00Z');

  assert.equal(dueRitual(r, { utro: '2026-11-04' }, now), null);
  assert.equal(dueRitual(r, { utro: '2026-11-03' }, now), 'utro');
  assert.equal(dueRitual(r, { den: '2026-11-04' }, now), 'utro', 'отметка другого запуска не считается');
});

test('пропущенное окно не догоняется: в обед утренний запуск не нужен, дневной займёт его место', () => {
  const r = normalizeRhythm(body());

  assert.equal(dueRitual(r, {}, at('2026-11-04T09:30:00Z')), 'den');
});

test('свои часы команды сдвигают окна; без ритма запусков нет', () => {
  const r = normalizeRhythm(body({ utro_at: '07:00', den_at: '12:00', vecher_at: '17:30' }));

  assert.equal(dueRitual(r, {}, at('2026-11-04T02:05:00Z')), 'utro'); // 07:05
  assert.equal(dueRitual(r, {}, at('2026-11-04T04:05:00Z')), 'utro'); // 09:05 всё ещё утро: день с 12:00
  assert.equal(dueRitual(r, {}, at('2026-11-04T07:05:00Z')), 'den'); // 12:05
  assert.equal(dueRitual(null, {}, at('2026-11-04T07:05:00Z')), null);
});

test('имена плановых запусков те же, что команды набора', () => {
  assert.deepEqual(RITUAL_NAMES, ['utro', 'den', 'vecher', 'nedelya', 'mesyac']);
  assert.deepEqual(LAYER_RITUALS, ['nedelya', 'mesyac']);
});

/* Слои пульса: /nedelya и /mesyac. Не окна дня, а день недели и последний рабочий день месяца, после вечернего запуска. */

const layered = (adjutant = {}, workdays = [1, 2, 3, 4, 5]) => {
  const b = body(adjutant);
  b.team.workdays = workdays;
  return normalizeRhythm(b);
};

test('слои пульса: день недели, часы и рабочие дни приходят из настроек; испорченное заменяется умолчанием', () => {
  const r = layered({ nedelya_day: '4', nedelya_at: '18:00', mesyac_at: '20:30' }, [1, 2, 3, 4, 6]);

  assert.deepEqual([r.nedelya_day, r.nedelya_at, r.mesyac_at, r.workdays], [4, '18:00', '20:30', [1, 2, 3, 4, 6]]);

  const bad = layered({ nedelya_day: '9', nedelya_at: '25:00', mesyac_at: 'вечером' }, []);

  assert.deepEqual([bad.nedelya_day, bad.nedelya_at, bad.mesyac_at, bad.workdays], [5, '19:30', '19:30', [1, 2, 3, 4, 5]]);
  // Сервер старого вида не отдаёт рабочие дни: понедельник-пятница.
  assert.deepEqual(normalizeRhythm(body()).workdays, [1, 2, 3, 4, 5]);
});

test('день недели и последний рабочий день месяца считаются по дате команды', () => {
  assert.deepEqual(['2026-11-01', '2026-11-02', '2026-11-06'].map(isoWeekday), [7, 1, 5]);

  const work = [1, 2, 3, 4, 5];

  // Октябрь 2026 кончается в субботу 31.10: последний рабочий день - пятница 30.10.
  assert.equal(isLastWorkdayOfMonth('2026-10-30', work), true);
  assert.equal(isLastWorkdayOfMonth('2026-10-29', work), false);
  assert.equal(isLastWorkdayOfMonth('2026-10-31', work), false, 'суббота не рабочая');
  // Ноябрь кончается в понедельник 30.11.
  assert.equal(isLastWorkdayOfMonth('2026-11-30', work), true);
  // Своя неделя: по субботам работают - последний рабочий день октября уже 31.10.
  assert.equal(isLastWorkdayOfMonth('2026-10-31', [1, 2, 3, 4, 5, 6]), true);
  assert.equal(isLastWorkdayOfMonth('2026-10-30', [1, 2, 3, 4, 5, 6]), false);
});

test('неделя - в пятницу не раньше своего часа и только после сегодняшнего вечернего запуска', () => {
  const r = layered();
  const due = (utc, done) => dueRitual(r, done, at('2026-11-06T' + utc + 'Z')); // пятница; Ташкент +5

  assert.equal(due('14:40', { vecher: '2026-11-06' }), 'nedelya'); // 19:40
  assert.equal(due('14:20', { vecher: '2026-11-06' }), null, '19:20: ещё рано, час недели 19:30');
  // Вечерний запуск не состоялся: сначала он, слой недели не раньше слоя дня.
  assert.equal(due('14:40', {}), 'vecher');
  assert.equal(due('14:40', { vecher: '2026-11-05' }), 'vecher', 'вчерашний вечер не считается');
  // Неделя сделана - в тот же день её нет, ноябрь ещё не кончился.
  assert.equal(due('14:40', { vecher: '2026-11-06', nedelya: '2026-11-06' }), null);
  // Пропущенный вечер не догоняется ночью следующих суток.
  assert.equal(dueRitual(r, { vecher: '2026-11-06' }, at('2026-11-06T22:00:00Z')), null); // 03:00 субботы
});

test('неделя в другой день - настройка команды, а не пятница в коде', () => {
  const r = layered({ nedelya_day: '3' });

  assert.equal(dueRitual(r, { vecher: '2026-11-04' }, at('2026-11-04T14:40:00Z')), 'nedelya'); // среда
  assert.equal(dueRitual(r, { vecher: '2026-11-06' }, at('2026-11-06T14:40:00Z')), null, 'пятница - уже нет');
});

test('месяц - в последний рабочий день после вечернего запуска, а в день с неделей - после недели', () => {
  const r = layered({ mesyac_at: '20:00' });
  const due = (day, utc, done) => dueRitual(r, done, at(day + 'T' + utc + 'Z'));

  // 30.10.2026 - пятница и последний рабочий день октября: сперва неделя, потом месяц.
  assert.equal(due('2026-10-30', '14:40', { vecher: '2026-10-30' }), 'nedelya');
  assert.equal(due('2026-10-30', '15:10', { vecher: '2026-10-30', nedelya: '2026-10-30' }), 'mesyac'); // 20:10
  assert.equal(due('2026-10-30', '14:40', { vecher: '2026-10-30', nedelya: '2026-10-30' }), null, '19:40: час месяца 20:00');
  assert.equal(due('2026-10-30', '15:10', { vecher: '2026-10-30', nedelya: '2026-10-30', mesyac: '2026-10-30' }), null);
  // Неделя не сделана, а час месяца настал: месяц ждёт неделю.
  assert.equal(due('2026-10-30', '15:10', { vecher: '2026-10-30' }), 'nedelya');
  // 30.11.2026 - понедельник, последний рабочий день ноября: недели нет, месяц есть.
  assert.equal(due('2026-11-30', '15:10', { vecher: '2026-11-30' }), 'mesyac');
  // Обычный рабочий день месяца не последний.
  assert.equal(due('2026-10-29', '15:10', { vecher: '2026-10-29' }), null);
  // Выходные в конце месяца: 31.10 суббота не рабочая.
  assert.equal(due('2026-10-31', '15:10', { vecher: '2026-10-31' }), null);
});

test('без ритма слоёв нет; окна дня по-прежнему главнее', () => {
  assert.equal(dueRitual(null, { vecher: '2026-11-06' }, at('2026-11-06T14:40:00Z')), null);
  // Вечернее окно открыто и вечер не был: он, а не слой, даже в пятницу после 19:30.
  assert.equal(dueRitual(layered(), {}, at('2026-11-06T16:00:00Z')), 'vecher');
});
