/**
 * StudyFlow — utils.js
 */

export function generateId() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

export function getToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

export function formatDurationClock(seconds) {
  if (!seconds || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function getWeekDates(refDate = new Date()) {
  const d = new Date(refDate);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(d);
    dd.setDate(d.getDate() + i);
    return dd.toISOString().split('T')[0];
  });
}

export function getStartOfWeek(refDate = new Date()) {
  const d = new Date(refDate);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function parseMarkdown(text, questions = []) {
  if (!text) return '';
  const questionMap = new Map(questions.map(q => [q.id, q]));
  const lines = text.split('\n');
  let html = '';
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.startsWith('### ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h4>' + escapeHtml(line.slice(4)) + '</h4>';
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h3>' + escapeHtml(line.slice(3)) + '</h3>';
      continue;
    }
    if (line.startsWith('# ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<h2>' + escapeHtml(line.slice(2)) + '</h2>';
      continue;
    }

    const checkedMatch = line.match(/^- \[x\] (.*)$/i);
    const uncheckedMatch = line.match(/^- \[ \] (.*)$/);
    if (checkedMatch) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<div class="checklist-item checked"><input type="checkbox" checked disabled><span>' + escapeHtml(checkedMatch[1]) + '</span></div>';
      continue;
    }
    if (uncheckedMatch) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<div class="checklist-item"><input type="checkbox" disabled><span>' + escapeHtml(uncheckedMatch[1]) + '</span></div>';
      continue;
    }

    if (line.startsWith('- ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + escapeHtml(line.slice(2)) + '</li>';
      continue;
    }

    if (inList) { html += '</ul>'; inList = false; }

    if (line.trim() === '') {
      html += '<br>';
      continue;
    }

    const questionMatch = line.match(/^\[Q:(.+?)\]$/);
    if (questionMatch) {
      const qid = questionMatch[1];
      const q = questionMap.get(qid);
      if (q) {
        const answerText = q.answer ? escapeHtml(q.answer) : 'No answer yet';
        const resolvedClass = q.resolved ? ' resolved' : '';
        html += `<span class="question-marker${resolvedClass}" data-question-id="${escapeHtml(qid)}">?<span class="question-tooltip"><strong>Q:</strong> ${escapeHtml(q.text)}<br><strong>A:</strong> ${answerText}</span></span>`;
      } else {
        html += '<span class="question-marker">?</span>';
      }
      continue;
    }

    let processed = escapeHtml(line);
    processed = processed.replace(/\$\$(.+?)\$\$/g, '<div class="katex-math">$1</div>');
    processed = processed.replace(/\$([^$]+)\$/g, '<span class="katex-math">$1</span>');
    processed = processed.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    processed = processed.replace(/\*(.*?)\*/g, '<em>$1</em>');
    processed = processed.replace(/\[\[(.*?)\]\]/g, '<a class="note-link" data-note-title="$1">$1</a>');

    html += '<p>' + processed + '</p>';
  }

  if (inList) html += '</ul>';

  return html;
}
