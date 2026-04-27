'use strict';

/* ══════════════════════════════════════════════════════════
   PyTutor – app.js
   ══════════════════════════════════════════════════════════ */

// ── Constants ──────────────────────────────────────────────────────────────
const LS_PROG        = 'pytutor_progress';
const LS_KEY         = 'pytutor_api_key';
const LS_PROVIDER    = 'pytutor_api_provider';
const LS_DAILY       = 'pytutor_daily';
const LS_LAB_STATS   = 'pytutor_lab_stats';
const EXAM_TOTAL     = 10;   // questions per exam session
const EXAM_SECS      = 300;  // 5 minutes per question
const DAILY_GOAL     = 7;    // exercises per day for full circles

const LAB_CONFIG = [
  { id: 'lab01',    label: 'Lab 1'      },
  { id: 'lab02',    label: 'Lab 2'      },
  { id: 'lab03a',   label: 'Lab 3a'     },
  { id: 'lab03b',   label: 'Lab 3b'     },
  { id: 'lab04',    label: 'Lab 4'      },
  { id: 'lab05',    label: 'Lab 5'      },
  { id: 'lab06',    label: 'Lab 6'      },
  { id: 'lab07',    label: 'Lab 7'      },
  { id: 'lab09',         label: 'Lab 9'           },
  { id: 'exam_ki150',    label: 'Prüfung KI 150',  exam: true },
  { id: 'lab_exam',      label: 'Prüfungslab',      exam: true },
];

// ── Daily & Lab Stats (module-level, loaded at boot) ───────────────────────
let dailyStats = {};  // { "2026-04-24": {total, correct} }
let labStats   = {};  // { "lab01": {total, correct} }

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  exercises:            [],
  currentBase:          null,   // original exercise (reset / hints)
  currentEx:            null,   // possibly varied exercise shown to user
  currentLabId:         'lab01',
  hintLevel:            0,
  progress:             null,
  apiKey:               '',
  apiProvider:          'anthropic',
  running:              false,
  pendingSuccess:       false,  // set true after correct run, consumed on "Nächste Aufgabe"
  completionCardShown:  false,  // guard so completion card only shows once per lab
};

// Exam sub-state (isolated for clarity)
const exam = {
  active:    false,
  count:     0,       // questions answered
  correct:   0,       // correct answers this session
  startTime: null,    // Date.now() when session began
  qStart:    null,    // Date.now() when current question started
  timerSecs: EXAM_SECS,
  interval:  null,
  results:   [],      // [{id, passed, topics, timeSec}]
  used:      new Set(),
};

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadProgress();
  loadDailyStats();
  loadApiKey();
  buildLabSelector();
  bindEvents();
  registerServiceWorker();

  await loadLab('lab01');

  updateStreakDisplay();
  updateApiStatusBadge();

  // Änderung 2: first-run API-Key prompt
  if (!state.apiKey) {
    setTimeout(() => {
      openSettings();
      document.getElementById('api-key-status').textContent =
        '👋 Willkommen! Bitte trage deinen API Key ein um zu starten.';
      document.getElementById('api-key-status').className = 'api-key-status';
    }, 400);
  }

  addTutorMsg(
    'Hallo! 👋 Ich bin dein KI-Tutor. Schreib deinen Code und klick auf ▶ Ausführen. Ich erkläre dir was passiert!',
    'info'
  );
});

// ── Service Worker ─────────────────────────────────────────────────────────
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

/* ══════════════════════════════════════════════════════════
   PROGRESS
   ══════════════════════════════════════════════════════════ */
function loadProgress() {
  try {
    const raw = localStorage.getItem(LS_PROG);
    const p = raw ? JSON.parse(raw) : {};
    state.progress = {
      solved: {}, attempts: {}, correct: {}, weak_topics: [], streak: 0, total_score: 0,
      ...p,
      correct: p.correct || {},   // back-fill for existing saves without correct
    };
  } catch {
    state.progress = { solved: {}, attempts: {}, correct: {}, weak_topics: [], streak: 0, total_score: 0 };
  }
}

function saveProgress() {
  localStorage.setItem(LS_PROG, JSON.stringify(state.progress));
}

function updateProgress(passed) {
  const ex = state.currentBase;
  if (!ex) return;
  const id = ex.id;
  const p  = state.progress;

  p.attempts[id] = (p.attempts[id] || 0) + 1;

  if (passed) {
    p.correct[id] = (p.correct[id] || 0) + 1;
    const isNew = !p.solved[id];
    p.solved[id] = true;
    if (isNew) {
      const delta = { easy: 10, medium: 20, hard: 30 }[ex.difficulty] || 10;
      p.total_score += delta;
      p.streak      += 1;
    }
    // Remove topics from weak_topics once solved ≥3 times
    if ((p.attempts[id] || 0) >= 3) {
      ex.topics.forEach(t => {
        p.weak_topics = p.weak_topics.filter(w => w !== t);
      });
    }
  } else {
    ex.topics.forEach(t => {
      if (!p.weak_topics.includes(t)) p.weak_topics.push(t);
    });
  }

  saveProgress();
  updateStreakDisplay();
  checkLabCompletion(state.currentLabId, passed);
  if (document.getElementById('progress-content')
      && !document.getElementById('progress-content').classList.contains('hidden')) {
    renderProgressDashboard();
  }
}

/* ══════════════════════════════════════════════════════════
   API KEY
   ══════════════════════════════════════════════════════════ */
function loadApiKey() {
  state.apiKey      = localStorage.getItem(LS_KEY) || '';
  state.apiProvider = localStorage.getItem(LS_PROVIDER) || 'anthropic';
}

function saveApiKey(key, provider) {
  state.apiKey      = key.trim();
  state.apiProvider = provider || 'anthropic';
  if (state.apiKey) localStorage.setItem(LS_KEY, state.apiKey);
  else              localStorage.removeItem(LS_KEY);
  localStorage.setItem(LS_PROVIDER, state.apiProvider);
  updateApiStatusBadge();
}

function updateApiStatusBadge() {
  const btn = document.getElementById('api-status-btn');
  if (state.apiKey) {
    btn.textContent = 'API aktiv ✓';
    btn.className   = 'api-badge has-key';
  } else {
    btn.textContent = 'Kein API Key';
    btn.className   = 'api-badge no-key';
  }
}

/* ══════════════════════════════════════════════════════════
   LAB LOADING  (all labs are clickable; 404 → info message)
   ══════════════════════════════════════════════════════════ */
async function loadLab(labId) {
  state.currentLabId        = labId;
  state.completionCardShown = false;

  // Sonderfall: Prüfungslab lädt aus importierten Prüfungsaufgaben
  if (labId === 'lab_exam') {
    try {
      const raw = localStorage.getItem('exam_questions');
      let exercises = raw ? JSON.parse(raw) : [];
      if (!exercises.length) {
        // Fallback: lade vorgeladene Prüfungsaufgaben
        try {
          const resp = await fetch('./exercises/exam_ki150.json');
          if (resp.ok) {
            const data = await resp.json();
            exercises = Array.isArray(data) ? data : (data.exercises || []);
          }
        } catch { /* ignore */ }
      }
      if (!exercises.length) {
        state.exercises = [];
        addTutorMsg(
          'Noch keine Prüfungsaufgaben vorhanden. Importiere alte Prüfungen über <strong>Prüfungsaufgaben</strong> in der Menüleiste.',
          'info'
        );
        return;
      }
      state.exercises = exercises;
      checkLabCompletion(labId);
      selectNextExercise();
      addTutorMsg(
        `Prüfungslab geladen – <strong>${exercises.length} Aufgaben</strong> aus importierten Prüfungen. Übe ohne Zeitdruck!`,
        'info'
      );
    } catch {
      state.exercises = [];
    }
    return;
  }

  // 1. Check localStorage for user-imported labs (Änderung 1)
  const cached = localStorage.getItem(`pytutor_lab_${labId}`);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      state.exercises = data.exercises || [];
      checkLabCompletion(labId);
      selectNextExercise();
      return;
    } catch {
      // corrupted cache – fall through to fetch
      localStorage.removeItem(`pytutor_lab_${labId}`);
    }
  }

  // 2. Try bundled JSON file
  try {
    const res = await fetch(`./exercises/${labId}.json`);
    if (!res.ok) throw new Error('not found');
    const data = await res.json();
    state.exercises = Array.isArray(data) ? data : (data.exercises || []);
    checkLabCompletion(labId);
    selectNextExercise();
  } catch {
    state.exercises = [];
    const labLabel = LAB_CONFIG.find(l => l.id === labId)?.label || labId;
    addTutorMsg(
      `${labLabel} noch nicht verfügbar. Füge die Datei <code>exercises/${labId}.json</code> hinzu oder importiere das Übungsblatt über <strong>➕ Lab</strong>.`,
      'info'
    );
  }
}

/* ══════════════════════════════════════════════════════════
   LAB SELECTOR  (all labs are clickable buttons)
   ══════════════════════════════════════════════════════════ */
function buildLabSelector() {
  const container = document.getElementById('lab-selector');
  container.innerHTML = '';

  LAB_CONFIG.forEach(lab => {
    const btn = document.createElement('button');
    btn.className     = 'lab-btn' + (lab.id === 'lab01' ? ' active' : '') + (lab.exam ? ' lab-btn--exam' : '');
    btn.textContent   = lab.label;
    btn.dataset.labId = lab.id;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadLab(lab.id);
    });
    container.appendChild(btn);
  });
}

