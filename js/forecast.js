/**
 * StudyFlow — forecast.js
 *
 * Lightweight, dependency-free analytics that turn raw study sessions into
 * actionable forecasts for students and educators:
 *
 *   - holtForecast:   double exponential smoothing (Holt's linear trend) that
 *                     projects a student's weekly study minutes forward and
 *                     estimates whether they'll hit their weekly goal.
 *   - paceToGoal:     how many minutes/day remain to reach a weekly target
 *                     given progress so far and days left in the week.
 *   - streakRisk:     a recency/day-of-week model estimating the probability
 *                     the current streak will break if no session happens today.
 */

function zScores(arr) {
  const n = arr.length;
  if (n === 0) return arr;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance) || 1;
  return arr.map((x) => (x - mean) / sd);
}

/**
 * Holt's linear trend (double exponential smoothing).
 * Returns { level, trend, forecast(k) } where forecast(k) is the expected
 * value k steps ahead (k >= 1). Falls back to a flat mean when there is not
 * enough history to estimate a trend.
 *
 * @param {number[]} series  time-ordered observations (e.g. minutes/week)
 * @param {number} alpha     level smoothing (0..1)
 * @param {number} beta      trend smoothing (0..1)
 */
export function holtForecast(series, alpha = 0.5, beta = 0.3) {
  const clean = (series || []).filter((v) => typeof v === 'number' && isFinite(v));
  if (clean.length === 0) return { level: 0, trend: 0, forecast: () => 0 };
  if (clean.length === 1) return { level: clean[0], trend: 0, forecast: () => clean[0] };

  let level = clean[0];
  let trend = clean[1] - clean[0];
  for (let i = 1; i < clean.length; i++) {
    const prevLevel = level;
    level = alpha * clean[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  const forecast = (k = 1) => Math.max(0, level + k * trend);
  return { level, trend, forecast };
}

/**
 * Weekly study minutes from a list of sessions.
 * @param {Array} sessions  each { date: 'YYYY-MM-DD', duration: seconds }
 * @param {number} weekStartDay  0=Sun .. 6=Sat (passed from Settings)
 * @returns {{minutes:number[], labels:string[], currentWeekIndex:number, currentWeekMinutes:number}}
 */
export function weeklyMinutesSeries(sessions, weekStartDay = 1) {
  if (!sessions || sessions.length === 0) {
    return { minutes: [], labels: [], currentWeekIndex: -1, currentWeekMinutes: 0 };
  }

  const dsOf = (d) => {
    const x = new Date(d);
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  };
  const startOfWeek = (d) => {
    const x = new Date(d);
    const diff = (x.getDay() - weekStartDay + 7) % 7;
    x.setDate(x.getDate() - diff);
    x.setHours(0, 0, 0, 0);
    return x;
  };

  const byWeek = new Map();
  for (const s of sessions) {
    if (!s.date) continue;
    const key = dsOf(startOfWeek(s.date));
    byWeek.set(key, (byWeek.get(key) || 0) + (s.duration || 0));
  }

  const sorted = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const minutes = sorted.map(([, secs]) => Math.round(secs / 60));
  const labels = sorted.map(([k]) => k.slice(5)); // MM-DD

  const todayKey = dsOf(startOfWeek(new Date()));
  const currentWeekIndex = labels.length ? sorted.findIndex(([k]) => k === todayKey) : -1;
  const currentWeekMinutes = currentWeekIndex >= 0 ? minutes[currentWeekIndex] : 0;

  return { minutes, labels, currentWeekIndex, currentWeekMinutes };
}

/**
 * Minutes/day still required to reach a weekly target.
 * @param {number} targetMinutes  weekly goal in minutes
 * @param {number} doneMinutes    minutes studied so far this week
 * @param {number} daysLeft       inclusive days remaining (today counts if not done)
 * @returns {{ remaining:number, perDay:number, onTrack:boolean, projected:number }}
 */
export function paceToGoal(targetMinutes, doneMinutes, daysLeft) {
  const remaining = Math.max(0, targetMinutes - doneMinutes);
  const safeDays = Math.max(1, daysLeft);
  const perDay = Math.ceil(remaining / safeDays);
  const projected = doneMinutes + remaining; // assuming the pace is met
  return {
    remaining,
    perDay,
    onTrack: doneMinutes >= targetMinutes || (daysLeft > 0 && remaining / safeDays <= targetMinutes / Math.max(1, safeDays)),
    projected: Math.max(doneMinutes, projected),
  };
}

/**
 * Estimate the probability (0..1) the student studies on a given weekday,
 * using exponential recency weighting (recent weeks count more).
 * @param {Array} sessions
 * @param {number} weekday  0=Sun..6=Sat
 * @param {number} decay    recency decay per week (e.g. 0.7)
 * @returns {number} probability
 */
export function dayOfWeekProbability(sessions, weekday, decay = 0.7) {
  if (!sessions || sessions.length === 0) return 0;

  const weeks = new Map(); // weekKey -> { total, days:{0..6}:seconds } }
  const startOfWeek = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    const diff = (x.getDay() - 1 + 7) % 7;
    x.setDate(x.getDate() - diff);
    return x.getTime();
  };
  const todayWeek = startOfWeek(new Date());

  for (const s of sessions) {
    if (!s.date) continue;
    const wk = startOfWeek(s.date);
    if (!weeks.has(wk)) weeks.set(wk, { days: {} });
    const dow = new Date(s.date).getDay();
    weeks.get(wk).days[dow] = (weeks.get(wk).days[dow] || 0) + (s.duration || 0);
  }

  let weightSum = 0;
  let hitSum = 0;
  for (const [wk, data] of weeks) {
    const ageWeeks = Math.round((todayWeek - wk) / (7 * 86400000));
    const w = Math.pow(decay, ageWeeks);
    weightSum += w;
    if ((data.days[weekday] || 0) > 0) hitSum += w;
  }
  if (weightSum === 0) return 0;
  return hitSum / weightSum;
}

/**
 * Streak-break risk for "if I don't study today, will my streak die?"
 * Combines the historical probability of studying *today's weekday* with how
 * fragile the current streak is (a long streak is safer than a 1-day streak).
 * @returns {{ risk:number, probToday:number, reason:string }}
 */
export function streakRisk(sessions, currentStreak, today = new Date()) {
  const dow = today.getDay();
  const probToday = dayOfWeekProbability(sessions, dow);

  // A longer streak implies a more consistent student, so it is "stickier".
  // Map streak length -> retention factor (0.4 at 1 day .. ~0.95 at 14+ days).
  const stickiness = Math.min(0.95, 0.4 + Math.min(currentStreak, 14) * 0.04);

  // If they historically rarely study on this weekday, the streak is fragile.
  const risk = Math.max(0, Math.min(1, (1 - probToday) * (2 - stickiness)));

  let reason = 'Looking good';
  if (risk > 0.66) reason = 'High risk — you often skip this weekday';
  else if (risk > 0.33) reason = 'Moderate risk today';

  return { risk, probToday, reason };
}

/**
 * Build a complete forecast summary from sessions + a weekly target.
 * @param {Array} sessions
 * @param {number} weeklyTargetMinutes
 * @param {object} opts  { weekStartDay, currentStreak, daysLeftThisWeek }
 */
export function buildForecast(sessions, weeklyTargetMinutes, opts = {}) {
  const weekStartDay = opts.weekStartDay ?? 1;
  const { minutes, labels, currentWeekIndex, currentWeekMinutes } =
    weeklyMinutesSeries(sessions, weekStartDay);

  // Forecast the NEXT week's total using Holt's trend on past weekly minutes
  // (exclude the in-progress current week to avoid biasing the trend low).
  const history = currentWeekIndex > 0 ? minutes.slice(0, currentWeekIndex) : minutes;
  const model = holtForecast(history);
  const nextWeekForecast = Math.round(model.forecast(1));

  const daysLeft = typeof opts.daysLeftThisWeek === 'number'
    ? opts.daysLeftThisWeek
    : 1;
  const pace = paceToGoal(weeklyTargetMinutes, currentWeekMinutes, daysLeft);

  const streak = opts.currentStreak || 0;
  const risk = streakRisk(sessions, streak);

  const willHit = weeklyTargetMinutes > 0
    ? (currentWeekMinutes + Math.max(0, pace.remaining - pace.perDay * (daysLeft - 1))) >= weeklyTargetMinutes
      ? true
      : nextWeekForecast >= weeklyTargetMinutes
    : null;

  return {
    history: { minutes, labels, currentWeekIndex, currentWeekMinutes },
    trend: model.trend,
    nextWeekForecast,
    pace,
    streakRisk: risk,
    weeklyTargetMinutes,
    willHit,
  };
}
