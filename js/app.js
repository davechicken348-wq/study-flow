import { generateId, getToday, formatDate, formatTime, formatDuration, formatDurationClock, getWeekDates, getStartOfWeek, escapeHtml, debounce } from './utils.js';
import Storage from './storage.js';

const PRESET_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#64748b'];

const app = {
  timerRunning: false,
  timerElapsed: 0,
  timerStartTime: null,
  timerInterval: null,
  timerSession: null,

  async init() {
    this.initTheme();
    this.setupListeners();
    await this.restoreTimerState();
    this.handleRoute();
  },

  initTheme() {
    const stored = localStorage.getItem('theme');
    if (stored) {
      document.documentElement.setAttribute('data-theme', stored);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  },

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  },

  setupListeners() {
    window.addEventListener('hashchange', () => this.handleRoute());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeModals();
    });

    // Sidebar toggle + backdrop
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      backdrop.classList.toggle('visible');
    });
    backdrop?.addEventListener('click', () => {
      sidebar.classList.remove('open');
      backdrop.classList.remove('visible');
    });

    // Sidebar nav links
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        history.pushState(null, '', `#${page}`);
        this.handleRoute();
      });
    });

    // Bottom nav (mobile)
    document.querySelectorAll('.bottom-nav-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        history.pushState(null, '', `#${page}`);
        this.handleRoute();
      });
    });

    document.getElementById('installBtn')?.addEventListener('click', () => this.installPWA());
    document.getElementById('installDismiss')?.addEventListener('click', () => {
      document.getElementById('installPrompt').classList.add('hidden');
    });
  },

  handleRoute() {
    const hash = window.location.hash.slice(1) || 'dashboard';

    // Sync sidebar nav
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.page === hash);
    });
    // Sync bottom nav
    document.querySelectorAll('.bottom-nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.page === hash);
    });

    // Close sidebar on mobile
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (window.innerWidth < 769) {
      sidebar?.classList.remove('open');
      backdrop?.classList.remove('visible');
    }
    const pages = {
      dashboard: () => this.renderDashboard(),
      subjects: () => this.renderSubjects(),
      planner: () => this.renderPlanner(),
      timer: () => this.renderTimer(),
      notes: () => this.renderNotes(),
      statistics: () => this.renderStatistics(),
      settings: () => this.renderSettings(),
    };
    const render = pages[hash] || pages.dashboard;
    document.getElementById('pageContent').innerHTML = '';
    render();
  },

  openModal(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const overlay = wrap.firstElementChild;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeModals();
    });
  },

  closeModals() {
    document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
  },

  toast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  },

  async renderDashboard() {
    const [subjects, sessions, goals] = await Promise.all([
      Storage.getAllSubjects(), Storage.getAllSessions(), Storage.getAllGoals(),
    ]);
    const today = getToday();
    const todaySessions = sessions.filter((s) => s.date === today);
    const todayTime = todaySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const weekDates = getWeekDates();
    const weekSessions = sessions.filter((s) => weekDates.includes(s.date));
    const weekTime = weekSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const streak = this.calculateStreak(sessions);
    const dailyGoal = goals.find((g) => g.type === 'daily' && g.active);
    const el = document.getElementById('pageContent');
    const hour = new Date().getHours();
    let greeting = 'Good morning';
    if (hour >= 12 && hour < 17) greeting = 'Good afternoon';
    else if (hour >= 17) greeting = 'Good evening';

    if (subjects.length === 0 && sessions.length === 0) {
      el.innerHTML = `
        <div class="dash-hero card">
          <div class="dash-hero-text">
            <h1>${escapeHtml(greeting)} 👋</h1>
            <p class="muted">Welcome to StudyFlow. Track sessions, plan your week, and hit your goals.</p>
            <button class="btn btn-primary mt" id="onboardingAddSubjectBtn">Add your first subject</button>
          </div>
          <svg class="dash-hero-illo" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="60" cy="60" r="54" fill="var(--accent-bg)"/>
            <rect x="30" y="44" width="60" height="42" rx="7" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>
            <rect x="38" y="54" width="22" height="4" rx="2" fill="var(--accent)" opacity="0.7"/>
            <rect x="38" y="62" width="44" height="3" rx="1.5" fill="var(--accent)" opacity="0.3"/>
            <rect x="38" y="69" width="32" height="3" rx="1.5" fill="var(--accent)" opacity="0.3"/>
            <circle cx="85" cy="38" r="12" fill="var(--accent)"/>
            <path d="M85 32v6l4 2" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      `;
      document.getElementById('onboardingAddSubjectBtn').addEventListener('click', () => this.showSubjectForm());
      return;
    }

    el.innerHTML = `
      <div class="dash-hero card">
        <div class="dash-hero-text">
          <h1>${escapeHtml(greeting)} 👋</h1>
          <p class="muted">Ready to focus? Here's your overview.</p>
        </div>
        <svg class="dash-hero-illo" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="60" cy="60" r="54" fill="var(--accent-bg)"/>
          <rect x="28" y="80" width="14" height="24" rx="3" fill="var(--accent)" opacity="0.3"/>
          <rect x="48" y="64" width="14" height="40" rx="3" fill="var(--accent)" opacity="0.5"/>
          <rect x="68" y="50" width="14" height="54" rx="3" fill="var(--accent)" opacity="0.7"/>
          <rect x="88" y="38" width="14" height="66" rx="3" fill="var(--accent)"/>
        </svg>
      </div>
      <div class="grid grid-4 gap mt">
        <div class="card">
          <div class="stat-value">${formatDuration(todayTime)}</div>
          <div class="stat-label">Today's Study Time</div>
        </div>
        <div class="card">
          <div class="stat-value">${formatDuration(weekTime)}</div>
          <div class="stat-label">This Week</div>
        </div>
        <div class="card">
          <div class="stat-value">${streak} days</div>
          <div class="stat-label">Current Streak</div>
        </div>
        <div class="card">
          <div class="stat-value">${subjects.length}</div>
          <div class="stat-label">Total Subjects</div>
        </div>
      </div>

      <div class="card mt-lg">
        <div class="card-header flex justify-between items-center">
          <h2>Today's Sessions</h2>
          <button class="btn btn-primary btn-sm" id="dashAddSubjectBtn">Add Subject</button>
        </div>
        ${todaySessions.length === 0 ? `
          <div class="empty-state">
            <svg class="empty-illo" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="60" cy="60" r="54" fill="var(--accent-bg)"/>
              <rect x="34" y="38" width="52" height="44" rx="6" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>
              <rect x="42" y="50" width="20" height="3" rx="1.5" fill="var(--accent)" opacity="0.5"/>
              <rect x="42" y="57" width="36" height="3" rx="1.5" fill="var(--accent)" opacity="0.3"/>
              <rect x="42" y="64" width="28" height="3" rx="1.5" fill="var(--accent)" opacity="0.3"/>
              <circle cx="82" cy="78" r="14" fill="var(--accent)"/>
              <path d="M76 78h12M82 72v12" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
            </svg>
            <h3>No sessions yet today</h3>
            <p>Start the timer or add a subject to log your first study session.</p>
          </div>` : `
          <div class="mt">
            ${todaySessions.map((s) => {
              const subj = subjects.find((x) => x.id === s.subjectId);
              const status = s.paused ? 'Paused' : (s.endTime ? formatDuration(s.duration || 0) : 'Running');
              return `
                <div class="flex justify-between items-center mb-sm">
                  <div>
                    <div class="font-medium">${subj ? escapeHtml(subj.name) : 'Unknown'}</div>
                    <div class="muted text-sm">${s.description ? escapeHtml(s.description) : ''}</div>
                  </div>
                  <span class="badge badge-success">${status}</span>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>

      ${dailyGoal ? `
      <div class="card mt">
        <div class="card-header"><h2>Daily Goal</h2></div>
        <div class="progress-bar mt">
          <div class="progress-fill" style="width: ${Math.min(100, (todayTime / (dailyGoal.target * 3600)) * 100)}%"></div>
        </div>
        <p class="muted text-center mt-sm">${formatDuration(todayTime)} / ${dailyGoal.target}h</p>
      </div>
      ` : ''}
    `;
    document.getElementById('dashAddSubjectBtn')?.addEventListener('click', () => this.showSubjectForm());
  },

  async renderSubjects() {
    const subjects = await Storage.getAllSubjects();
    const sessions = await Storage.getAllSessions();
    const el = document.getElementById('pageContent');

    el.innerHTML = `
      <div class="page-header flex justify-between items-center">
        <h1>Subjects</h1>
        <button class="btn btn-primary btn-sm" id="addSubjectBtn">Add Subject</button>
      </div>
      ${subjects.length === 0 ? `
        <div class="empty-state card mt">
          <svg class="empty-illo" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="60" cy="60" r="54" fill="var(--accent-bg)"/>
            <rect x="28" y="35" width="38" height="50" rx="5" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>
            <rect x="54" y="42" width="38" height="50" rx="5" fill="var(--surface)" stroke="var(--accent)" stroke-width="2" opacity="0.6"/>
            <rect x="34" y="48" width="20" height="3" rx="1.5" fill="var(--accent)" opacity="0.6"/>
            <rect x="34" y="55" width="26" height="3" rx="1.5" fill="var(--accent)" opacity="0.3"/>
            <rect x="34" y="62" width="16" height="3" rx="1.5" fill="var(--accent)" opacity="0.3"/>
            <circle cx="84" cy="80" r="14" fill="var(--accent)"/>
            <path d="M78 80h12M84 74v12" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
          <h3>No subjects yet</h3>
          <p>Add your first subject to start organising your study sessions.</p>
        </div>` : `
        <div class="grid grid-3 gap mt">
          ${subjects.map((s) => {
            const count = sessions.filter((x) => x.subjectId === s.id).length;
            const total = sessions.filter((x) => x.subjectId === s.id).reduce((sum, x) => sum + (x.duration || 0), 0);
            return `
              <div class="card">
                <div class="subject-stripe" style="background: ${escapeHtml(s.color)}"></div>
                <div>
                  <h3 class="truncate">${escapeHtml(s.name)}</h3>
                  <p class="muted text-sm mb-sm">${escapeHtml(s.description || 'No description')}</p>
                  <div class="flex justify-between items-center">
                    <span class="muted text-sm">${count} sessions · ${formatDuration(total)}</span>
                    <div class="flex gap-xs">
                      <button class="btn btn-ghost btn-sm" data-action="edit-subject" data-id="${s.id}">Edit</button>
                      <button class="btn btn-danger btn-sm" data-action="delete-subject" data-id="${s.id}">Delete</button>
                    </div>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    `;

    document.getElementById('addSubjectBtn')?.addEventListener('click', () => this.showSubjectForm());
    el.querySelectorAll('[data-action="edit-subject"]').forEach((b) => {
      b.addEventListener('click', () => this.showSubjectForm(subjects.find((s) => s.id === b.dataset.id)));
    });
    el.querySelectorAll('[data-action="delete-subject"]').forEach((b) => {
      b.addEventListener('click', () => this.deleteSubject(b.dataset.id));
    });
  },

  async showSubjectForm(subject) {
    const subjects = await Storage.getAllSubjects();
    const isEdit = !!subject;
    const data = subject || { id: generateId(), name: '', description: '', color: PRESET_COLORS[0] };

    this.openModal(`
      <div class="modal-overlay">
        <div class="modal">
          <div class="modal-header"><h2>${isEdit ? 'Edit' : 'Add'} Subject</h2></div>
          <form id="subjectForm" class="p">
            <input type="hidden" id="subjectId" value="${escapeHtml(data.id)}">
            <div class="form-group">
              <label>Name</label>
              <input type="text" id="subjectName" required value="${escapeHtml(data.name)}">
            </div>
            <div class="form-group">
              <label>Description</label>
              <textarea id="subjectDesc">${escapeHtml(data.description || '')}</textarea>
            </div>
            <div class="form-group">
              <label>Color</label>
              <div class="flex gap-sm mt">
                ${PRESET_COLORS.map((c) => `
                  <div class="color-swatch ${data.color === c ? 'selected' : ''}" data-color="${c}" style="background: ${c}"></div>
                `).join('')}
              </div>
              <input type="hidden" id="subjectColor" value="${escapeHtml(data.color)}">
            </div>
            <div class="flex justify-end gap mt">
              <button type="button" class="btn btn-ghost" id="cancelModal">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    `);

    let selectedColor = data.color;
    const colorInput = document.getElementById('subjectColor');

    document.querySelectorAll('.color-swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
        swatch.classList.add('selected');
        selectedColor = swatch.dataset.color;
        colorInput.value = selectedColor;
      });
    });

    document.getElementById('cancelModal').addEventListener('click', () => this.closeModals());
    document.getElementById('subjectForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('subjectId').value;
      const name = document.getElementById('subjectName').value.trim();
      const desc = document.getElementById('subjectDesc').value.trim();
      const color = colorInput.value;
      if (!name) return this.toast('Name is required', 'error');
      const existing = id ? subjects.find((s) => s.id === id) : null;
      const subj = { ...existing, id, name, description: desc, color };
      if (!subj.createdAt && existing) subj.createdAt = existing.createdAt;
      Storage.saveSubject(subj).then(() => {
        this.toast(isEdit ? 'Subject updated' : 'Subject added', 'success');
        this.closeModals();
        this.renderSubjects();
      });
    });
  },

  async deleteSubject(id) {
    if (!confirm('Delete this subject? All associated sessions and notes will also be deleted.')) return;
    await Storage.deleteSubject(id);
    this.toast('Subject deleted', 'success');
    this.renderSubjects();
  },

  async renderPlanner(refDate) {
    const [sessions, subjects] = await Promise.all([
      Storage.getAllSessions(), Storage.getAllSubjects(),
    ]);
    const weekDates = getWeekDates(refDate);
    const el = document.getElementById('pageContent');

    el.innerHTML = `
      <div class="page-header">
        <h1>Planner</h1>
        <p class="muted">Week of ${formatDate(getStartOfWeek(refDate).toISOString())}</p>
      </div>
      <div class="grid grid-7 gap-sm mt">
        ${weekDates.map((date) => {
          const daySessions = sessions.filter((s) => s.date === date && s.source !== 'timer').sort((a, b) => {
            if (!a.startTime) return 1;
            if (!b.startTime) return -1;
            return a.startTime.localeCompare(b.startTime);
          });
          const isToday = date === getToday();
          const d = new Date(date + 'T12:00:00');
          const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
          const dayNum = d.getDate();
          return `
            <div class="planner-day ${isToday ? 'today' : ''}">
              <div class="planner-day-header">
                <div class="planner-day-date">${dayNum}</div>
                <div>${dayName}</div>
              </div>
              <div class="flex flex-col gap-xs mt-sm">
                ${daySessions.length === 0 ? '<p class="muted text-sm">No sessions</p>' : daySessions.map((s) => {
                  const subj = subjects.find((x) => x.id === s.subjectId);
                  const start = s.startTime ? formatTime(s.startTime) : '';
                  const end = s.endTime ? formatTime(s.endTime) : '';
                  return `
                    <div class="planner-session">
                      <div class="planner-session-name">${subj ? escapeHtml(subj.name) : 'Unknown'}</div>
                      <div class="planner-session-time">${start}${start && end ? ' - ' : ''}${end}</div>
                      <div class="planner-session-actions flex gap-xs mt-sm">
                        <button class="btn btn-ghost btn-sm" data-action="edit-planner-session" data-id="${s.id}">Edit</button>
                        <button class="btn btn-danger btn-sm" data-action="delete-planner-session" data-id="${s.id}">×</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
              <button class="btn btn-ghost btn-sm btn-block mt-sm" data-action="add-session-day" data-date="${date}">+ Add</button>
            </div>
          `;
        }).join('')}
      </div>
    `;

    el.querySelectorAll('[data-action="add-session-day"]').forEach((b) => {
      b.addEventListener('click', () => this.showSessionForm({ date: b.dataset.date }));
    });
    el.querySelectorAll('[data-action="edit-planner-session"]').forEach((b) => {
      b.addEventListener('click', async () => {
        const s = sessions.find((x) => x.id === b.dataset.id);
        if (s) await this.showSessionForm(s);
      });
    });
    el.querySelectorAll('[data-action="delete-planner-session"]').forEach((b) => {
      b.addEventListener('click', () => this.deleteSession(b.dataset.id));
    });
  },

  async showSessionForm(session) {
    const subjects = await Storage.getAllSubjects();
    const isEdit = !!(session && session.id);
    const data = (session && session.id) ? session : { id: generateId(), subjectId: '', date: session?.date || getToday(), startTime: '', endTime: '', description: '' };

    this.openModal(`
      <div class="modal-overlay">
        <div class="modal">
          <div class="modal-header"><h2>${isEdit ? 'Edit' : 'Add'} Session</h2></div>
          <form id="sessionForm" class="p">
            <input type="hidden" id="sessionId" value="${escapeHtml(data.id)}">
            <div class="form-group">
              <label>Subject</label>
              <select id="sessionSubject">
                <option value="">Select subject</option>
                ${subjects.map((s) => `<option value="${s.id}" ${data.subjectId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Date</label>
              <input type="date" id="sessionDate" required value="${data.date || getToday()}">
            </div>
            <div class="form-group">
              <label>Start Time</label>
              <input type="time" id="sessionStart" required value="${data.startTime ? this._isoToLocalTime(data.startTime) : ''}">
            </div>
            <div class="form-group">
              <label>End Time</label>
              <input type="time" id="sessionEnd" value="${data.endTime ? this._isoToLocalTime(data.endTime) : ''}">
            </div>
            <div class="form-group">
              <label>Description</label>
              <textarea id="sessionDesc">${escapeHtml(data.description || '')}</textarea>
            </div>
            <div class="flex justify-end gap mt">
              <button type="button" class="btn btn-ghost" id="cancelModal">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    `);

    document.getElementById('cancelModal').addEventListener('click', () => this.closeModals());
    document.getElementById('sessionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('sessionId').value;
      const subjectId = document.getElementById('sessionSubject').value;
      const date = document.getElementById('sessionDate').value;
      const startVal = document.getElementById('sessionStart').value;
      const endVal = document.getElementById('sessionEnd').value;
      const desc = document.getElementById('sessionDesc').value.trim();

      if (!subjectId || !date || !startVal) return this.toast('Please fill required fields', 'error');
      if (endVal && endVal <= startVal) return this.toast('End time must be after start time', 'error');

      const startTime = `${date}T${startVal}:00`;
      const endTime = endVal ? `${date}T${endVal}:00` : null;
      const duration = endTime ? Math.floor((new Date(endTime) - new Date(startTime)) / 1000) : null;

      const existing = id ? (await Storage.getSession(id)) : null;
      const sess = { ...existing, id, subjectId, date, startTime, endTime, duration, description: desc, paused: false };
      await Storage.saveSession(sess);
      this.toast(isEdit ? 'Session updated' : 'Session added', 'success');
      this.closeModals();
      this.renderPlanner(new Date(date + 'T12:00:00'));
    });
  },

  _isoToLocalTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  },

  async deleteSession(id) {
    if (!confirm('Delete this session?')) return;
    await Storage.deleteSession(id);
    this.toast('Session deleted', 'success');
    const hash = window.location.hash.slice(1);
    if (hash === 'planner') this.renderPlanner();
    else if (hash === 'dashboard') this.renderDashboard();
  },

  async renderTimer() {
    const subjects = await Storage.getAllSubjects();
    const el = document.getElementById('pageContent');

    el.innerHTML = `
      <div class="flex flex-col items-center justify-center" style="min-height: 60vh;">
        <div class="timer-display ${this.timerRunning ? 'timer-running' : ''}" id="timerDisplay">${formatDurationClock(this.timerElapsed)}</div>
        <select class="mb" id="timerSubject" style="max-width:260px;" ${subjects.length === 0 ? 'disabled' : ''}>
          <option value="">Select subject</option>
          ${subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
        <div class="flex gap mt">
          ${!this.timerRunning && this.timerElapsed === 0 ? `<button class="btn btn-primary btn-lg" id="startTimerBtn">Start</button>` : ''}
          ${this.timerRunning ? `<button class="btn btn-ghost btn-lg" id="pauseTimerBtn">Pause</button>` : ''}
          ${!this.timerRunning && this.timerElapsed > 0 ? `<button class="btn btn-primary btn-lg" id="resumeTimerBtn">Resume</button><button class="btn btn-danger btn-lg" id="stopTimerBtn">Stop</button>` : ''}
        </div>
      </div>
    `;

    document.getElementById('startTimerBtn')?.addEventListener('click', () => this.startTimer());
    document.getElementById('pauseTimerBtn')?.addEventListener('click', () => this.pauseTimer());
    document.getElementById('resumeTimerBtn')?.addEventListener('click', () => this.resumeTimer());
    document.getElementById('stopTimerBtn')?.addEventListener('click', () => this.stopTimer());
  },

  async startTimer() {
    const subjectId = document.getElementById('timerSubject').value;
    if (!subjectId) return this.toast('Please select a subject', 'error');
    const session = {
      id: generateId(),
      subjectId,
      date: getToday(),
      startTime: new Date().toISOString(),
      endTime: null,
      duration: 0,
      description: '',
      paused: false,
      source: 'timer',
      createdAt: new Date().toISOString(),
    };
    await Storage.saveSession(session);
    this.timerSession = session;
    this.timerRunning = true;
    this.timerElapsed = 0;
    this.timerStartTime = new Date();
    this.timerInterval = setInterval(() => this.tickTimer(), 1000);
    this.renderTimer();
  },

  async pauseTimer() {
    clearInterval(this.timerInterval);
    this.timerInterval = null;
    this.timerRunning = false;
    this.timerSession.duration = this.timerElapsed;
    this.timerSession.paused = true;
    await Storage.saveSession(this.timerSession);
    this.renderTimer();
  },

  async resumeTimer() {
    if (!this.timerSession) return;
    this.timerSession.paused = false;
    this.timerSession.startTime = new Date(Date.now() - this.timerElapsed * 1000).toISOString();
    await Storage.saveSession(this.timerSession);
    this.timerRunning = true;
    this.timerStartTime = new Date(Date.now() - this.timerElapsed * 1000);
    this.timerInterval = setInterval(() => this.tickTimer(), 1000);
    this.renderTimer();
  },

  async stopTimer() {
    clearInterval(this.timerInterval);
    const endTime = new Date().toISOString();
    const duration = this.timerElapsed;
    if (this.timerSession) {
      this.timerSession.endTime = endTime;
      this.timerSession.duration = duration;
      this.timerSession.paused = false;
      await Storage.saveSession(this.timerSession);
    }
    this.timerRunning = false;
    this.timerElapsed = 0;
    this.timerStartTime = null;
    this.timerInterval = null;
    this.timerSession = null;
    this.toast('Session saved', 'success');
    this.renderTimer();
  },

  tickTimer() {
    if (this.timerStartTime) {
      this.timerElapsed = Math.floor((Date.now() - this.timerStartTime.getTime()) / 1000);
    } else {
      this.timerElapsed++;
    }
    const display = document.getElementById('timerDisplay');
    if (display) display.textContent = formatDurationClock(this.timerElapsed);
  },

  async restoreTimerState() {
    const sessions = await Storage.getAllSessions();
    const inProgress = sessions.find((s) => s.endTime === null && s.source === 'timer');
    if (!inProgress) return;
    this.timerSession = inProgress;
    this.timerElapsed = inProgress.duration || 0;
    if (!inProgress.paused) {
      const start = new Date(inProgress.startTime).getTime();
      this.timerElapsed += Math.max(0, Math.floor((Date.now() - start) / 1000));
      this.timerRunning = true;
      this.timerStartTime = new Date();
      this.timerInterval = setInterval(() => this.tickTimer(), 1000);
    } else {
      this.timerRunning = false;
      this.timerStartTime = null;
    }
  },

  async renderNotes() {
    const [notes, subjects] = await Promise.all([
      Storage.getAllNotes(), Storage.getAllSubjects(),
    ]);
    const el = document.getElementById('pageContent');

    el.innerHTML = `
      <div class="page-header flex justify-between items-center">
        <h1>Notes</h1>
        <button class="btn btn-primary btn-sm" id="addNoteBtn">Add Note</button>
      </div>
      <div class="flex gap mb notes-toolbar">
        <input type="text" id="noteSearch" placeholder="Search notes..." class="form-control">
        <select id="noteSubjectFilter" class="form-control">
          <option value="">All subjects</option>
          ${subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="grid grid-3 gap" id="notesGrid">
        ${notes.length === 0 ? `
          <div class="empty-state" style="grid-column:1/-1">
            <svg class="empty-illo" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="60" cy="60" r="54" fill="var(--accent-bg)"/>
              <rect x="32" y="30" width="56" height="62" rx="6" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>
              <line x1="32" y1="42" x2="88" y2="42" stroke="var(--accent)" stroke-width="1.5" opacity="0.4"/>
              <rect x="40" y="52" width="32" height="3" rx="1.5" fill="var(--accent)" opacity="0.5"/>
              <rect x="40" y="60" width="40" height="3" rx="1.5" fill="var(--accent)" opacity="0.3"/>
              <rect x="40" y="68" width="24" height="3" rx="1.5" fill="var(--accent)" opacity="0.3"/>
              <path d="M72 84 L80 76 L86 82 L78 90 Z" fill="var(--accent)" opacity="0.7"/>
              <path d="M80 76 L84 72 L90 78 L86 82 Z" fill="var(--accent)"/>
            </svg>
            <h3>No notes yet</h3>
            <p>Capture ideas, summaries, and key points from your study sessions.</p>
          </div>` : notes.map((n) => {
          const subj = subjects.find((x) => x.id === n.subjectId);
          return `
            <div class="card note-card">
              <h3>${escapeHtml(n.title)}</h3>
              <p class="note-content-preview muted">${escapeHtml(n.content || '')}</p>
              <div class="flex justify-between items-center mt">
                <span class="badge">${subj ? escapeHtml(subj.name) : 'No subject'}</span>
                <span class="muted text-sm">${formatDate(n.updatedAt || n.createdAt)}</span>
              </div>
              <div class="flex justify-end gap-xs mt-sm">
                <button class="btn btn-ghost btn-sm" data-action="edit-note" data-id="${n.id}">Edit</button>
                <button class="btn btn-danger btn-sm" data-action="delete-note" data-id="${n.id}">Delete</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    const search = document.getElementById('noteSearch');
    const filter = document.getElementById('noteSubjectFilter');

    const applyFilter = () => {
      const query = search.value.toLowerCase();
      const subjectFilter = filter.value;
      const filtered = notes.filter((n) => {
        const matchText = (n.title + ' ' + (n.content || '')).toLowerCase().includes(query);
        const matchSubject = !subjectFilter || n.subjectId === subjectFilter;
        return matchText && matchSubject;
      });

      const grid = document.getElementById('notesGrid');
      grid.innerHTML = filtered.length === 0 ? '<p class="muted">No notes match your search.</p>' : filtered.map((n) => {
        const subj = subjects.find((x) => x.id === n.subjectId);
        return `
          <div class="card note-card">
            <h3>${escapeHtml(n.title)}</h3>
            <p class="note-content-preview muted">${escapeHtml(n.content || '')}</p>
            <div class="flex justify-between items-center mt">
              <span class="badge">${subj ? escapeHtml(subj.name) : 'No subject'}</span>
              <span class="muted text-sm">${formatDate(n.updatedAt || n.createdAt)}</span>
            </div>
            <div class="flex justify-end gap-xs mt-sm">
              <button class="btn btn-ghost btn-sm" data-action="edit-note" data-id="${n.id}">Edit</button>
              <button class="btn btn-danger btn-sm" data-action="delete-note" data-id="${n.id}">Delete</button>
            </div>
          </div>
        `;
      }).join('');

      grid.querySelectorAll('[data-action="edit-note"]').forEach((b) => {
        b.addEventListener('click', () => this.showNoteForm(notes.find((n) => n.id === b.dataset.id)));
      });
      grid.querySelectorAll('[data-action="delete-note"]').forEach((b) => {
        b.addEventListener('click', () => this.deleteNote(b.dataset.id));
      });
    };

    search.addEventListener('input', debounce(applyFilter, 300));
    filter.addEventListener('change', applyFilter);

    document.getElementById('addNoteBtn')?.addEventListener('click', () => this.showNoteForm());
    el.querySelectorAll('[data-action="edit-note"]').forEach((b) => {
      b.addEventListener('click', () => this.showNoteForm(notes.find((n) => n.id === b.dataset.id)));
    });
    el.querySelectorAll('[data-action="delete-note"]').forEach((b) => {
      b.addEventListener('click', () => this.deleteNote(b.dataset.id));
    });
  },

  async showNoteForm(note) {
    const subjects = await Storage.getAllSubjects();
    const isEdit = !!note;
    const data = note || { id: generateId(), title: '', subjectId: '', content: '' };

    this.openModal(`
      <div class="modal-overlay">
        <div class="modal">
          <div class="modal-header"><h2>${isEdit ? 'Edit' : 'Add'} Note</h2></div>
          <form id="noteForm" class="p">
            <input type="hidden" id="noteId" value="${escapeHtml(data.id)}">
            <div class="form-group">
              <label>Title</label>
              <input type="text" id="noteTitle" required value="${escapeHtml(data.title)}">
            </div>
            <div class="form-group">
              <label>Subject</label>
              <select id="noteSubject">
                <option value="">No subject</option>
                ${subjects.map((s) => `<option value="${s.id}" ${data.subjectId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Content</label>
              <textarea id="noteContent" rows="5">${escapeHtml(data.content || '')}</textarea>
            </div>
            <div class="flex justify-end gap mt">
              <button type="button" class="btn btn-ghost" id="cancelModal">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    `);

    document.getElementById('cancelModal').addEventListener('click', () => this.closeModals());
    document.getElementById('noteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('noteId').value;
      const title = document.getElementById('noteTitle').value.trim();
      const subjectId = document.getElementById('noteSubject').value || null;
      const content = document.getElementById('noteContent').value.trim();

      if (!title) return this.toast('Title is required', 'error');
      const existing = note ? await Storage.getNote(id) : null;
      const noteObj = { ...existing, id, title, subjectId, content };
      await Storage.saveNote(noteObj);
      this.toast(isEdit ? 'Note updated' : 'Note added', 'success');
      this.closeModals();
      this.renderNotes();
    });
  },

  async deleteNote(id) {
    if (!confirm('Delete this note?')) return;
    await Storage.deleteNote(id);
    this.toast('Note deleted', 'success');
    this.renderNotes();
  },

  async renderStatistics() {
    const el = document.getElementById('pageContent');
    const sessions = await Storage.getAllSessions();

    if (sessions.length === 0) {
      el.innerHTML = `
        <div class="page-header"><h1>Statistics</h1></div>
        <div class="empty-state card">
          <svg class="empty-illo" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="60" cy="60" r="54" fill="var(--accent-bg)"/>
            <rect x="28" y="80" width="14" height="24" rx="3" fill="var(--accent)" opacity="0.3"/>
            <rect x="48" y="64" width="14" height="40" rx="3" fill="var(--accent)" opacity="0.5"/>
            <rect x="68" y="50" width="14" height="54" rx="3" fill="var(--accent)" opacity="0.7"/>
            <rect x="88" y="38" width="14" height="66" rx="3" fill="var(--accent)"/>
            <path d="M28 80 Q42 60 60 50 Q78 40 102 30" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3" fill="none" opacity="0.5"/>
          </svg>
          <h3>No data yet</h3>
          <p>Complete your first study session to start seeing statistics here.</p>
        </div>
      `;
      return;
    }

    el.innerHTML = `
      <div class="page-header"><h1>Statistics</h1></div>
      <div class="grid grid-4 gap" id="statsGrid">
        <div class="card"><div class="stat-value" id="statTotalTime">...</div><div class="stat-label">Total Time</div></div>
        <div class="card"><div class="stat-value" id="statWeekTime">...</div><div class="stat-label">This Week</div></div>
        <div class="card"><div class="stat-value" id="statMonthTime">...</div><div class="stat-label">This Month</div></div>
        <div class="card"><div class="stat-value" id="statLongest">...</div><div class="stat-label">Longest Session</div></div>
        <div class="card"><div class="stat-value" id="statAvg">...</div><div class="stat-label">Avg Session</div></div>
        <div class="card"><div class="stat-value" id="statTotalSessions">...</div><div class="stat-label">Sessions</div></div>
        <div class="card"><div class="stat-value" id="statStreak">...</div><div class="stat-label">Streak</div></div>
      </div>
      <div class="grid grid-2 gap mt stats-charts">
        <div class="card" id="barChartCard">
          <div class="card-header"><h2>Last 7 Days</h2></div>
          <div style="position:relative;height:200px">
            <canvas id="barChart"></canvas>
          </div>
        </div>
        <div class="card" id="doughnutChartCard">
          <div class="card-header"><h2>By Subject</h2></div>
          <div style="position:relative;height:200px">
            <canvas id="doughnutChart"></canvas>
          </div>
        </div>
      </div>
    `;

    const total = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const weekDates = getWeekDates();
    const weekSessions = sessions.filter((s) => weekDates.includes(s.date));
    const weekTime = weekSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthSessions = sessions.filter((s) => new Date(s.date) >= monthStart);
    const monthTime = monthSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const longest = sessions.reduce((max, s) => Math.max(max, s.duration || 0), 0);
    const avg = sessions.length > 0 ? Math.round(total / sessions.length) : 0;
    const streak = this.calculateStreak(sessions);

    document.getElementById('statTotalTime').textContent = formatDuration(total);
    document.getElementById('statWeekTime').textContent = formatDuration(weekTime);
    document.getElementById('statMonthTime').textContent = formatDuration(monthTime);
    document.getElementById('statLongest').textContent = formatDuration(longest);
    document.getElementById('statAvg').textContent = formatDuration(avg);
    document.getElementById('statTotalSessions').textContent = sessions.length;
    document.getElementById('statStreak').textContent = streak + ' days';

    if (typeof Chart !== 'undefined') {
      Chart.getChart('barChart')?.destroy();
      Chart.getChart('doughnutChart')?.destroy();
      const last7 = getWeekDates();
      const dailyData = last7.map((d) => {
        const daySessions = sessions.filter((s) => s.date === d);
        return Math.round(daySessions.reduce((sum, s) => sum + (s.duration || 0), 0) / 60);
      });
      const dayLabels = last7.map((d) => {
        const date = new Date(d + 'T12:00:00');
        return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      });

      new Chart(document.getElementById('barChart'), {
        type: 'bar',
        data: {
          labels: dayLabels,
          datasets: [{
            label: 'Minutes',
            data: dailyData,
            backgroundColor: '#1a7a3c',
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true } },
        },
      });

      const subjects = await Storage.getAllSubjects();
      const subjectData = subjects.map((s) => {
        const subjSessions = sessions.filter((x) => x.subjectId === s.id);
        return {
          name: s.name,
          total: subjSessions.reduce((sum, x) => sum + (x.duration || 0), 0),
          color: s.color,
        };
      }).filter((s) => s.total > 0);

      if (subjectData.length > 0) {
        new Chart(document.getElementById('doughnutChart'), {
          type: 'doughnut',
          data: {
            labels: subjectData.map((s) => s.name),
            datasets: [{
              data: subjectData.map((s) => Math.round(s.total / 60)),
              backgroundColor: subjectData.map((s) => s.color),
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' } },
          },
        });
      } else {
        document.getElementById('doughnutChartCard').innerHTML = '<p class="muted text-center mt">No subject data available</p>';
      }
    }
  },

  async renderSettings() {
    const el = document.getElementById('pageContent');
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const goals = await Storage.getAllGoals();
    const dailyGoal = goals.find((g) => g.type === 'daily' && g.active);

    el.innerHTML = `
      <div class="settings-header">
        <h1>Settings</h1>
        <p class="muted">Manage your preferences and data.</p>
      </div>

      <div class="settings-section card">
        <div class="settings-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          Appearance
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Theme</span>
            <span class="subtle">Choose between light and dark mode</span>
          </div>
          <div class="settings-theme-btns">
            <button class="settings-theme-btn ${currentTheme === 'light' ? 'active' : ''}" id="themeLight">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              Light
            </button>
            <button class="settings-theme-btn ${currentTheme === 'dark' ? 'active' : ''}" id="themeDark">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              Dark
            </button>
          </div>
        </div>
      </div>

      <div class="settings-section card">
        <div class="settings-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Goals
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Daily study goal</span>
            <span class="subtle">How many hours you aim to study each day</span>
          </div>
          <div class="settings-row-control">
            <input type="number" id="dailyGoalInput" min="0.5" step="0.5" value="${dailyGoal ? dailyGoal.target : ''}" placeholder="e.g. 2" style="width:90px;text-align:center">
            <button class="btn btn-primary btn-sm" id="saveGoalBtn">Save</button>
          </div>
        </div>
      </div>

      <div class="settings-section card">
        <div class="settings-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Data
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Export data</span>
            <span class="subtle">Download all your data as a JSON file</span>
          </div>
          <button class="btn btn-ghost btn-sm" id="exportBtn">Export JSON</button>
        </div>
        <div class="divider"></div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Import data</span>
            <span class="subtle">Restore from a previously exported file</span>
          </div>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer">
            Import JSON
            <input type="file" id="importFile" accept="application/json" class="hidden">
          </label>
        </div>
      </div>

      <div class="settings-section card settings-danger-zone">
        <div class="settings-section-title danger">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Danger Zone
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Clear all data</span>
            <span class="subtle">Permanently delete all subjects, sessions, notes and goals</span>
          </div>
          <button class="btn btn-danger btn-sm" id="clearAllBtn">Clear All</button>
        </div>
      </div>
    `;

    document.getElementById('themeLight')?.addEventListener('click', () => { this.setTheme('light'); this.renderSettings(); });
    document.getElementById('themeDark')?.addEventListener('click', () => { this.setTheme('dark'); this.renderSettings(); });
    document.getElementById('saveGoalBtn')?.addEventListener('click', async () => {
      const target = parseFloat(document.getElementById('dailyGoalInput').value);
      if (!target || target <= 0) return this.toast('Please enter a valid number', 'error');
      await Storage.saveGoal({ id: 'daily', type: 'daily', target, unit: 'hours', active: true });
      this.toast('Daily goal saved', 'success');
    });
    document.getElementById('exportBtn')?.addEventListener('click', async () => {
      const data = await Storage.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `studyflow-export-${getToday()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast('Data exported', 'success');
    });
    document.getElementById('importFile')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await Storage.importAll(data);
        this.toast('Data imported successfully', 'success');
        this.handleRoute();
      } catch {
        this.toast('Invalid import file', 'error');
      }
    });
    document.getElementById('clearAllBtn')?.addEventListener('click', () => {
      const input = prompt('Type DELETE to confirm clearing all data:');
      if (input === 'DELETE') {
        Storage.clearAll().then(() => {
          this.toast('All data cleared', 'success');
          this.handleRoute();
        });
      }
    });
  },

  calculateStreak(sessions) {
    if (sessions.length === 0) return 0;
    const days = new Set(sessions.map((s) => s.date));
    const dayList = Array.from(days).sort().reverse();
    let streak = 0;
    const today = new Date();
    let checkDate = new Date(today);
    if (!days.has(getToday())) {
      checkDate.setDate(checkDate.getDate() - 1);
    }
    while (true) {
      const ds = checkDate.toISOString().split('T')[0];
      if (days.has(ds)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
    return streak;
  },

  installPWA() {
    if (window.deferredPrompt) {
      window.deferredPrompt.prompt();
      window.deferredPrompt.userChoice.then(() => {
        document.getElementById('installPrompt').classList.add('hidden');
        window.deferredPrompt = null;
      });
    }
  },
};

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.deferredPrompt = e;
});

document.addEventListener('DOMContentLoaded', () => app.init());

export default app;