// Mark lab button green with ✓ if all exercises solved; show completion card only once per lab
function checkLabCompletion(labId, passed = false) {
  if (!state.exercises.length) return;
  const allSolved = state.exercises.every(ex => state.progress.solved[ex.id]);
  const btn = document.querySelector(`[data-lab-id="${labId}"]`);
  if (btn) {
    if (allSolved) btn.classList.add('done');
    else           btn.classList.remove('done');
  }
  if (allSolved && passed && !state.completionCardShown) {
    state.completionCardShown = true;
    showLabCompletionCard();
  }
}

function showLabCompletionCard() {
  const wrap = document.getElementById('tutor-messages');
  if (wrap.querySelector('.lab-completion-card')) return;

  const total    = state.exercises.length;
  const labLabel = LAB_CONFIG.find(l => l.id === state.currentLabId)?.label || state.currentLabId;
  const card     = document.createElement('div');
  card.className = 'lab-completion-card';
  card.innerHTML = `
    <div class="lc-title">🎉 ${labLabel} abgeschlossen!</div>
    <div class="lc-text">Du hast alle <strong>${total} Aufgaben</strong> erfolgreich gelöst.</div>
    <div class="lc-actions">
      <button id="repeat-lab-btn" class="btn btn-run">↺ Lab wiederholen</button>
      <button id="next-lab-btn" class="btn btn-explain">Nächstes Lab →</button>
    </div>`;
  wrap.appendChild(card);
  wrap.scrollTop = wrap.scrollHeight;

  document.getElementById('repeat-lab-btn').addEventListener('click', () => {
    state.exercises.forEach(ex => {
      delete state.progress.solved[ex.id];
      delete state.progress.attempts[ex.id];
      delete state.progress.correct[ex.id];
    });
    saveProgress();
    state.completionCardShown = false;
    clearTutorMessages();
    addTutorMsg(`Lab neu gestartet – ${total} Aufgaben warten auf dich. Viel Erfolg!`, 'info');
    selectNextExercise();
  });

  document.getElementById('next-lab-btn').addEventListener('click', () => {
    const idx     = LAB_CONFIG.findIndex(l => l.id === state.currentLabId);
    const nextLab = LAB_CONFIG[idx + 1];
    if (nextLab) {
      document.querySelectorAll('.lab-btn').forEach(b => b.classList.remove('active'));
      document.querySelector(`[data-lab-id="${nextLab.id}"]`)?.classList.add('active');
      loadLab(nextLab.id);
    } else {
      addTutorMsg('Du hast alle verfügbaren Labs abgeschlossen! 🏆', 'success');
    }
  });
}

/* ══════════════════════════════════════════════════════════
   EXERCISE SELECTION  (normal + exam mode priority)
   ══════════════════════════════════════════════════════════ */
