const JST_TIME_ZONE = 'Asia/Tokyo';

function getJstParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: JST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  return parts.reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
}

function normalizeDateInput(value) {
  if (value instanceof Date) return value;
  return new Date(`${String(value).split('T')[0]}T00:00:00+09:00`);
}

export function toJstDateString(value = new Date()) {
  const date = normalizeDateInput(value);
  const { year, month, day } = getJstParts(date);
  return `${year}-${month}-${day}`;
}

export function parseJstDate(value) {
  return normalizeDateInput(value);
}

export function addJstDays(value, days) {
  const date = parseJstDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toJstDateString(date);
}

export function getJstWeekdayIndex(value) {
  const weekday = parseJstDate(value).toLocaleDateString('en-US', {
    timeZone: JST_TIME_ZONE,
    weekday: 'short',
  });
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
}

export function startOfJstWeek(value) {
  const weekdayIndex = getJstWeekdayIndex(value);
  return addJstDays(value, -Math.max(weekdayIndex, 0));
}

export function startOfJstMonth(value) {
  const date = parseJstDate(value);
  const { year, month } = getJstParts(date);
  return `${year}-${month}-01`;
}

export function addJstMonths(months, value = new Date()) {
  const date = parseJstDate(value);
  date.setUTCMonth(date.getUTCMonth() + months);
  return toJstDateString(date);
}

export function formatJstDate(value, options, locale = 'ja-JP') {
  return parseJstDate(value).toLocaleDateString(locale, {
    timeZone: JST_TIME_ZONE,
    ...options,
  });
}

export function isTodayJst(value) {
  return toJstDateString(value) === toJstDateString();
}

export function isWeekendJst(value) {
  const weekday = formatJstDate(value, { weekday: 'short' });
  return weekday === '土' || weekday === '日';
}

export function daysUntilJst(value) {
  if (!value) return null;
  const diff = Math.ceil((parseJstDate(value) - parseJstDate(toJstDateString())) / 86400000);
  return diff > 0 ? diff : 0;
}
