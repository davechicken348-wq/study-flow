/**
 * StudyFlow — questSeed.js
 *
 * Daily quest generation. The app seeds one "Daily quest" every day. Each day's
 * quest is picked deterministically from the current date (so it stays stable
 * across reloads within the same day), and is *mixed*: sometimes a study-time
 * target, sometimes a task from a template pool. Completing the daily quest
 * grants normal XP plus a bonus reward (handled by app.awardDailyQuestBonus).
 */

import Storage from './storage.js';
import { getToday } from './utils.js';

const DAILY_QUEST_ID = 'daily';
const DAILY_KIND = 'daily';

// Task-style daily quests. `target`/`unit` describe the measurable goal;
// `metric` tells the app how to measure completion from live data.
const TASK_TEMPLATES = [
  { id: 'review-notes', label: 'Review your notes', desc: 'Open and revisit at least {n} notes today.', target: 2, unit: 'notes', metric: 'notesReviewed', difficulty: 'normal' },
  { id: 'focus-rounds', label: 'Lock in a focus round', desc: 'Complete at least {n} focus rounds in the Timer.', target: 1, unit: 'rounds', metric: 'focusRounds', difficulty: 'easy' },
  { id: 'capture-question', label: 'Capture a question', desc: 'Turn a doubt into a tracked question in your notes ({n}x).', target: 1, unit: 'questions', metric: 'questionsCaptured', difficulty: 'normal' },
  { id: 'new-note', label: 'Start a fresh note', desc: 'Create at least {n} new note{s} today.', target: 1, unit: 'notes', metric: 'notesCreated', difficulty: 'easy' },
  { id: 'subject-spread', label: 'Study across subjects', desc: 'Study at least {n} different subjects today.', target: 2, unit: 'subjects', metric: 'subjectsStudied', difficulty: 'hard' },
  { id: 'planner-plan', label: 'Plan ahead', desc: 'Schedule at least {n} session{s} in the Planner.', target: 1, unit: 'sessions', metric: 'sessionsPlanned', difficulty: 'normal' },
];

// Study-time targets. Target is in hours; randomized a little per day.
const STUDY_TARGETS = [
  { target: 0.5, difficulty: 'easy' },
  { target: 1, difficulty: 'normal' },
  { target: 1.5, difficulty: 'normal' },
  { target: 2, difficulty: 'hard' },
];

// Bonus XP awarded (on top of normal per-minute XP) when the daily quest lands.
export const DAILY_QUEST_BONUS_XP = 25;

// Simple deterministic hash so a given date always yields the same quest.
function daySeed(dateStr) {
  let h = 2166136261;
  for (let i = 0; i < dateStr.length; i++) {
    h ^= dateStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

function pickFrom(arr, seed) {
  return arr[seed % arr.length];
}

/**
 * Build the daily quest definition for a given date (string YYYY-MM-DD).
 * Pure: returns a plain object describing the quest (not yet persisted).
 */
export function buildDailyQuest(dateStr = getToday()) {
  const seed = daySeed(dateStr);
  const useTask = (seed % 2) === 0; // mixed: alternate-ish by day

  if (useTask) {
    const tpl = pickFrom(TASK_TEMPLATES, seed);
    const n = tpl.target;
    const label = tpl.label;
    const desc = tpl.desc
      .replace('{n}', String(n))
      .replace('{s}', n === 1 ? '' : 's');
    return {
      id: DAILY_QUEST_ID,
      type: DAILY_KIND,
      kind: 'task',
      metric: tpl.metric,
      label,
      description: desc,
      target: n,
      unit: tpl.unit,
      difficulty: tpl.difficulty,
      active: true,
      progress: 0,
      order: 0,
      createdAt: new Date().toISOString(),
      bonusXp: DAILY_QUEST_BONUS_XP,
      forDate: dateStr,
    };
  }

  const st = pickFrom(STUDY_TARGETS, seed);
  return {
    id: DAILY_QUEST_ID,
    type: DAILY_KIND,
    kind: 'study',
    label: 'Daily study quest',
    description: `Spend at least ${st.target}h studying today.`,
    target: st.target,
    unit: 'hours',
    difficulty: st.difficulty,
    active: true,
    progress: 0,
    order: 0,
    createdAt: new Date().toISOString(),
    bonusXp: DAILY_QUEST_BONUS_XP,
    forDate: dateStr,
  };
}

/**
 * Ensure a daily quest exists for today. If none/inactive, or the existing one
 * belongs to a previous day, replace it with a freshly generated one. Returns
 * the active daily quest (may be a user-edited one if the user changed today's).
 */
export async function ensureDailyQuest() {
  const goals = await Storage.getAllGoals();
  const today = getToday();
  const existing = goals.find((g) => g.id === DAILY_QUEST_ID);

  // If the user has customized today's daily quest, keep it.
  if (existing && existing.forDate === today && existing.active) {
    return existing;
  }

  const fresh = buildDailyQuest(today);

  // Preserve a user-edited previous daily quest's progress isn't meaningful
  // across days, so we just replace it.
  await Storage.saveGoal(fresh);
  return fresh;
}

export function isDailyQuest(goal) {
  return !!goal && goal.id === DAILY_QUEST_ID && goal.type === DAILY_KIND;
}