function selectNextExercise() {
  if (!state.exercises.length) return;

  let pool = state.exercises;

  // In exam mode: prefer high relevance, skip already used in session
  if (exam.active) {
    const unused = pool.filter(ex => !exam.used.has(ex.id));
    if (!unused.length) {
      // all used → wrap around
      exam.used.clear();
    }
    const available = pool.filter(ex => !exam.used.has(ex.id));
    const highPool  = available.filter(ex => ex.exam_relevance === 'high');
    pool = highPool.length ? highPool : available;
  }

  const scored = pool.map(ex => {
    const id       = ex.id;
    const attempts = state.progress.attempts[id] || 0;
    const solved   = !!state.progress.solved[id];

    let score;
    if (attempts === 0)      score = 100;
    else if (!solved)        score = 80;
    else if (attempts === 1) score = 45;
    else                     score = 20;

    (ex.topics || []).forEach(t => {
      if (state.progress.weak_topics.includes(t)) score += 15;
    });

    return { ex, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top3   = scored.slice(0, 3);
  const chosen = top3[Math.floor(Math.random() * top3.length)].ex;
  displayExercise(chosen);
}

/* ══════════════════════════════════════════════════════════
   DISPLAY EXERCISE
   ══════════════════════════════════════════════════════════ */
async function displayExercise(exercise) {
  state.currentBase    = exercise;
  state.currentEx      = exercise;
  state.hintLevel      = 0;
  state.pendingSuccess = false;

  renderExercise(exercise);
  setEditorCode(exercise.starter_code);
  clearConsole();
  hideNextButton();
  resetHints();
  clearTutorMessages();

  const labSolved = state.exercises.filter(ex => state.progress.solved[ex.id]).length;
  const labTotal  = state.exercises.length;
  addTutorMsg(
    `Aufgabe <strong>${exercise.function_name}()</strong> gestartet ` +
    `(${labSolved}/${labTotal} in diesem Lab gelöst). ` +
    `Schreib deinen Code und klick auf ▶ Ausführen – ich erkläre dir was passiert!`,
    'info'
  );

  if (exam.active) {
    exam.used.add(exercise.id);
    startExamTimer();
  } else if (state.apiKey) {
    await generateVariation(exercise);
  }
}

function renderExercise(ex) {
  document.getElementById('exercise-id').textContent    = ex.id || '–';
  document.getElementById('exercise-title').textContent = (ex.function_name || ex.title) + '()';
  document.getElementById('exercise-description').textContent = ex.description_de || '';

  const attempts = state.progress.attempts[ex.id] || 0;
  const correct  = state.progress.correct[ex.id]  || 0;
  const statusEl = document.getElementById('exercise-status-icon');
  statusEl.textContent = '●';
  statusEl.style.color = correct >= 2 ? '#8fa888' : correct === 1 ? '#c4a882' : '#c17f6b';
  statusEl.title       = `${attempts} Versuche, ${correct} mal richtig`;

  const diffMap = { easy: 'leicht', medium: 'mittel', hard: 'schwer' };
  const diffEl  = document.getElementById('difficulty-badge');
  diffEl.textContent = diffMap[ex.difficulty] || ex.difficulty;
  diffEl.className   = `badge difficulty ${ex.difficulty}`;

  const examMap = { high: '★★★ Klausur', medium: '★★ Mittel', low: '★ Niedrig' };
  const examEl  = document.getElementById('exam-badge');
  examEl.textContent = examMap[ex.exam_relevance] || ex.exam_relevance;
  examEl.className   = `badge exam ${ex.exam_relevance}`;

  document.getElementById('variation-note').classList.add('hidden');
  document.getElementById('variation-note').textContent = '';

  const labSolved = state.exercises.filter(e => state.progress.solved[e.id]).length;
  const labTotal  = state.exercises.length;
  const countEl   = document.getElementById('exercise-count');
  if (countEl) countEl.textContent = labTotal ? `${labSolved}/${labTotal} gelöst` : '';

  renderTestPills(ex);
}

function renderTestPills(ex) {
  const container = document.getElementById('example-tests');
  container.innerHTML = '';
  const tests = (ex.tests || []).slice(0, 3);
  if (!tests.length) return;

  const label = mkEl('div', 'tests-label', 'Beispiele');
  container.appendChild(label);

  const pills = document.createElement('div');
  pills.className = 'test-pills';

  tests.forEach(t => {
    const inputs = Array.isArray(t.input) ? t.input.join(', ') : String(t.input);
    const expStr = JSON.stringify(t.expected);
    const pill   = document.createElement('span');
    pill.className = 'test-pill';
    pill.innerHTML =
      `<span class="fn">${escHtml(ex.function_name)}(${escHtml(inputs)})</span>` +
      `<span class="arr">→</span>` +
      `<span class="exp">${escHtml(expStr)}</span>`;
    pills.appendChild(pill);
  });

  container.appendChild(pills);
}

/* ══════════════════════════════════════════════════════════
   VARIATION  (Claude API)
   ══════════════════════════════════════════════════════════ */
async function generateVariation(exercise) {
  const spinner = document.getElementById('variation-spinner');
  spinner.classList.remove('hidden');

  const prompt = `Du bist Python-Dozent. Erstelle eine leicht abgewandelte Version dieser Aufgabe. WICHTIG: Behalte IMMER den exakt gleichen Funktionsnamen (${exercise.function_name}). Ändere nur die Zahlen, Grenzwerte oder Bedingungen – nie die Funktion selbst. Gib NUR JSON zurück mit den Feldern: description_de, function_name (muss "${exercise.function_name}" sein), starter_code, tests, variation_note.

Aufgabe:
${JSON.stringify({
    id:              exercise.id,
    function_name:   exercise.function_name,
    description_de:  exercise.description_de,
    parameters:      exercise.parameters,
    tests:           (exercise.tests || []).slice(0, 4),
    variation_rules: exercise.variation_rules,
    topics:          exercise.topics,
  })}`;

  try {
    const text   = await callAPI(prompt, 900, true);
    const varied = parseJSON(text);
    if (varied && Array.isArray(varied.tests) && varied.tests.length) {
      const merged = {
        ...exercise,
        description_de: varied.description_de || exercise.description_de,
        function_name:  exercise.function_name,   // always keep original name
        starter_code:   varied.starter_code
          ? varied.starter_code.replace(/def\s+\w+\s*\(/, `def ${exercise.function_name}(`)
          : exercise.starter_code,
        tests:          varied.tests,
      };
      state.currentEx = merged;
      renderExercise(merged);
      setEditorCode(merged.starter_code);
      if (varied.variation_note) {
        const note = document.getElementById('variation-note');
        note.textContent = '✨ ' + varied.variation_note;
        note.classList.remove('hidden');
      }
    }
  } catch {
    // silently fall back to original
  } finally {
    spinner.classList.add('hidden');
  }
}

/* ══════════════════════════════════════════════════════════
   CODE EDITOR
   ══════════════════════════════════════════════════════════ */
function setEditorCode(code) {
  const ta = document.getElementById('code-editor');
  ta.value = code || '';
  syncLineNumbers();
  ta.focus();
}

function syncLineNumbers() {
  const ta   = document.getElementById('code-editor');
  const nums = document.getElementById('line-numbers');
  const n    = ta.value.split('\n').length;
  nums.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
}

/* ══════════════════════════════════════════════════════════
   RUN CODE  (Claude API simulates execution)
   ══════════════════════════════════════════════════════════ */
async function runCode() {
  if (state.running) return;
  const code = document.getElementById('code-editor').value.trim();
  if (!code) return;

  if (!state.apiKey) {
    openSettings();
    addTutorMsg('Bitte gib zuerst deinen <strong>API Key</strong> in den Einstellungen ein (⚙️).', 'info');
    return;
  }

  state.running = true;
  setRunLoading(true);
  clearConsole();
  clearTutorMessages();

  const ex = state.currentEx || state.currentBase;

  const prompt = `Du bist Python-Interpreter. Führe diesen Code gedanklich aus und gib NUR JSON zurück (kein Text davor oder danach):
{
  "simulated_output": "<was print() ausgeben würde, leer wenn nichts>",
  "test_results": [{"passed": true/false, "input": <Eingabewert>, "got": <tatsächlicher Rückgabewert>, "expected": <erwarteter Wert>}],
  "all_passed": true/false,
  "status": "correct" | "wrong_logic" | "syntax_error" | "incomplete" | "runtime_error",
  "error_message": null oder "<Fehlermeldung>",
  "error_line": null oder <Zeilennummer>,
  "missing_for_perfect": null oder "<was fehlt auf Deutsch>",
  "next_improvement": null oder "<konkreter nächster Schritt auf Deutsch>"
}

Führe JEDEN Test einzeln aus. Berechne den tatsächlichen Rückgabewert des Codes für jeden Input – nicht was die Aufgabe erwartet, sondern was der Code WIRKLICH zurückgibt.

Aufgabe:
- Funktion: ${ex.function_name}
- Beschreibung: ${ex.description_de}
- Tests: ${JSON.stringify(ex.tests)}

Code:
\`\`\`python
${code}
\`\`\``;

  try {
    const text   = await callAPI(prompt, 1200, true);
    const result = parseJSON(text);
    if (!result || typeof result.all_passed === 'undefined') {
      throw new Error('Unerwartetes API-Antwortformat');
    }

    renderConsole(result, ex);
    updateProgress(result.all_passed);
    state.pendingSuccess = result.all_passed;

    if (exam.active) {
      handleExamAnswer(result.all_passed, ex);
    } else if (result.all_passed) {
      addTutorMsg('Ausgezeichnet! 🎉 Alle Tests bestanden! Du hast diese Aufgabe gemeistert. Bereit für die Nächste?', 'success');
      showNextButton();
    } else {
      await fetchErrorFeedback(code, result, ex);
    }
  } catch (e) {
    addTutorMsg(`Fehler beim API-Aufruf: <code>${escHtml(e.message)}</code>. Bitte prüfe deinen API Key in den Einstellungen.`, 'error');
  } finally {
    state.running = false;
    setRunLoading(false);
  }
}

function renderConsole(result, ex) {
  const out = document.getElementById('console-output');
  out.innerHTML = '';

  if (result.simulated_output) {
    out.append(mkEl('div', 'c-group-label', 'Ausgabe'));
    out.append(mkEl('div', 'c-output-text', result.simulated_output));
  }

  if (Array.isArray(result.test_results) && result.test_results.length) {
    out.appendChild(mkEl('div', 'c-group-label', 'Tests'));
    result.test_results.forEach(t => {
      const row    = document.createElement('div');
      row.className = 'c-test-row';
      const icon   = mkEl('span', t.passed ? 'c-icon-pass' : 'c-icon-fail', t.passed ? '✓' : '✗');
      const inputs = Array.isArray(t.input) ? t.input.join(', ') : String(t.input ?? '');
      const fn     = mkEl('span', 'c-fn', `${ex.function_name}(${escHtml(inputs)})`);
      row.append(icon, fn);
      if (!t.passed) {
        const detail = document.createElement('span');
        detail.className = 'c-detail';
        detail.innerHTML =
          `erwartet <span class="c-exp">${escHtml(JSON.stringify(t.expected))}</span>` +
          `, erhalten <span class="c-got">${escHtml(JSON.stringify(t.got))}</span>`;
        row.appendChild(detail);
      }
      out.appendChild(row);
    });
  }

  const passed = (result.test_results || []).filter(t => t.passed).length;
  const total  = (result.test_results || []).length;
  const cls    = result.all_passed ? 'pass' : 'fail';
  const msg    = result.all_passed
    ? `✓ Alle ${total} Tests bestanden!`
    : `${passed} von ${total} Tests bestanden`;
  out.appendChild(mkEl('div', `c-summary ${cls}`, msg));

  // ── "Was passiert im Hintergrund?" collapsible ──
  if (Array.isArray(result.line_by_line) && result.line_by_line.length) {
    const details = document.createElement('details');
    details.className = 'c-bg-details';

    const summary = document.createElement('summary');
    summary.className = 'c-bg-summary';
    summary.textContent = '🔍 Was passiert im Hintergrund?';
    details.appendChild(summary);

    const content = document.createElement('div');
    content.className = 'c-bg-content';

    result.line_by_line.forEach(ln => {
      const row = document.createElement('div');
      row.className = `c-bg-line c-bg-line--${ln.status || 'correct'}`;

      const codeCol = document.createElement('div');
      codeCol.className = 'c-bg-code';
      codeCol.innerHTML =
        `<span class="c-bg-lineno">${ln.line_no}</span>` +
        `<code class="c-bg-snippet">${escHtml(ln.code)}</code>`;

      const textCol = document.createElement('div');
      textCol.className = 'c-bg-text';
      textCol.innerHTML =
        `<span class="c-bg-what">${escHtml(ln.what_happens)}</span>` +
        (ln.background ? ` <span class="c-bg-concept">${escHtml(ln.background)}</span>` : '') +
        (ln.output_contribution ? `<br><span class="c-bg-out">${escHtml(ln.output_contribution)}</span>` : '');

      row.append(codeCol, textCol);
      content.appendChild(row);
    });

    if (result.missing_for_perfect) {
      const miss = document.createElement('div');
      miss.className = 'c-bg-footer c-bg-missing';
      miss.innerHTML = `<span class="c-bg-footer-label">Fehlt noch:</span> ${escHtml(result.missing_for_perfect)}`;
      content.appendChild(miss);
    }

    if (result.next_improvement) {
      const next = document.createElement('div');
      next.className = 'c-bg-footer c-bg-next';
      next.innerHTML = `<span class="c-bg-footer-label">Nächster Schritt:</span> ${escHtml(result.next_improvement)}`;
      content.appendChild(next);
    }

    details.appendChild(content);
    out.appendChild(details);
  }
}

/* ══════════════════════════════════════════════════════════
   ERROR FEEDBACK  (auto-triggered on failure, skipped in exam)
   ══════════════════════════════════════════════════════════ */
async function fetchErrorFeedback(code, result, ex) {
  const loadId = addLoadingBubble();

  const failedTests = (result.test_results || []).filter(t => !t.passed).slice(0, 3);

  const prompt = `Du bist ein geduldiger Python-Tutor. Erkläre auf Deutsch als HTML (<strong>, <code>, <br> – kein Markdown) in GENAU diesen vier Abschnitten WARUM der Code nicht funktioniert:

<strong>1. Was stimmt nicht?</strong><br>
Nenne das konkrete Problem (1–2 Sätze). Welche Zeile macht was Falsches – und WARUM ist das ein Fehler?

<strong>2. Warum verhält Python sich so?</strong><br>
Erkläre das zugrundeliegende Python-Konzept (z.B. Rückgabewerte, Schleifen, Bedingungen, Typen) von Grund auf: Wie funktioniert es, und WARUM funktioniert es so? Gib ein einfaches Mini-Beispiel mit <code>-Tags.

<strong>3. Warum passt mein Code nicht zur Aufgabe?</strong><br>
Gehe durch die problematischen Zeilen. Zeige für jede Zeile mit einem konkreten Testwert: Was berechnet der Code WIRKLICH (z.B. <code>double(3)</code> gibt <code>3</code> zurück weil <code>return x</code> nur x zurückgibt), und warum weicht das von der Erwartung ab?

<strong>4. Wie passe ich meinen Code an?</strong><br>
Zeige den konkreten Änderungsschritt mit <code>-Tags. Erkläre auch WARUM diese Änderung das Problem löst – nicht einfach "mach X", sondern "mach X, weil Python dann Y macht, was Z bewirkt".

Maximal 300 Wörter. Freundlicher, ermutigender Ton. Keine fertige Komplettlösung.

Aufgabe: <code>${ex.function_name}</code> – ${ex.description_de}

Code des Studenten:
<code>${code}</code>

Fehlerstatus: ${result.status}${result.error_message ? '\nFehler: ' + result.error_message : ''}
Fehlgeschlagene Tests: ${JSON.stringify(failedTests)}`;

  try {
    const text = await callAPI(prompt, 1500);
    removeLoadingBubble(loadId);
    addTutorMsg(text, 'error');
  } catch {
    removeLoadingBubble(loadId);
    addTutorMsg('Tipp: Überprüfe deine Logik Schritt für Schritt. Stimmen alle Fälle?', 'hint');
  }
}

/* ══════════════════════════════════════════════════════════
   LINE-BY-LINE EXPLANATION
   ══════════════════════════════════════════════════════════ */
async function explainCode() {
  if (exam.active) return; // blocked in exam mode

  if (!state.apiKey) {
    openSettings();
    addTutorMsg('Bitte gib zuerst deinen <strong>API Key</strong> ein (⚙️).', 'info');
    return;
  }

  const code = document.getElementById('code-editor').value.trim();
  if (!code || code === (state.currentBase?.starter_code || '').trim()) {
    addTutorMsg('Schreib zuerst etwas Code – dann erkläre ich dir was jede Zeile macht!', 'info');
    return;
  }

  clearTutorMessages();
  const loadId = addLoadingBubble();

  const ex = state.currentBase;
  const prompt = `Du bist Python-Tutor. Erkläre diesem Anfänger jede Zeile seines Codes auf Deutsch als HTML (<code>, <br>, <strong> – kein Markdown).

Für jede nicht-leere Zeile schreibe: <strong>Zeile N:</strong> <code>[Code]</code><br>→ [Was diese Zeile macht (WAS)] – und WARUM sie so geschrieben ist (welches Python-Konzept steckt dahinter, warum genau diese Syntax).<br><br>

Sei sehr anfängerfreundlich – erkläre auch Selbstverständliches wenn es zum Verständnis beiträgt.${ex ? `\n\nKontext: Die Funktion heißt "${ex.function_name}" und soll: ${ex.description_de}` : ''}

Code:
\`\`\`python
${code}
\`\`\``;

  try {
    const text = await callAPI(prompt, 1000);
    removeLoadingBubble(loadId);
    addTutorMsg(text, 'explain');
  } catch (e) {
    removeLoadingBubble(loadId);
    addTutorMsg(`Fehler: <code>${escHtml(e.message)}</code>`, 'error');
  }
}

/* ══════════════════════════════════════════════════════════
   HINTS
   ══════════════════════════════════════════════════════════ */
function showNextHint() {
  if (exam.active) return; // blocked in exam mode

  const ex      = state.currentBase;
  const hints   = ex?.hints || [];
  const btn     = document.getElementById('hint-btn');
  const display = document.getElementById('hint-display');

  if (state.hintLevel >= hints.length) return;

  display.classList.remove('hidden');
  const item = document.createElement('div');
  item.className = 'hint-item';
  item.innerHTML = `<span class="hint-num">T${state.hintLevel + 1}</span><span>${escHtml(hints[state.hintLevel])}</span>`;
  display.appendChild(item);

  state.hintLevel++;

  if (state.hintLevel >= hints.length) {
    btn.disabled    = true;
    btn.textContent = '💡 Alle Tipps gezeigt';
  } else {
    btn.textContent = `💡 Tipp ${state.hintLevel + 1} anzeigen`;
  }
}

function resetHints() {
  state.hintLevel = 0;
  const btn = document.getElementById('hint-btn');
  btn.disabled    = false;
  btn.textContent = '💡 Tipp anzeigen';
  const display = document.getElementById('hint-display');
  display.innerHTML = '';
  display.classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════
   SHOW SOLUTION
   ══════════════════════════════════════════════════════════ */
function showSolution() {
  if (exam.active) return;
  const ex = state.currentBase;
  if (!ex?.canonical_solution) {
    addTutorMsg('Für diese Aufgabe ist keine Musterlösung hinterlegt.', 'info');
    return;
  }
  setEditorCode(ex.canonical_solution);
  addTutorMsg(
    'Die Musterlösung wurde in den Editor eingefügt. Schau sie dir genau an – ' +
    'führe sie aus und versuche dann zu verstehen, warum jede Zeile so geschrieben ist!',
    'hint'
  );
}

/* ══════════════════════════════════════════════════════════
   EXAM MODE  – Erweiterung 1
   ══════════════════════════════════════════════════════════ */
function startExamMode() {
  exam.active    = true;
  exam.count     = 0;
  exam.correct   = 0;
  exam.startTime = Date.now();
  exam.results   = [];
  exam.used      = new Set();

  document.body.classList.add('exam-active');
  document.getElementById('exam-bar').classList.remove('hidden');
  document.getElementById('exam-btn').classList.add('active');
  document.getElementById('exam-btn').textContent = '🎯 Prüfung läuft';

  updateExamBar();
  addTutorMsg('🎯 <strong>Prüfungsmodus gestartet!</strong> 10 Aufgaben, 5 Minuten pro Aufgabe. Tipps und Erklärungen sind deaktiviert. Viel Erfolg!', 'info');
  selectNextExercise();
}

function stopExamMode() {
  exam.active = false;
  clearInterval(exam.interval);
  exam.interval = null;

  document.body.classList.remove('exam-active');
  document.getElementById('exam-bar').classList.add('hidden');
  document.getElementById('exam-btn').classList.remove('active');
  document.getElementById('exam-btn').textContent = '🎯 Prüfung';
}

function startExamTimer() {
  clearInterval(exam.interval);
  exam.timerSecs = EXAM_SECS;
  exam.qStart    = Date.now();
  updateTimerDisplay();

  exam.interval = setInterval(() => {
    exam.timerSecs--;
    updateTimerDisplay();
    if (exam.timerSecs <= 0) {
      clearInterval(exam.interval);
      addTutorMsg('⏰ Zeit abgelaufen! Diese Aufgabe wird als nicht gelöst gewertet.', 'error');
      handleExamAnswer(false, state.currentBase);
    }
  }, 1000);
}

function updateTimerDisplay() {
  const mins  = String(Math.floor(exam.timerSecs / 60)).padStart(2, '0');
  const secs  = String(exam.timerSecs % 60).padStart(2, '0');
  const el    = document.getElementById('exam-timer');
  el.textContent = `${mins}:${secs}`;
  const urgent = exam.timerSecs <= 60;
  el.classList.toggle('urgent', urgent);

  const fill = document.getElementById('exam-timer-fill');
  fill.style.width = `${(exam.timerSecs / EXAM_SECS) * 100}%`;
  fill.classList.toggle('urgent', urgent);
}

function updateExamBar() {
  document.getElementById('exam-progress-label').textContent =
    `Frage ${exam.count + 1} / ${EXAM_TOTAL}`;
  document.getElementById('exam-score-label').textContent =
    `${exam.correct} richtig`;
}

function handleExamAnswer(passed, ex) {
  clearInterval(exam.interval);
  exam.interval = null;

  const timeSec = Math.round((Date.now() - (exam.qStart || Date.now())) / 1000);
  exam.results.push({ id: ex?.id, passed, topics: ex?.topics || [], timeSec });

  if (passed) {
    exam.correct++;
    addTutorMsg('✓ Richtig! Weiter so.', 'success');
  } else {
    addTutorMsg('✗ Falsch. Nächste Aufgabe.', 'error');
  }
  exam.count++;
  updateExamBar();

  if (exam.count >= EXAM_TOTAL) {
    // Session done – show results after brief pause
    setTimeout(() => {
      showExamResults();
      stopExamMode();
    }, 1200);
  } else {
    // Load next question after 1.5 s
    setTimeout(() => {
      updateExamBar();
      selectNextExercise();
    }, 1500);
  }
}

function showExamResults() {
  const totalTime = Math.round((Date.now() - exam.startTime) / 1000);
  const mins      = String(Math.floor(totalTime / 60)).padStart(2, '0');
  const secs      = String(totalTime % 60).padStart(2, '0');

  // Stärken: topics where ≥3 exam results were correct
  const topicCorrect = {};
  exam.results.forEach(r => {
    if (r.passed) {
      (r.topics || []).forEach(t => {
        topicCorrect[t] = (topicCorrect[t] || 0) + 1;
      });
    }
  });
  const strengths = Object.entries(topicCorrect)
    .filter(([, n]) => n >= 3)
    .map(([t]) => t);

  const weaknesses = state.progress.weak_topics.slice(0, 5);

  // Prüfungsbereitschaft
  const strongTopics = computeStrongTopics();
  let readiness = (exam.correct / EXAM_TOTAL) * 100;
  readiness += strongTopics.length * 5;
  readiness -= weaknesses.length * 10;
  readiness = Math.max(0, Math.min(100, Math.round(readiness)));

  const readinessColor = readiness >= 70 ? 'good' : readiness >= 45 ? 'warn' : 'bad';
  const readinessBarColor = readiness >= 70 ? 'var(--green)' : readiness >= 45 ? 'var(--orange)' : 'var(--red)';

  // Empfehlung: top 2 exercises from weak topics or lowest solved count
  const recommended = getWeakestExercises(2);

  const wrap  = document.getElementById('tutor-messages');
  const card  = document.createElement('div');
  card.className = 'exam-results-card';
  card.innerHTML = `
    <div class="er-title">🎯 Prüfungs-Auswertung</div>
    <div class="er-row">
      <span class="er-key">Richtig:</span>
      <span class="er-val ${exam.correct >= 7 ? 'good' : exam.correct >= 4 ? 'warn' : 'bad'}">
        ${exam.correct} / ${EXAM_TOTAL}
      </span>
    </div>
    <div class="er-row">
      <span class="er-key">Zeit:</span>
      <span class="er-val">${mins}:${secs}</span>
    </div>
    <div class="er-row">
      <span class="er-key">Stärken:</span>
      <span class="er-val">${strengths.length ? strengths.join(', ') : '–'}</span>
    </div>
    <div class="er-row">
      <span class="er-key">Schwächen:</span>
      <span class="er-val ${weaknesses.length ? 'warn' : 'good'}">${weaknesses.length ? weaknesses.join(', ') : 'Keine ✓'}</span>
    </div>
    <div class="er-row">
      <span class="er-key">Prüfungsbereitschaft:</span>
      <div class="readiness-bar-wrap">
        <span class="er-val ${readinessColor}">${readiness}%</span>
        <div class="readiness-track">
          <div class="readiness-fill" style="width:${readiness}%; background:${readinessBarColor}"></div>
        </div>
      </div>
    </div>
    <div class="er-row">
      <span class="er-key">Empfehlung:</span>
      <span class="er-val">Übe noch: ${recommended.length ? recommended.map(e => e.function_name + '()').join(', ') : 'Alle gut!'}</span>
    </div>`;

  wrap.appendChild(card);
  wrap.scrollTop = wrap.scrollHeight;
}

// Returns topics where ≥3 exercises in the current lab are solved
function computeStrongTopics() {
  const topicSolved = {};
  state.exercises.forEach(ex => {
    if (state.progress.solved[ex.id]) {
      (ex.topics || []).forEach(t => {
        topicSolved[t] = (topicSolved[t] || 0) + 1;
      });
    }
  });
  return Object.entries(topicSolved).filter(([, n]) => n >= 3).map(([t]) => t);
}

// Returns up to n exercises that match the most weak topics (or have fewest solves)
function getWeakestExercises(n) {
  const scored = state.exercises.map(ex => {
    const weakMatch = (ex.topics || []).filter(t =>
      state.progress.weak_topics.includes(t)
    ).length;
    const solved = state.progress.solved[ex.id] ? 1 : 0;
    return { ex, score: weakMatch * 10 - solved * 5 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map(s => s.ex);
}

/* ══════════════════════════════════════════════════════════
   PROGRESS DASHBOARD  – Erweiterung 2
   ══════════════════════════════════════════════════════════ */
function toggleProgressDashboard() {
  const content = document.getElementById('progress-content');
  const arrow   = document.getElementById('progress-arrow');
  const hidden  = content.classList.contains('hidden');

  if (hidden) {
    content.classList.remove('hidden');
    arrow.classList.add('open');
    renderProgressDashboard();
  } else {
    content.classList.add('hidden');
    arrow.classList.remove('open');
  }
}

function renderProgressDashboard() {
  const content = document.getElementById('progress-content');
  content.innerHTML = '';

  const p = state.progress;

  // ── Overview stats ──
  const overviewEl = document.createElement('div');
  overviewEl.className = 'prog-overview';
  const solvedCount = Object.values(p.solved).filter(Boolean).length;
  const totalEx     = state.exercises.length;
  overviewEl.innerHTML = `
    <div class="prog-stat">
      <span class="prog-stat-value">${solvedCount}/${totalEx}</span>
      <span class="prog-stat-label">Gelöst</span>
    </div>
    <div class="prog-stat">
      <span class="prog-stat-value" style="color:var(--orange)">${p.streak}</span>
      <span class="prog-stat-label">Streak</span>
    </div>
    <div class="prog-stat">
      <span class="prog-stat-value" style="color:var(--yellow)">⭐ ${p.total_score}</span>
      <span class="prog-stat-label">Punkte</span>
    </div>`;
  content.appendChild(overviewEl);

  // ── Topic progress bars ──
  const topicStats = {};
  state.exercises.forEach(ex => {
    (ex.topics || []).forEach(t => {
      if (!topicStats[t]) topicStats[t] = { total: 0, solved: 0 };
      topicStats[t].total++;
      if (p.solved[ex.id]) topicStats[t].solved++;
    });
  });

  if (Object.keys(topicStats).length) {
    const barsWrap = document.createElement('div');
    barsWrap.innerHTML = `<div class="prog-bars-title">Themen-Fortschritt</div>`;

    Object.entries(topicStats)
      .sort((a, b) => (b[1].solved / b[1].total) - (a[1].solved / a[1].total))
      .forEach(([topic, stat]) => {
        const pct     = stat.total ? Math.round((stat.solved / stat.total) * 100) : 0;
        const fillCls = pct >= 80 ? '' : pct >= 40 ? 'medium' : 'weak';
        const row     = document.createElement('div');
        row.className = 'prog-bar-row';
        row.innerHTML = `
          <span class="prog-bar-label" title="${escHtml(topic)}">${escHtml(topic)}</span>
          <div class="prog-bar-track">
            <div class="prog-bar-fill ${fillCls}" style="width:${pct}%"></div>
          </div>
          <span class="prog-bar-count">${stat.solved}/${stat.total}</span>`;
        barsWrap.appendChild(row);
      });
    content.appendChild(barsWrap);
  }

  // ── Strong topic tags ──
  const strongTopics = computeStrongTopics();
  if (strongTopics.length) {
    const strongWrap = document.createElement('div');
    strongWrap.innerHTML = `<div class="tags-section-label">Stärken (3+ gelöst)</div>`;
    const tags = document.createElement('div');
    tags.className = 'topic-tags';
    strongTopics.forEach(t => {
      tags.appendChild(mkEl('span', 'topic-tag strong', t));
    });
    strongWrap.appendChild(tags);
    content.appendChild(strongWrap);
  }

  // ── Weak topic tags ──
  if (p.weak_topics.length) {
    const weakWrap = document.createElement('div');
    weakWrap.innerHTML = `<div class="tags-section-label">Schwächen (üben!)</div>`;
    const tags = document.createElement('div');
    tags.className = 'topic-tags';
    p.weak_topics.forEach(t => {
      tags.appendChild(mkEl('span', 'topic-tag weak', t));
    });
    weakWrap.appendChild(tags);
    content.appendChild(weakWrap);
  }
}

/* ══════════════════════════════════════════════════════════
   DAILY STATS + LAB STATS
   ══════════════════════════════════════════════════════════ */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadDailyStats() {
  try { dailyStats = JSON.parse(localStorage.getItem(LS_DAILY)     || '{}'); } catch { dailyStats = {}; }
  try { labStats   = JSON.parse(localStorage.getItem(LS_LAB_STATS) || '{}'); } catch { labStats   = {}; }
}

function saveDailyStats() {
  localStorage.setItem(LS_DAILY,     JSON.stringify(dailyStats));
  localStorage.setItem(LS_LAB_STATS, JSON.stringify(labStats));
}

function recordAttempt(passed) {
  const today = todayStr();
  if (!dailyStats[today]) dailyStats[today] = { total: 0, correct: 0 };
  dailyStats[today].total  += 1;
  if (passed) dailyStats[today].correct += 1;

  const labId = state.currentLabId;
  if (!labStats[labId]) labStats[labId] = { total: 0, correct: 0 };
  labStats[labId].total  += 1;
  if (passed) labStats[labId].correct += 1;

  saveDailyStats();

  // Celebrate when daily goal is exactly reached
  if (dailyStats[today].total === DAILY_GOAL) {
    setTimeout(() => addTutorMsg('🎉 Tagesziel erreicht! Alle 7 Kreise voll – super gemacht!', 'success'), 400);
  }
}

/* ══════════════════════════════════════════════════════════
   STATS PAGE
   ══════════════════════════════════════════════════════════ */
function openStats() {
  document.getElementById('main').classList.add('hidden');
  document.getElementById('stats-view').classList.remove('hidden');
  renderStatsPage();
}

function closeStats() {
  document.getElementById('stats-view').classList.add('hidden');
  document.getElementById('main').classList.remove('hidden');
}

function renderStatsPage() {
  const view = document.getElementById('stats-view');
  view.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className = 'stats-page-header';
  const back = document.createElement('button');
  back.className   = 'stats-back-btn';
  back.textContent = '← Zurück';
  back.addEventListener('click', closeStats);
  const ttl = document.createElement('h2');
  ttl.className   = 'stats-page-title';
  ttl.textContent = 'Statistik & Fortschritt';
  hdr.append(back, ttl);
  view.appendChild(hdr);

  view.appendChild(renderDailySection());
  view.appendChild(renderCalendarSection());
  view.appendChild(renderLabStatsSection());
}

function renderDailySection() {
  const today     = todayStr();
  const data      = dailyStats[today] || { total: 0, correct: 0 };
  const done      = Math.min(data.total, DAILY_GOAL);
  const pct       = done / DAILY_GOAL;
  const CIRC      = 2 * Math.PI * 36;
  const ringColor = pct >= 1 ? 'var(--sage)' : 'var(--accent)';

  const section = document.createElement('div');
  section.className = 'stats-section';
  section.innerHTML = `<div class="stats-section-title">Heute – Tagesziel ${done}/${DAILY_GOAL} Aufgaben</div>`;

  const body = document.createElement('div');
  body.className = 'daily-body';

  // Big ring
  const ringWrap = document.createElement('div');
  ringWrap.className = 'big-ring-wrap';
  ringWrap.innerHTML = `
    <svg class="big-ring" viewBox="0 0 88 88" width="88" height="88" aria-hidden="true">
      <circle cx="44" cy="44" r="36" stroke="var(--border)" stroke-width="7" fill="none"/>
      <circle cx="44" cy="44" r="36"
              stroke="${ringColor}" stroke-width="7" fill="none"
              stroke-linecap="round"
              stroke-dasharray="${CIRC.toFixed(1)}"
              stroke-dashoffset="${(CIRC * (1 - pct)).toFixed(1)}"
              transform="rotate(-90 44 44)"/>
    </svg>
    <div class="big-ring-label">${Math.round(pct * 100)}%</div>`;

  // 7 small circles
  const smallWrap = document.createElement('div');
  smallWrap.className = 'small-circles-col';
  smallWrap.innerHTML = '<div class="small-circles-label">Aufgaben heute</div>';
  const dots = document.createElement('div');
  dots.className = 'small-circles-row';
  for (let i = 0; i < DAILY_GOAL; i++) {
    const dot = document.createElement('div');
    dot.className = 'small-circle' + (i < done ? ' filled' : '');
    dot.title = i < done ? `Aufgabe ${i + 1} erledigt` : `Aufgabe ${i + 1}`;
    dots.appendChild(dot);
  }
  smallWrap.appendChild(dots);

  if (data.total > 0) {
    const acc = Math.round((data.correct / data.total) * 100);
    const accEl = document.createElement('div');
    accEl.className = 'daily-acc-text';
    accEl.textContent = `${data.correct} richtig · ${data.total - data.correct} falsch · ${acc}% Genauigkeit`;
    smallWrap.appendChild(accEl);
  } else {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'daily-acc-text muted';
    emptyEl.textContent = 'Noch keine Aufgabe heute gelöst. Los geht\'s!';
    smallWrap.appendChild(emptyEl);
  }

  body.append(ringWrap, smallWrap);
  section.appendChild(body);
  return section;
}

function renderCalendarSection() {
  const now    = new Date();
  const year   = now.getFullYear();
  const month  = now.getMonth();
  const MONTHS = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const DAYS   = ['Mo','Di','Mi','Do','Fr','Sa','So'];

  const section = document.createElement('div');
  section.className = 'stats-section';
  section.innerHTML = `<div class="stats-section-title">Kalender – ${MONTHS[month]} ${year}</div>`;

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';

  DAYS.forEach(d => {
    const el = document.createElement('div');
    el.className   = 'cal-day-label';
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDay   = new Date(year, month, 1).getDay();
  const startOff   = (firstDay + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayD     = todayStr();

  for (let i = 0; i < startOff; i++) grid.appendChild(document.createElement('div'));

  for (let d = 1; d <= daysInMonth; d++) {
    const mm   = String(month + 1).padStart(2, '0');
    const dd   = String(d).padStart(2, '0');
    const key  = `${year}-${mm}-${dd}`;
    const data = dailyStats[key];
    const tot  = data?.total || 0;
    const hit  = tot >= DAILY_GOAL;
    const any  = tot > 0;

    const cell = document.createElement('div');
    cell.className = 'cal-cell'
      + (key === todayD ? ' today' : '')
      + (hit ? ' goal-hit' : any ? ' partial' : '');
    cell.title = tot ? `${tot} Aufgaben` : '';

    const num = document.createElement('span');
    num.className   = 'cal-num';
    num.textContent = d;
    cell.appendChild(num);

    if (hit) {
      const ck = document.createElement('span');
      ck.className   = 'cal-check';
      ck.textContent = '✓';
      cell.appendChild(ck);
    } else if (any) {
      const dot = document.createElement('span');
      dot.className   = 'cal-dot';
      dot.textContent = tot;
      cell.appendChild(dot);
    }

    grid.appendChild(cell);
  }

  section.appendChild(grid);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'cal-legend';
  legend.innerHTML =
    '<span class="cal-legend-item goal-hit">✓ Tagesziel (≥7)</span>' +
    '<span class="cal-legend-item partial">Teilweise geübt</span>' +
    '<span class="cal-legend-item none">Nicht geübt</span>';
  section.appendChild(legend);

  return section;
}

function renderLabStatsSection() {
  const section = document.createElement('div');
  section.className = 'stats-section';
  section.innerHTML = '<div class="stats-section-title">Lab-Statistik</div>';

  const hasAny = LAB_CONFIG.some(lab => (labStats[lab.id]?.total || 0) > 0);

  if (!hasAny) {
    const empty = document.createElement('div');
    empty.className   = 'stats-empty';
    empty.textContent = 'Noch keine Aufgaben geübt. Starte ein Lab um hier deinen Fortschritt zu sehen!';
    section.appendChild(empty);
    return section;
  }

  const rows = document.createElement('div');
  rows.className = 'lab-stats-rows';

  LAB_CONFIG.forEach(lab => {
    const s = labStats[lab.id];
    if (!s || s.total === 0) return;

    const acc     = Math.round((s.correct / s.total) * 100);
    const fillCls = acc >= 70 ? 'good' : acc >= 40 ? 'warn' : 'bad';

    const row = document.createElement('div');
    row.className = 'lab-stat-row';
    row.innerHTML = `
      <span class="lab-stat-label">${escHtml(lab.label)}</span>
      <div class="lab-stat-track"><div class="lab-stat-fill ${fillCls}" style="width:${acc}%"></div></div>
      <span class="lab-stat-pct ${fillCls}">${acc}%</span>
      <span class="lab-stat-cnt">${s.correct}/${s.total}</span>`;
    rows.appendChild(row);
  });

  section.appendChild(rows);
  return section;
}

/* ══════════════════════════════════════════════════════════
   ADD LAB  – Änderung 1
   ══════════════════════════════════════════════════════════ */
function openAddLabModal() {
  document.getElementById('lab-text-input').value      = '';
  document.getElementById('lab-pdf-input').value       = '';
  document.getElementById('lab-pdf-name').textContent  = '';
  document.getElementById('add-lab-status').textContent = '';
  document.getElementById('add-lab-status').className   = 'api-key-status';
  document.getElementById('generate-lab-btn').disabled    = false;
  document.getElementById('generate-lab-btn').textContent = '⚡ Aufgaben generieren';
  switchAddLabTab('text');
  document.getElementById('add-lab-modal').classList.remove('hidden');
  document.getElementById('lab-text-input').focus();
}

function switchAddLabTab(tab) {
  document.querySelectorAll('.add-lab-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('add-lab-tab-text').classList.toggle('hidden', tab !== 'text');
  document.getElementById('add-lab-tab-pdf').classList.toggle('hidden', tab !== 'pdf');
}

function closeAddLabModal() {
  document.getElementById('add-lab-modal').classList.add('hidden');
}

async function generateLabFromText() {
  const labId    = document.getElementById('add-lab-number').value;
  const labLabel = LAB_CONFIG.find(l => l.id === labId)?.label || labId;
  const text     = document.getElementById('lab-text-input').value.trim();
  const status = document.getElementById('add-lab-status');
  const btn    = document.getElementById('generate-lab-btn');

  if (!text) {
    status.textContent = 'Bitte füge zuerst den Übungsblatt-Text ein.';
    status.className   = 'api-key-status err';
    return;
  }
  if (!state.apiKey) {
    status.textContent = 'Kein API Key – bitte zuerst in den Einstellungen (⚙️) eintragen.';
    status.className   = 'api-key-status err';
    return;
  }

  btn.disabled    = true;
  btn.textContent = '⏳ Generiere Aufgaben…';
  status.textContent = '⏳ Claude analysiert das Übungsblatt, das kann 20–40 Sekunden dauern…';
  status.className   = 'api-key-status';

  const prompt =
`Du bist Python-Dozent. Ich gebe dir den Rohtext eines Python-Übungsblatts. Erstelle daraus strukturierte Aufgaben als JSON-Array. Für jede Aufgabe: id (${labId}_01 etc.), title, description_de (klar auf Deutsch erklärt), function_name, parameters, starter_code, canonical_solution, tests (aus den Doctests als Array mit input und expected), variation_rules mit concept_variations (3 leichte Abwandlungen die das gleiche Konzept anders testen), hints (3 gestufte Tipps auf Deutsch von vage bis konkret), explanation (kurze Konzept-Erklärung für Anfänger), difficulty (easy/medium/hard), topics (Array), exam_relevance (high/medium/low). Antworte NUR mit einem JSON-Array, kein Text drum herum.

Übungsblatt:
${text}`;

  try {
    const response  = await callAPI(prompt, 4096);
    const exercises = parseJSON(response);

    if (!Array.isArray(exercises) || !exercises.length) {
      throw new Error(
        'Keine Aufgaben erkannt. Stelle sicher, dass der Text Funktionsdefinitionen mit Doctests enthält.'
      );
    }

    // Normalise IDs
    exercises.forEach((ex, i) => {
      ex.id = ex.id || `${labId}_${String(i + 1).padStart(2, '0')}`;
    });

    // Persist to localStorage
    localStorage.setItem(`pytutor_lab_${labId}`, JSON.stringify({ exercises }));

    // Mark lab button as available + active
    const labBtn = document.querySelector(`[data-lab-id="${labId}"]`);
    if (labBtn) {
      labBtn.classList.remove('unavailable');
      document.querySelectorAll('.lab-btn').forEach(b => b.classList.remove('active'));
      labBtn.classList.add('active');
    }

    closeAddLabModal();
    await loadLab(labId);
    addTutorMsg(
      `${labLabel} erfolgreich geladen! <strong>${exercises.length} Aufgaben</strong> importiert. 🎉`,
      'success'
    );
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.className   = 'api-key-status err';
    btn.disabled       = false;
    btn.textContent    = '⚡ Aufgaben generieren';
  }
}

/* ══════════════════════════════════════════════════════════
   PDF UPLOAD
   ══════════════════════════════════════════════════════════ */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function extractPdfText(base64) {
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const s   = document.createElement('script');
      s.src     = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const pdf   = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n\n';
  }
  return text.trim();
}

async function callAPIWithPDF(pdfBase64, prompt, maxTokens = 4096) {
  const key      = state.apiKey;
  const provider = state.apiProvider;
  let res, data;

  if (provider === 'openai') {
    const text = await extractPdfText(pdfBase64);
    if (!text) throw new Error('PDF-Text konnte nicht extrahiert werden – bitte Text-Tab verwenden.');
    return callAPI(prompt + '\n\nExtrahierter PDF-Text:\n' + text, maxTokens);
  }

  if (provider === 'google') {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
              { text: prompt },
            ],
          }],
        }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    data = await res.json();
    return data.candidates[0].content.parts.map(p => p.text || '').join('');
  }

  // Anthropic: native PDF document block
  res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  data = await res.json();
  return data.content.map(b => b.text || '').join('');
}

async function generateLabFromPDF() {
  const labId    = document.getElementById('add-lab-number').value;
  const labLabel = LAB_CONFIG.find(l => l.id === labId)?.label || labId;
  const fileInput = document.getElementById('lab-pdf-input');
  const status    = document.getElementById('add-lab-status');
  const btn       = document.getElementById('generate-lab-btn');

  if (!fileInput.files.length) {
    status.textContent = 'Bitte zuerst eine PDF-Datei auswählen.';
    status.className   = 'api-key-status err';
    return;
  }
  if (!state.apiKey) {
    status.textContent = 'Kein API Key – bitte zuerst in den Einstellungen (⚙️) eintragen.';
    status.className   = 'api-key-status err';
    return;
  }

  btn.disabled       = true;
  btn.textContent    = '⏳ Generiere Aufgaben…';
  status.textContent = '⏳ PDF wird analysiert, das kann 20–40 Sekunden dauern…';
  status.className   = 'api-key-status';

  const prompt =
`Du bist Python-Dozent. Ich gebe dir ein Python-Übungsblatt als PDF. Erstelle daraus strukturierte Aufgaben als JSON-Array. Für jede Aufgabe: id (${labId}_01 etc.), title, description_de (klar auf Deutsch erklärt), function_name, parameters, starter_code, canonical_solution, tests (aus den Doctests als Array mit input und expected), variation_rules mit concept_variations (3 leichte Abwandlungen die das gleiche Konzept anders testen), hints (3 gestufte Tipps auf Deutsch von vage bis konkret), explanation (kurze Konzept-Erklärung für Anfänger), difficulty (easy/medium/hard), topics (Array), exam_relevance (high/medium/low). Antworte NUR mit einem JSON-Array, kein Text drum herum.`;

  try {
    const pdfBase64 = await readFileAsBase64(fileInput.files[0]);
    const response  = await callAPIWithPDF(pdfBase64, prompt, 4096);
    const exercises = parseJSON(response);

    if (!Array.isArray(exercises) || !exercises.length) {
      throw new Error('Keine Aufgaben erkannt. Stelle sicher, dass das PDF Funktionsdefinitionen mit Doctests enthält.');
    }

    exercises.forEach((ex, i) => {
      ex.id = ex.id || `${labId}_${String(i + 1).padStart(2, '0')}`;
    });

    localStorage.setItem(`pytutor_lab_${labId}`, JSON.stringify({ exercises }));

    const labBtn = document.querySelector(`[data-lab-id="${labId}"]`);
    if (labBtn) {
      labBtn.classList.remove('unavailable');
      document.querySelectorAll('.lab-btn').forEach(b => b.classList.remove('active'));
      labBtn.classList.add('active');
    }

    closeAddLabModal();
    await loadLab(labId);
    addTutorMsg(
      `${labLabel} erfolgreich aus PDF geladen! <strong>${exercises.length} Aufgaben</strong> importiert. 🎉`,
      'success'
    );
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.className   = 'api-key-status err';
    btn.disabled       = false;
    btn.textContent    = '⚡ Aufgaben generieren';
  }
}

/* ══════════════════════════════════════════════════════════
   AI API  (Anthropic · OpenAI · Google Gemini)
   ══════════════════════════════════════════════════════════ */
async function callAPI(prompt, maxTokens = 1000, fastMode = false) {
  const key      = state.apiKey;
  const provider = state.apiProvider;
  let res, data;

  if (provider === 'openai') {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model:      fastMode ? 'gpt-4o-mini' : 'gpt-4o',
        max_tokens: maxTokens,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    data = await res.json();
    return data.choices[0].message.content;

  } else if (provider === 'google') {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    data = await res.json();
    return data.candidates[0].content.parts.map(p => p.text || '').join('');

  } else {
    // Anthropic (default)
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-key':     key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model:      fastMode ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }
    data = await res.json();
    return data.content.map(b => b.text || '').join('');
  }
}

function parseJSON(text) {
  try {
    const cleaned = text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    const start = cleaned.search(/[{[]/);
    if (start === -1) throw new Error('No JSON');
    return JSON.parse(cleaned.slice(start));
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════
   TUTOR MESSAGES
   ══════════════════════════════════════════════════════════ */
const LABELS = {
  success: '✓ Erfolg',
  error:   '✗ Fehler',
  explain: '🔍 Erklärung',
  hint:    '💡 Tipp',
  info:    '🤖 Tutor',
  loading: '🤖 Tutor',
};

function addTutorMsg(html, type = 'info') {
  const wrap = document.getElementById('tutor-messages');
  const msg  = document.createElement('div');
  msg.className = `tutor-msg ${type}`;
  msg.innerHTML = `<div class="msg-label">${LABELS[type] || '🤖'}</div>${html}`;
  wrap.appendChild(msg);
  wrap.scrollTop = wrap.scrollHeight;
  return msg;
}

function addLoadingBubble() {
  const id  = 'loading-' + Date.now();
  const msg = addTutorMsg(
    '<div class="typing-dots"><span></span><span></span><span></span></div>',
    'loading'
  );
  msg.id = id;
  return id;
}

function removeLoadingBubble(id) {
  document.getElementById(id)?.remove();
}

/* ══════════════════════════════════════════════════════════
   CONSOLE HELPERS
   ══════════════════════════════════════════════════════════ */
function clearTutorMessages() {
  document.getElementById('tutor-messages').innerHTML = '';
}

function clearConsole() {
  document.getElementById('console-output').innerHTML =
    '<span class="console-placeholder">Klick auf ▶ Ausführen um deinen Code zu testen.</span>';
}

/* ══════════════════════════════════════════════════════════
   UI HELPERS
   ══════════════════════════════════════════════════════════ */
function updateStreakDisplay() {
  document.getElementById('streak-count').textContent = state.progress.streak;
  document.getElementById('score-count').textContent  = state.progress.total_score;
}

function showNextButton() {
  document.getElementById('next-btn').classList.remove('hidden');
}

function hideNextButton() {
  document.getElementById('next-btn').classList.add('hidden');
}

function setRunLoading(on) {
  const btn = document.getElementById('run-btn');
  btn.disabled    = on;
  btn.textContent = on ? '⏳ Läuft…' : '▶ Ausführen';
}

function mkEl(tag, cls, text) {
  const el = document.createElement(tag);
  el.className   = cls;
  el.textContent = text;
  return el;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════════
   SETTINGS MODAL
   ══════════════════════════════════════════════════════════ */
const PROVIDER_PLACEHOLDERS = {
  anthropic: 'sk-ant-api03-…',
  openai:    'sk-…',
  google:    'AIza…',
};

function openSettings() {
  document.getElementById('api-provider-select').value = state.apiProvider;
  document.getElementById('api-key-input').value        = state.apiKey;
  document.getElementById('api-key-input').placeholder  = PROVIDER_PLACEHOLDERS[state.apiProvider] || '';
  document.getElementById('api-key-status').textContent = '';
  document.getElementById('api-key-status').className   = 'api-key-status';
  document.getElementById('settings-modal').classList.remove('hidden');

  document.getElementById('api-provider-select').onchange = function () {
    document.getElementById('api-key-input').placeholder = PROVIDER_PLACEHOLDERS[this.value] || '';
  };
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════
   EXAM UPLOAD MODAL
   ══════════════════════════════════════════════════════════ */
function openExamUploadModal() {
  document.getElementById('exam-text-input').value      = '';
  document.getElementById('exam-pdf-input').value       = '';
  document.getElementById('exam-pdf-name').textContent  = '';
  document.getElementById('exam-upload-status').textContent = '';
  document.getElementById('exam-upload-status').className   = 'api-key-status';
  document.getElementById('generate-exam-btn').disabled    = false;
  document.getElementById('generate-exam-btn').textContent = '⚡ Aufgaben generieren';
  switchExamUploadTab('text');
  document.getElementById('exam-upload-modal').classList.remove('hidden');
  document.getElementById('exam-text-input').focus();
}

function closeExamUploadModal() {
  document.getElementById('exam-upload-modal').classList.add('hidden');
}

function switchExamUploadTab(tab) {
  document.querySelectorAll('.exam-upload-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('exam-upload-tab-text').classList.toggle('hidden', tab !== 'text');
  document.getElementById('exam-upload-tab-pdf').classList.toggle('hidden', tab !== 'pdf');
}

const EXAM_PROMPT =
`Du bist Python-Dozent. Ich gebe dir eine alte Python-Prüfung. Erstelle daraus strukturierte Aufgaben als JSON-Array. Für jede Aufgabe: id (exam_01 etc.), title, description_de (klar auf Deutsch erklärt), function_name, parameters, starter_code, canonical_solution, tests (aus den Doctests als Array mit input und expected), variation_rules mit concept_variations (3 leichte Abwandlungen), hints (3 gestufte Tipps auf Deutsch), explanation (kurze Konzept-Erklärung für Anfänger), difficulty (easy/medium/hard), topics (Array), exam_relevance ("high"), source ("exam"). Antworte NUR mit einem JSON-Array, kein Text drum herum.`;

async function generateExamFromText() {
  const text   = document.getElementById('exam-text-input').value.trim();
  const status = document.getElementById('exam-upload-status');
  const btn    = document.getElementById('generate-exam-btn');

  if (!text) {
    status.textContent = 'Bitte füge zuerst den Prüfungstext ein.';
    status.className   = 'api-key-status err';
    return;
  }
  if (!state.apiKey) {
    status.textContent = 'Kein API Key – bitte zuerst in den Einstellungen (⚙️) eintragen.';
    status.className   = 'api-key-status err';
    return;
  }

  btn.disabled       = true;
  btn.textContent    = '⏳ Generiere Aufgaben…';
  status.textContent = '⏳ Prüfung wird analysiert, das kann 20–40 Sekunden dauern…';
  status.className   = 'api-key-status';

  try {
    const response  = await callAPI(EXAM_PROMPT + '\n\nPrüfungstext:\n' + text, 4096);
    await _saveExamQuestions(response);
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.className   = 'api-key-status err';
    btn.disabled       = false;
    btn.textContent    = '⚡ Aufgaben generieren';
  }
}

async function generateExamFromPDF() {
  const fileInput = document.getElementById('exam-pdf-input');
  const status    = document.getElementById('exam-upload-status');
  const btn       = document.getElementById('generate-exam-btn');

  if (!fileInput.files.length) {
    status.textContent = 'Bitte zuerst eine PDF-Datei auswählen.';
    status.className   = 'api-key-status err';
    return;
  }
  if (!state.apiKey) {
    status.textContent = 'Kein API Key – bitte zuerst in den Einstellungen (⚙️) eintragen.';
    status.className   = 'api-key-status err';
    return;
  }

  btn.disabled       = true;
  btn.textContent    = '⏳ Generiere Aufgaben…';
  status.textContent = '⏳ PDF wird analysiert, das kann 20–40 Sekunden dauern…';
  status.className   = 'api-key-status';

  try {
    const pdfBase64 = await readFileAsBase64(fileInput.files[0]);
    const response  = await callAPIWithPDF(pdfBase64, EXAM_PROMPT, 4096);
    await _saveExamQuestions(response);
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.className   = 'api-key-status err';
    btn.disabled       = false;
    btn.textContent    = '⚡ Aufgaben generieren';
  }
}

async function _saveExamQuestions(response) {
  const exercises = parseJSON(response);

  if (!Array.isArray(exercises) || !exercises.length) {
    throw new Error('Keine Aufgaben erkannt. Stelle sicher, dass der Text Funktionsdefinitionen mit Doctests enthält.');
  }

  exercises.forEach((ex, i) => {
    ex.id             = ex.id             || `exam_${String(i + 1).padStart(2, '0')}`;
    ex.exam_relevance = 'high';
    ex.source         = 'exam';
  });

  // Merge with existing exam questions (deduplicate by id)
  let existing = [];
  try { existing = JSON.parse(localStorage.getItem('exam_questions') || '[]'); } catch { /* */ }
  const existingIds = new Set(existing.map(e => e.id));
  const merged = [...existing, ...exercises.filter(e => !existingIds.has(e.id))];
  localStorage.setItem('exam_questions', JSON.stringify(merged));

  closeExamUploadModal();
  addTutorMsg(
    `${exercises.length} Prüfungsaufgaben importiert und gespeichert! 🎉 Sie stehen im Prüfungsmodus zur Verfügung.`,
    'success'
  );
}

/* ══════════════════════════════════════════════════════════
   EVENT BINDING
   ══════════════════════════════════════════════════════════ */
function bindEvents() {
  // ── Editor keyboard ──
  const editor = document.getElementById('code-editor');

  editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s   = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + '    ' + editor.value.slice(end);
      editor.selectionStart = editor.selectionEnd = s + 4;
      syncLineNumbers();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runCode();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      explainCode();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      showNextHint();
    }
  });

  editor.addEventListener('input', syncLineNumbers);
  editor.addEventListener('scroll', () => {
    document.getElementById('line-numbers').scrollTop = editor.scrollTop;
  });

  // ── Global keyboard ──
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && exam.active) {
      stopExamMode();
      addTutorMsg('Prüfungsmodus beendet.', 'info');
    }
  });

  // ── Buttons ──
  document.getElementById('run-btn')
    .addEventListener('click', runCode);

  document.getElementById('explain-btn')
    .addEventListener('click', explainCode);

  document.getElementById('solution-btn')
    .addEventListener('click', showSolution);

  document.getElementById('hint-btn')
    .addEventListener('click', showNextHint);

  // ── Mobile Tab button ──
  document.getElementById('tab-btn')
    .addEventListener('click', () => {
      const s = editor.selectionStart;
      const e2 = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + '    ' + editor.value.slice(e2);
      editor.selectionStart = editor.selectionEnd = s + 4;
      editor.focus();
      syncLineNumbers();
    });

  // ── Mobile char buttons ──
  document.querySelectorAll('.btn-char').forEach(btn => {
    btn.addEventListener('click', () => {
      const ch = btn.dataset.insert;
      const s  = editor.selectionStart;
      const e2 = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + ch + editor.value.slice(e2);
      editor.selectionStart = editor.selectionEnd = s + ch.length;
      editor.focus();
      syncLineNumbers();
    });
  });

  document.getElementById('reset-btn')
    .addEventListener('click', () => {
      if (state.currentEx) setEditorCode(state.currentEx.starter_code);
      clearConsole();
    });

  document.getElementById('next-btn')
    .addEventListener('click', () => {
      if (state.pendingSuccess) {
        recordAttempt(true);
        state.pendingSuccess = false;
      }
      hideNextButton();
      selectNextExercise();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

  document.getElementById('skip-btn')
    .addEventListener('click', () => {
      state.pendingSuccess = false;
      hideNextButton();
      selectNextExercise();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

  document.getElementById('clear-console-btn')
    .addEventListener('click', clearConsole);

  // ── Exam mode ──
  document.getElementById('exam-btn')
    .addEventListener('click', () => {
      if (exam.active) {
        stopExamMode();
        addTutorMsg('Prüfungsmodus beendet.', 'info');
      } else {
        startExamMode();
      }
    });

  document.getElementById('exam-exit-btn')
    .addEventListener('click', () => {
      stopExamMode();
      addTutorMsg('Prüfungsmodus beendet.', 'info');
    });

  // ── Progress Dashboard toggle ──
  document.getElementById('progress-toggle')
    .addEventListener('click', toggleProgressDashboard);

  // ── Exam Upload modal ──
  document.getElementById('exam-upload-btn')
    .addEventListener('click', openExamUploadModal);

  document.getElementById('close-exam-upload-btn')
    .addEventListener('click', closeExamUploadModal);

  document.getElementById('cancel-exam-upload-btn')
    .addEventListener('click', closeExamUploadModal);

  document.getElementById('exam-upload-modal')
    .addEventListener('click', e => {
      if (e.target === document.getElementById('exam-upload-modal')) closeExamUploadModal();
    });

  document.getElementById('generate-exam-btn')
    .addEventListener('click', () => {
      const activeTab = document.querySelector('.exam-upload-tab.active')?.dataset.tab;
      if (activeTab === 'pdf') generateExamFromPDF();
      else generateExamFromText();
    });

  document.querySelectorAll('.exam-upload-tab').forEach(btn => {
    btn.addEventListener('click', () => switchExamUploadTab(btn.dataset.tab));
  });

  document.getElementById('exam-pdf-input')
    .addEventListener('change', e => {
      const file = e.target.files[0];
      document.getElementById('exam-pdf-name').textContent = file ? file.name : '';
    });

  // ── Add Lab modal (Änderung 1) ──
  document.getElementById('add-lab-btn')
    .addEventListener('click', openAddLabModal);

  document.getElementById('close-add-lab-btn')
    .addEventListener('click', closeAddLabModal);

  document.getElementById('cancel-add-lab-btn')
    .addEventListener('click', closeAddLabModal);

  document.getElementById('add-lab-modal')
    .addEventListener('click', e => {
      if (e.target === document.getElementById('add-lab-modal')) closeAddLabModal();
    });

  document.getElementById('generate-lab-btn')
    .addEventListener('click', () => {
      const activeTab = document.querySelector('.add-lab-tab.active')?.dataset.tab;
      if (activeTab === 'pdf') generateLabFromPDF();
      else generateLabFromText();
    });

  document.querySelectorAll('.add-lab-tab').forEach(btn => {
    btn.addEventListener('click', () => switchAddLabTab(btn.dataset.tab));
  });

  document.getElementById('lab-pdf-input')
    .addEventListener('change', e => {
      const file = e.target.files[0];
      document.getElementById('lab-pdf-name').textContent = file ? file.name : '';
    });

  // Allow Ctrl+Enter inside the textarea to trigger generation
  document.getElementById('lab-text-input')
    .addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        generateLabFromText();
      }
    });

  // ── Stats page ──
  document.getElementById('stats-btn')
    .addEventListener('click', openStats);

  // ── Settings ──
  document.getElementById('settings-btn')
    .addEventListener('click', openSettings);

  document.getElementById('api-status-btn')
    .addEventListener('click', openSettings);

  document.getElementById('close-settings-btn')
    .addEventListener('click', closeSettings);

  document.getElementById('settings-modal')
    .addEventListener('click', e => {
      if (e.target === document.getElementById('settings-modal')) closeSettings();
    });

  document.getElementById('save-settings-btn')
    .addEventListener('click', () => {
      const key      = document.getElementById('api-key-input').value.trim();
      const provider = document.getElementById('api-provider-select').value;
      const status   = document.getElementById('api-key-status');
      saveApiKey(key, provider);
      status.textContent = key ? '✓ Gespeichert!' : 'Key entfernt.';
      status.className   = 'api-key-status ' + (key ? 'ok' : 'err');
      setTimeout(closeSettings, 700);
    });

  document.getElementById('test-api-btn')
    .addEventListener('click', async () => {
      const key      = document.getElementById('api-key-input').value.trim();
      const provider = document.getElementById('api-provider-select').value;
      const status   = document.getElementById('api-key-status');

      if (!key) {
        status.textContent = 'Bitte erst einen Key eingeben.';
        status.className   = 'api-key-status err';
        return;
      }

      status.textContent = '⏳ Teste Verbindung…';
      status.className   = 'api-key-status';

      try {
        let res;
        if (provider === 'anthropic') {
          res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] }),
          });
        } else if (provider === 'openai') {
          res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] }),
          });
        } else {
          res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] }),
          });
        }
        if (res.ok) {
          status.textContent = '✓ API Key ist gültig!';
          status.className   = 'api-key-status ok';
        } else {
          const err = await res.json().catch(() => ({}));
          status.textContent = '✗ ' + (err.error?.message || `Fehler ${res.status}`);
          status.className   = 'api-key-status err';
        }
      } catch (e) {
        status.textContent = '✗ Netzwerkfehler: ' + e.message;
        status.className   = 'api-key-status err';
      }
    });
}
