const $ = (id) => document.getElementById(id);

/* ---------- Контекст із URL: ?path=&mode=&results= або ?save=N ----------
   path     — шлях до JSON з тестом (відносний до сторінки або повний URL)
   mode     — default (за замовчуванням) | error-correction (потребує results)
   results  — шлях до JSON із раніше збереженими результатами
   save     — номер сейву; якщо є, прогрес зберігається саме в ньому, а path/mode/results лише запускають порожній сейв
   Кожен контекст має власний ключ у localStorage, тому різні посилання не заважають одне одному. */
const NS = 'jq2:';
const LEGACY_KEY = 'json_quiz_v1';   // старий єдиний ключ (переноситься при ручному завантаженні)
const SAVES_KEY = NS + 'saves';      // список кнопок-сейвів: { next, items: [{ id, name }] }

function absUrl(p) {
  try { return new URL(p, location.href).href; } catch (e) { return p; }
}

const ctx = (() => {
  const q = new URLSearchParams(location.search);
  const rawSave = q.get('save');
  const save = rawSave !== null && /^\d+$/.test(rawSave.trim()) ? Number(rawSave.trim()) : null;
  const path = (q.get('path') || '').trim();
  const mode = (q.get('mode') || 'default').trim();
  const results = (q.get('results') || '').trim();
  let error = '';
  if (rawSave !== null && save === null) error = 'Параметр save має бути цілим числом, наприклад ?save=1.';
  else if (mode !== 'default' && mode !== 'error-correction') error = 'Параметр mode має бути default або error-correction.';
  else if (!path && (q.has('mode') || results)) error = 'Параметри mode і results працюють лише разом із path.';
  else if (mode === 'error-correction' && !results) error = 'mode=error-correction потребує параметра results.';

  /* Ключ залежить від того, що саме вказано: save, або path+mode+results (повні адреси), або ручне завантаження */
  let key;
  if (save !== null) key = 'save:' + save;
  else if (path) key = 'url:' + JSON.stringify([absUrl(path), mode, results ? absUrl(results) : '']);
  else key = 'manual';
  return { save, path, mode, results, error, key };
})();

/* ---------- Сховище (localStorage) ---------- */
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };

const stateKey = () => NS + ctx.key;
const metaKey = (id) => NS + 'meta:' + id;

/* Коротка довідка про сейв (для списку на початковому екрані), щоб не розбирати весь стан із зображеннями */
function writeMeta() {
  if (ctx.save === null) return;
  const answered = state.questions.filter((q, i) => handlers[q.type].isAnswered(q, state.answers[i])).length;
  lsSet(metaKey(ctx.save), JSON.stringify({ total: state.questions.length, answered, finished: !!state.finished, fileName: state.fileName || '', updated: Date.now() }));
}

function saveState() {
  timerSync();
  const ok = lsSet(stateKey(), JSON.stringify(state));
  /* Найчастіше — переповнена пам'ять браузера (великі зображення). Старий зліпок прибираємо, щоб він не підмінив поточний тест */
  if (!ok) lsDel(stateKey());
  else writeMeta();
  const warn = $('save-warning');
  if (warn) warn.hidden = ok;
}
function loadState() {
  let raw = lsGet(stateKey());
  if (!raw && ctx.key === 'manual') raw = lsGet(LEGACY_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
/* Стирає лише поточну частину сховища (цей сейв / це посилання) */
function clearState() {
  lsDel(stateKey());
  if (ctx.save !== null) lsDel(metaKey(ctx.save));
  if (ctx.key === 'manual') lsDel(LEGACY_KEY);
}
const scopeText = () =>
  ctx.save !== null ? `сейву №${ctx.save}` : ctx.key === 'manual' ? 'ручного завантаження' : 'цього посилання';

/* ---------- Кнопки-сейви: посилання ?save=N ---------- */
function readSaves() {
  try {
    const s = JSON.parse(lsGet(SAVES_KEY));
    if (isObj(s) && Array.isArray(s.items)) {
      return {
        next: Number.isInteger(s.next) && s.next > 0 ? s.next : 1,
        items: s.items.filter((x) => isObj(x) && Number.isInteger(x.id) && x.id >= 0 && typeof x.name === 'string')
      };
    }
  } catch (e) {}
  return { next: 1, items: [] };
}
function writeSaves(s) { lsSet(SAVES_KEY, JSON.stringify(s)); }
function readMeta(id) {
  try { const m = JSON.parse(lsGet(metaKey(id))); return isObj(m) ? m : null; } catch (e) { return null; }
}
/* Новий номер ніколи не збігається з уже наявними даними, навіть якщо кнопку-сейв видалено */
function nextSaveId(s) {
  let max = -1;
  s.items.forEach((x) => { max = Math.max(max, x.id); });
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const m = k && k.startsWith(NS) ? /^(?:save|meta):(\d+)$/.exec(k.slice(NS.length)) : null;
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch (e) {}
  return Math.max(s.next, max + 1);
}
function createSave(name) {
  const s = readSaves();
  const id = nextSaveId(s);
  s.items.push({ id, name: name.trim() || `Сейв ${id}` });
  s.next = id + 1;
  writeSaves(s);
  return id;
}
const saveUrl = (id) => new URL('?save=' + id, location.href).href;

/* ---------- Псевдоніми типів (альтернативні назви в JSON) ---------- */
const TYPE_ALIASES = {
  'multiple-choices': 'multiple-choice',
  'match-choices': 'matching-question',
  'matching': 'matching-question'
};

/* ---------- Допоміжні функції ---------- */
const NONE = '(без відповіді)';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const opt = (q, k) => `${k} "${q.choices[k]}"`;
const mt = (q, mk) => `${mk} "${q.matches[mk]}"`;
const nonEmptyObj = (v) => isObj(v) && Object.keys(v).length > 0;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function choiceButton(key, text, selected, onClick) {
  const btn = el('button', 'choice' + (selected ? ' selected' : ''));
  btn.append(el('b', null, key), el('span', null, text));
  btn.onclick = onClick;
  return btn;
}
function sortByChoices(q, keys) {
  const order = Object.keys(q.choices);
  return [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
const multiRange = (q) => ({ min: q.min ?? 1, max: q.max ?? 3 });

/* Послідовність: відповідь — масив, де індекс = позиція, а null = вільна позиція. Хвостові null відкидаємо */
function trimSeq(arr) {
  const r = [...arr];
  while (r.length && (r[r.length - 1] === null || r[r.length - 1] === undefined)) r.pop();
  return r;
}
/* Латинські літери, схожі на кириличні, щоб "A" і "А" не різнилися при ручному введенні */
const LOOKALIKE = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const canon = (str) => String(str).toLowerCase().replace(/[a-z]/g, (ch) => LOOKALIKE[ch] || ch);
function resolveKey(q, token) {
  if (has(q.choices, token)) return token;
  const want = canon(token);
  const hits = Object.keys(q.choices).filter((k) => canon(k) === want);
  return hits.length === 1 ? hits[0] : null;
}
/* "2 1 3", "2, 1, 3", "2 → 1 → 3", "2 - 1" (прочерк = вільна позиція) */
function parseOrder(q, text) {
  const tokens = text.replace(/->|=>|→|>/g, ' ').split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return { arr: [] };
  const n = Object.keys(q.choices).length;
  if (tokens.length > n) return { error: `Забагато пунктів: у питанні їх лише ${n}.` };
  const arr = [];
  const seen = new Set();
  for (const tok of tokens) {
    if (/^[-–—_.?]+$/.test(tok)) { arr.push(null); continue; }
    const k = resolveKey(q, tok);
    if (k === null) return { error: `Невідомий пункт "${tok}".` };
    if (seen.has(k)) return { error: `Пункт "${k}" вказано двічі.` };
    seen.add(k);
    arr.push(k);
  }
  return { arr: trimSeq(arr) };
}

/* Підпис відповіді для порівняння (порожні відповіді вважаються однаковими) */
function sig(a) {
  if (a === undefined || a === null) return 'null';
  if (Array.isArray(a)) return a.length ? JSON.stringify(a) : 'null';
  if (isObj(a)) {
    const keys = Object.keys(a).sort();
    return keys.length ? JSON.stringify(keys.map((k) => [k, a[k]])) : 'null';
  }
  return JSON.stringify(a);
}
function sameAnswer(q, a, b) {
  const norm = (x) => (q.type === 'multiple-choice' && Array.isArray(x) ? [...x].sort() : x);
  return sig(norm(a)) === sig(norm(b));
}

/* ---------- Підсвітка в режимі роботи над помилками ---------- */
function tagEl(cls, text) { return el('span', 'tag ' + cls, text); }

/* f = { correct, old, now }: чи правильний варіант, чи був обраний раніше, чи обраний зараз.
   reveal=false — правильність не показується: лише нейтральна «стара» і бурштинова «нова» відповідь */
function markChoice(btn, f, reveal) {
  const tags = el('span', 'tags');
  if (reveal) {
    /* зелений — правильний варіант; червоний — неправильний, який обрано зараз або був обраний раніше */
    if (f.correct) btn.classList.add('rv-ok');
    else if (f.old || f.now) btn.classList.add('rv-bad');
    if (f.correct) tags.append(tagEl('ok', '✓ правильно'));
  } else if (f.old) {
    btn.classList.add('rv-old');
  }
  if (f.now && !f.old) btn.classList.add('rv-new');

  const oldCls = !reveal ? 'neutral' : f.correct ? 'ok' : 'bad';
  if (f.old && f.now) tags.append(tagEl(oldCls, 'твоя'));
  else if (f.old) tags.append(tagEl(oldCls, 'стара'));
  else if (f.now) tags.append(tagEl('new', 'нова'));
  if (tags.children.length) btn.append(tags);
}

/* Перевірка відповіді у звичайному режимі: правильний — зелений, ваш неправильний — червоний */
function markCheck(btn, f) {
  const tags = el('span', 'tags');
  if (f.correct) {
    btn.classList.add('rv-ok');
    tags.append(tagEl('ok', '✓ правильно'));
  } else if (f.now) {
    btn.classList.add('rv-bad');
    tags.append(tagEl('bad', '✗ неправильно'));
  }
  /* Ваш вибір — оранжева обводка і мітка «твоя» (як у режимі помилок, але без «старої» відповіді) */
  if (f.now) {
    btn.classList.add('rv-new');
    tags.append(tagEl('new', 'твоя'));
  }
  if (tags.children.length) btn.append(tags);
}

/* Коротка відповідь: порівняння без урахування зайвих пробілів, коми/крапки в десяткових числах і (за замовчуванням) регістру.
   Числа порівнюються за значенням: "3.50" = "3,5" = "3.5" */
const SA_NUM_RE = /^[+-]?\d+(\.\d+)?$/;
const saVariants = (q) => (Array.isArray(q.correct) ? q.correct : [q.correct]).map((v) => String(v).trim());
function saNorm(q, s) {
  const t = String(s).trim().replace(/\s+/g, ' ').replace(/\u2212/g, '-').replace(/(\d),(\d)/g, '$1.$2');
  return q['case-sensitive'] === true ? t : t.toLowerCase();
}
function saSame(q, a, b) {
  const x = saNorm(q, a);
  const y = saNorm(q, b);
  return x === y || (SA_NUM_RE.test(x) && SA_NUM_RE.test(y) && Number(x) === Number(y));
}
const saText = (a) => {
  if (Array.isArray(a)) return a.map((v) => String(v).trim()).join(' / ');
  return (typeof a === 'string' || typeof a === 'number') && String(a).trim() !== '' ? String(a).trim() : NONE;
};

/* ---------- Обробники типів питань ----------
   Кожен тип має: validate(q) -> null | текст помилки,
   render(q, answer, container, onAnswer, rv, chk) — rv = { old, reveal } у режимі помилок, інакше null;
   chk = true, коли відповідь на питання показано (звичайний режим),
   isAnswered(q, a), isCorrect(q, a),
   text(q, a) -> текст самої відповіді (без ✅/❌), працює і для q.correct,
   short(q, a) -> стисла відповідь для копіювання («А», «А, В», «А-2, Б-1», «2 → 1 → 3»), «-» якщо відповіді немає,
   format(q, a) -> рядок для результатів */
const handlers = {

  /* Один варіант: choices + correct: "A" */
  'single-choice': {
    validate(q) {
      if (!nonEmptyObj(q.choices)) return 'потрібне поле "choices" (об\'єкт).';
      if (typeof q.correct !== 'string' || !has(q.choices, q.correct))
        return '"correct" має бути ключем з "choices".';
      return null;
    },
    render(q, answer, box, onAnswer, rv, chk) {
      box.innerHTML = '';
      Object.entries(q.choices).forEach(([k, t]) => {
        const btn = choiceButton(k, t, answer === k, () => onAnswer(k));
        if (rv) markChoice(btn, { correct: k === q.correct, old: rv.old === k, now: answer === k }, rv.reveal);
        else if (chk) markCheck(btn, { correct: k === q.correct, now: answer === k });
        box.appendChild(btn);
      });
    },
    isAnswered: (q, a) => typeof a === 'string',
    isCorrect: (q, a) => a === q.correct,
    text: (q, a) => (typeof a === 'string' && has(q.choices, a) ? opt(q, a) : NONE),
    short: (q, a) => (typeof a === 'string' && has(q.choices, a) ? a : '-'),
    format(q, a) {
      const right = opt(q, q.correct);
      if (a === q.correct) return `${right} ✅`;
      const mine = typeof a === 'string' && has(q.choices, a) ? opt(q, a) : NONE;
      return `${mine} ❌ - ${right}`;
    }
  },

  /* Кілька варіантів: choices + correct: ["A","C"] + необов'язкові min (1) / max (3) */
  'multiple-choice': {
    validate(q) {
      if (!nonEmptyObj(q.choices)) return 'потрібне поле "choices" (об\'єкт).';
      const { min, max } = multiRange(q);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min)
        return '"min" і "max" мають бути цілими числами, 1 ≤ min ≤ max.';
      if (!Array.isArray(q.correct) || !q.correct.length)
        return '"correct" має бути непорожнім списком ключів, наприклад ["A", "C"].';
      if (q.correct.some((k) => !has(q.choices, k)) || new Set(q.correct).size !== q.correct.length)
        return '"correct" містить неіснуючі або повторювані ключі.';
      if (q.correct.length < min || q.correct.length > max)
        return `правильних відповідей ${q.correct.length}, а дозволено від ${min} до ${max} — вкажіть "min"/"max" явно.`;
      return null;
    },
    render(q, answer, box, onAnswer, rv, chk) {
      const { min, max } = multiRange(q);
      const sel = Array.isArray(answer) ? answer : [];
      const oldSel = rv && Array.isArray(rv.old) ? rv.old : [];
      box.innerHTML = '';
      box.appendChild(el('p', 'hint',
        (min === max ? `Оберіть ${min}` : `Оберіть від ${min} до ${max} варіантів`) +
        ` (обрано: ${sel.length})`));
      Object.entries(q.choices).forEach(([k, t]) => {
        const on = sel.includes(k);
        const btn = choiceButton(k, t, on, () => onAnswer(on ? sel.filter((x) => x !== k) : [...sel, k]));
        if (!on && sel.length >= max) btn.disabled = true;
        if (rv) markChoice(btn, { correct: q.correct.includes(k), old: oldSel.includes(k), now: on }, rv.reveal);
        else if (chk) markCheck(btn, { correct: q.correct.includes(k), now: on });
        box.appendChild(btn);
      });
    },
    isAnswered: (q, a) => Array.isArray(a) && a.length >= multiRange(q).min,
    isCorrect: (q, a) =>
      Array.isArray(a) && a.length === q.correct.length && q.correct.every((k) => a.includes(k)),
    text(q, a) {
      const keys = Array.isArray(a) ? a.filter((k) => has(q.choices, k)) : [];
      return keys.length ? sortByChoices(q, keys).map((k) => opt(q, k)).join(', ') : NONE;
    },
    short(q, a) {
      const keys = Array.isArray(a) ? a.filter((k) => has(q.choices, k)) : [];
      return keys.length ? sortByChoices(q, keys).join(', ') : '-';
    },
    format(q, a) {
      const list = (keys) => sortByChoices(q, keys).map((k) => opt(q, k)).join(', ');
      const right = list(q.correct);
      if (this.isCorrect(q, a)) return `${right} ✅`;
      const mine = Array.isArray(a) && a.length ? list(a.filter((k) => has(q.choices, k))) : NONE;
      return `${mine} ❌ - ${right}`;
    }
  },

  /* Відповідності: choices (ліва колонка), matches (права), correct: {"A": "2", "B": "1"} */
  'matching-question': {
    validate(q) {
      if (!nonEmptyObj(q.choices)) return '"choices" має бути непорожнім об\'єктом (ліва колонка).';
      if (!nonEmptyObj(q.matches)) return '"matches" має бути непорожнім об\'єктом (права колонка).';
      if (!isObj(q.correct)) return '"correct" має бути об\'єктом виду {"A": "1", "B": "2"}.';
      for (const k of Object.keys(q.choices)) {
        if (!has(q.correct, k) || !has(q.matches, String(q.correct[k])))
          return `для "${k}" у "correct" немає коректного ключа з "matches".`;
      }
      return null;
    },
    render(q, answer, box, onAnswer, rv, chk) {
      const ans = isObj(answer) ? answer : {};
      const oldAns = rv && isObj(rv.old) ? rv.old : {};
      box.innerHTML = '';
      box.appendChild(el('p', 'hint', 'Підберіть до кожного пункту відповідну пару.'));
      Object.entries(q.choices).forEach(([k, t]) => {
        const row = el('div', 'match-row');
        const label = el('div', 'match-label');
        label.append(el('b', null, k), el('span', null, t));
        const select = document.createElement('select');
        select.add(new Option('— обрати —', ''));
        Object.entries(q.matches).forEach(([mk, mtxt]) => select.add(new Option(`${mk}. ${mtxt}`, mk)));
        select.value = has(ans, k) ? ans[k] : '';
        select.onchange = () => {
          const next = { ...ans };
          if (select.value === '') delete next[k]; else next[k] = select.value;
          onAnswer(next);
        };
        row.append(label, select);

        if (rv) {
          const right = String(q.correct[k]);
          const oldV = has(oldAns, k) ? String(oldAns[k]) : '';
          const nowV = has(ans, k) ? String(ans[k]) : '';
          const show = (v) => (v && has(q.matches, v) ? mt(q, v) : NONE);
          const changed = nowV !== oldV;
          const notes = el('div', 'rv-notes');
          if (rv.reveal) {
            /* Колір рядка — за поточною відповіддю: виправили на правильну → зелений, ні → червоний */
            const nowOk = nowV === right;
            if (nowOk) row.classList.add('rv-ok');
            else if (nowV) row.classList.add('rv-bad');
            notes.append(el('div', 'ok', `Правильно: ${show(right)}`));
            if (changed) {
              notes.append(el('div', oldV === right ? 'ok' : 'bad', `Стара відповідь: ${show(oldV)}`));
              notes.append(el('div', nowOk ? 'ok' : 'bad', `Нова відповідь: ${show(nowV)}`));
            }
          } else if (changed) {
            notes.append(el('div', 'muted', `Стара відповідь: ${show(oldV)}`));
            notes.append(el('div', 'new', `Нова відповідь: ${show(nowV)}`));
          }
          if (changed) row.classList.add('rv-new');
          if (notes.children.length) row.append(notes);
        } else if (chk) {
          const right = String(q.correct[k]);
          const nowV = has(ans, k) ? String(ans[k]) : '';
          const notes = el('div', 'rv-notes');
          if (nowV) row.classList.add('rv-new');   // оранжева обводка вашого вибору
          if (nowV === right) {
            row.classList.add('rv-ok');
          } else {
            if (nowV) {
              row.classList.add('rv-bad');
              notes.append(el('div', 'new', `Твоя відповідь: ${mt(q, nowV)}`));
            }
            notes.append(el('div', 'ok', `Правильно: ${mt(q, right)}`));
          }
          if (notes.children.length) row.append(notes);
        }
        box.appendChild(row);
      });
      const legend = el('div', 'match-legend');
      Object.entries(q.matches).forEach(([mk, mtxt]) => {
        const item = el('div');
        item.append(el('b', null, mk), el('span', null, mtxt));
        legend.appendChild(item);
      });
      box.appendChild(legend);
    },
    isAnswered: (q, a) =>
      isObj(a) && Object.keys(q.choices).every((k) => has(a, k) && a[k] !== ''),
    isCorrect: (q, a) =>
      isObj(a) && Object.keys(q.choices).every((k) => a[k] === String(q.correct[k])),
    text(q, a) {
      const ans = isObj(a) ? a : {};
      return Object.keys(q.choices).map((k) => {
        const v = has(ans, k) ? String(ans[k]) : '';
        return `${opt(q, k)} → ${v && has(q.matches, v) ? mt(q, v) : NONE}`;
      }).join('\n');
    },
    /* Пари "ключ з choices" - "ключ з matches", у порядку choices */
    short(q, a) {
      const ans = isObj(a) ? a : {};
      const pairs = Object.keys(q.choices)
        .filter((k) => has(ans, k) && ans[k] !== '' && has(q.matches, String(ans[k])))
        .map((k) => `${k}-${ans[k]}`);
      return pairs.length ? pairs.join(', ') : '-';
    },
    format(q, a) {
      const ans = isObj(a) ? a : {};
      const m = (mk) => `${mk} "${q.matches[mk]}"`;
      return Object.keys(q.choices).map((k) => {
        const left = opt(q, k);
        const right = String(q.correct[k]);
        if (ans[k] === right) return `${left} → ${m(right)} ✅`;
        const mine = has(ans, k) && has(q.matches, ans[k]) ? m(ans[k]) : NONE;
        return `${left} → ${mine} ❌ - ${m(right)}`;
      }).join('\n');
    }
  },

  /* Послідовність: choices + correct: ["2","1","3"] (усі ключі в правильному порядку).
     Відповідь — масив, де індекс = позиція, null = вільна позиція (можна ставити пункти в будь-якому порядку) */
  'ordering': {
    validate(q) {
      if (!nonEmptyObj(q.choices) || Object.keys(q.choices).length < 2)
        return '"choices" має бути об\'єктом щонайменше з двома пунктами.';
      const keys = Object.keys(q.choices);
      if (!Array.isArray(q.correct) || q.correct.length !== keys.length ||
          new Set(q.correct).size !== keys.length || q.correct.some((k) => !has(q.choices, k)))
        return '"correct" має бути списком усіх ключів з "choices" у правильному порядку, без повторів.';
      return null;
    },
    render(q, answer, box, onAnswer, rv, chk) {
      const keys = Object.keys(q.choices);
      const n = keys.length;
      const seq = Array.isArray(answer) ? answer : [];
      const slots = () => keys.map((_, i) => (seq[i] === undefined ? null : seq[i]));
      const commit = (arr) => onAnswer(trimSeq(arr));

      box.innerHTML = '';
      box.appendChild(el('p', 'hint',
        'Натискайте пункти по черзі, обирайте позицію праворуч або впишіть порядок вручну (наприклад: 2 1 3).'));

      const error = el('div', 'order-error');
      error.hidden = true;
      const fail = (msg) => { error.textContent = msg; error.hidden = false; };

      keys.forEach((k) => {
        const pos = seq.indexOf(k);
        const row = el('div', 'order-row');

        /* Клік: поставити на першу вільну позицію або прибрати (позиція звільняється) */
        const btn = choiceButton(k, q.choices[k], pos >= 0, () => {
          const arr = slots();
          if (pos >= 0) arr[pos] = null;
          else {
            const free = arr.indexOf(null);
            if (free >= 0) arr[free] = k;
          }
          commit(arr);
        });
        if ((chk || (rv && rv.reveal)) && pos >= 0) btn.classList.add(q.correct[pos] === k ? 'rv-ok' : 'rv-bad');
        if (chk && !rv && pos >= 0) {
          btn.classList.add('rv-new');
          const tg = el('span', 'tags');
          tg.append(tagEl(q.correct[pos] === k ? 'ok' : 'bad', q.correct[pos] === k ? '✓ правильно' : '✗ неправильно'), tagEl('new', 'твоя'));
          btn.append(tg);
        }

        /* Вибір конкретної позиції; зайняту позицію не приймаємо */
        const select = document.createElement('select');
        select.className = 'pos-select';
        select.title = 'Позиція у послідовності';
        select.setAttribute('aria-label', `Позиція для пункту ${k}`);
        select.add(new Option('—', ''));
        for (let p = 1; p <= n; p++) select.add(new Option(String(p), String(p)));
        select.value = pos >= 0 ? String(pos + 1) : '';
        select.onchange = () => {
          const arr = slots();
          const cur = arr.indexOf(k);
          if (select.value === '') {
            if (cur >= 0) arr[cur] = null;
            return commit(arr);
          }
          const idx = Number(select.value) - 1;
          if (arr[idx] !== null && arr[idx] !== k) {
            select.value = cur >= 0 ? String(cur + 1) : '';
            return fail(`Позиція ${idx + 1} уже зайнята пунктом ${arr[idx]}. Так не можна — спочатку звільніть її.`);
          }
          if (cur >= 0) arr[cur] = null;
          arr[idx] = k;
          commit(arr);
        };

        row.append(btn, select);
        box.appendChild(row);
      });

      /* Ручне введення порядку */
      const manual = el('div', 'order-manual');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'order-input';
      input.placeholder = 'напр. 2 1 3';
      input.setAttribute('aria-label', 'Порядок вручну');
      input.value = seq.some((k) => k !== null && k !== undefined)
        ? seq.map((k) => (k === null || k === undefined ? '-' : k)).join(' ')
        : '';
      const apply = () => {
        const res = parseOrder(q, input.value);
        if (res.error) return fail(res.error);
        commit(res.arr);
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } };
      const applyBtn = el('button', 'secondary small', 'Застосувати');
      applyBtn.onclick = apply;
      const reset = el('button', 'secondary small', 'Скинути порядок');
      reset.onclick = () => onAnswer([]);
      manual.append(el('span', 'muted', 'Порядок вручну:'), input, applyBtn, reset);
      box.append(manual, error);

      if (rv) {
        const T = (a) => handlers.ordering.text(q, a);
        const block = el('div', 'rv-block');
        if (rv.reveal) {
          block.append(el('div', 'ok', `Правильний порядок: ${T(q.correct)}`));
          block.append(el('div', handlers.ordering.isCorrect(q, rv.old) ? 'ok' : 'bad',
            `Стара відповідь: ${T(rv.old)}`));
        } else {
          block.append(el('div', 'muted', `Стара відповідь: ${T(rv.old)}`));
        }
        if (sig(seq) !== sig(rv.old)) {
          const cls = rv.reveal ? (handlers.ordering.isCorrect(q, seq) ? 'ok' : 'bad') : 'new';
          block.append(el('div', cls, `Нова відповідь: ${T(seq)}`));
        }
        box.appendChild(block);
      }
    },
    isAnswered: (q, a) =>
      Array.isArray(a) && a.length === Object.keys(q.choices).length &&
      a.every((k) => k !== null && k !== undefined),
    isCorrect: (q, a) =>
      Array.isArray(a) && a.length === q.correct.length && a.every((k, i) => k === q.correct[i]),
    text(q, a) {
      const arr = Array.isArray(a) ? a : [];
      const good = (k) => k !== null && k !== undefined && has(q.choices, k);
      if (!arr.some(good)) return NONE;
      return arr.map((k) => (good(k) ? opt(q, k) : '—')).join(' → ');
    },
    short(q, a) {
      const arr = Array.isArray(a) ? a : [];
      const good = (k) => k !== null && k !== undefined && has(q.choices, k);
      return arr.some(good) ? arr.map((k) => (good(k) ? k : '-')).join(' → ') : '-';
    },
    format(q, a) {
      const right = q.correct.map((k) => opt(q, k)).join(' → ');
      if (this.isCorrect(q, a)) return `${right} ✅`;
      return `${this.text(q, a)} ❌ - ${right}`;
    }
  },

  /* Правда / неправда: correct: true | false (без choices) */
  'true-false': {
    validate(q) {
      return typeof q.correct === 'boolean' ? null : '"correct" має бути true або false.';
    },
    render(q, answer, box, onAnswer, rv, chk) {
      box.innerHTML = '';
      [[true, 'Правда', '✓'], [false, 'Неправда', '✗']].forEach(([v, text, mark]) => {
        const btn = choiceButton(mark, text, answer === v, () => onAnswer(v));
        if (rv) markChoice(btn, { correct: v === q.correct, old: rv.old === v, now: answer === v }, rv.reveal);
        else if (chk) markCheck(btn, { correct: v === q.correct, now: answer === v });
        box.appendChild(btn);
      });
    },
    isAnswered: (q, a) => typeof a === 'boolean',
    isCorrect: (q, a) => a === q.correct,
    text: (q, a) => (typeof a === 'boolean' ? (a ? 'Правда' : 'Неправда') : NONE),
    short: (q, a) => (typeof a === 'boolean' ? (a ? 'Правда' : 'Неправда') : '-'),
    format(q, a) {
      const name = (v) => (v ? 'Правда' : 'Неправда');
      if (a === q.correct) return `${name(q.correct)} ✅`;
      return `${typeof a === 'boolean' ? name(a) : NONE} ❌ - ${name(q.correct)}`;
    }
  },

  /* Коротка відповідь (вводиться текстом): correct: "3,5" або ["3,5", "7/2"] (кілька допустимих варіантів),
     необов'язкове "case-sensitive": true (за замовчуванням регістр не враховується) */
  'short-answer': {
    validate(q) {
      const ok = (v) => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v));
      if (!ok(q.correct) && !(Array.isArray(q.correct) && q.correct.length && q.correct.every(ok)))
        return '"correct" має бути непорожнім рядком (або числом) чи непорожнім списком таких значень, наприклад ["3,5", "3.5"].';
      if (q['case-sensitive'] !== undefined && q['case-sensitive'] !== null && typeof q['case-sensitive'] !== 'boolean')
        return '"case-sensitive" має бути true або false (без лапок).';
      return null;
    },
    render(q, answer, box, onAnswer, rv, chk) {
      const cur = typeof answer === 'string' ? answer : '';
      let st = box._sa;
      /* Поле вводу створюємо один раз на питання і не перемальовуємо при кожному символі, щоб не губити фокус і клавіатуру */
      if (!st || st.q !== q || !box.contains(st.wrap)) {
        const hadFocus = !!st && st.input === document.activeElement;
        box.innerHTML = '';
        const wrap = el('div', 'sa-wrap');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'sa-input';
        input.placeholder = 'Введіть відповідь';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'Відповідь');
        st = box._sa = { q, wrap, input, onAnswer };
        input.oninput = () => {
          const v = input.value;
          st.onAnswer(v.trim() === '' ? null : v);
        };
        input.onkeydown = (e) => {
          if (e.key !== 'Enter' || e.repeat || e.isComposing) return;
          e.preventDefault();
          $('btn-next').click();
        };
        wrap.append(el('p', 'hint', 'Введіть відповідь (Enter — далі).'), input);
        box.appendChild(wrap);
        input.value = cur;
        if (hadFocus) input.focus();
      }
      st.onAnswer = onAnswer;
      const input = st.input;
      if (document.activeElement !== input && input.value !== cur) input.value = cur;
      Array.from(box.children).forEach((c) => { if (c !== st.wrap) c.remove(); });

      const self = handlers['short-answer'];
      const has = cur.trim() !== '';
      input.classList.remove('rv-ok', 'rv-bad', 'rv-new', 'rv-old');
      if (chk && has) input.classList.add(self.isCorrect(q, cur) ? 'rv-ok' : 'rv-bad');
      if (rv) {
        const oldT = typeof rv.old === 'string' ? rv.old.trim() : '';
        const changed = cur.trim() !== oldT;
        if (rv.reveal && has) input.classList.add(self.isCorrect(q, cur) ? 'rv-ok' : 'rv-bad');
        else if (changed && has) input.classList.add('rv-new');
        const block = el('div', 'rv-block');
        if (rv.reveal) {
          block.append(el('div', 'ok', `Правильна відповідь: ${saText(q.correct)}`));
          block.append(el('div', self.isCorrect(q, rv.old) ? 'ok' : 'bad', `Стара відповідь: ${saText(rv.old)}`));
        } else {
          block.append(el('div', 'muted', `Стара відповідь: ${saText(rv.old)}`));
        }
        if (changed && has) {
          const cls = rv.reveal ? (self.isCorrect(q, cur) ? 'ok' : 'bad') : 'new';
          block.append(el('div', cls, `Нова відповідь: ${saText(cur)}`));
        }
        box.appendChild(block);
      }
    },
    isAnswered: (q, a) => typeof a === 'string' && a.trim() !== '',
    isCorrect: (q, a) => typeof a === 'string' && a.trim() !== '' && saVariants(q).some((v) => saSame(q, a, v)),
    text: (q, a) => saText(a),
    short: (q, a) => { const t = saText(a); return t === NONE ? '-' : t; },
    format(q, a) {
      const right = saText(q.correct);
      if (this.isCorrect(q, a)) return `${right} ✅`;
      return `${saText(a)} ❌ - ${right}`;
    }
  }
};

/* ---------- Стан ----------
   mode: 'quiz' | 'review'
   old: відповіді з завантажених результатів (лише в режимі помилок)
   wrong: номери питань, на які відповіли неправильно або взагалі не відповіли
   showCorrect: чекбокс «Одразу показувати відповіді» (за замовчуванням вимкнено):
     у режимі помилок — одразу відкриває правильність, у звичайному — автоматично показує відповідь на кожному питанні
   checkOnNext: чекбокс «Показувати відповідь при натисканні Далі» (за замовчуванням вимкнено) */
const newState = (questions = []) => ({
  questions, current: 0, answers: {}, finished: false,
  fileName: '',   // назва завантаженого файлу з тестом
  mode: 'quiz', old: {}, wrong: [], showCorrect: false, checkOnNext: false, explainOnNext: false, timer: defaultTimer(),
  view: 'order',  // 'order' — за порядком, 'topics' — палітра блоками за темами
  collapsed: {}   // згорнуті блоки палітри: 'all' (вигляд за порядком) і 't:<тема>' (вигляд за темами)
});
let state = newState();
let answersOpen = false;   // відкритий екран «Правильні відповіді» (не зберігається)
let pendingTestName = '';  // назва файлу тесту, завантаженого для збережених результатів (не зберігається)
let pendingTest = null;    // тест, завантажений разом зі збереженими результатами (не зберігається)
let pendingSaved = null;   // розібрані збережені результати { old, wrong, current } (не зберігається)
let checked = false;       // відповідь на поточне питання показано; скидається при зміні питання (не зберігається)
let lastQuizIdx = -1;      // питання, яке було намальовано востаннє
let explShown = false;     // пояснення на поточному питанні вже відкривали (не зберігається, скидається при зміні питання)
let homeOpen = false;      // відкрита головна сторінка поверх завантаженого тесту (не зберігається)
let explainOpener = null;  // елемент, що мав фокус до відкриття вікна пояснення
const isReview = () => state.mode === 'review';
/* Тема питання (поле "topic"); порожній рядок = без теми */
const topicOf = (q) => (typeof q.topic === 'string' ? q.topic.trim() : '');
const hasTopics = () => state.questions.some((q) => topicOf(q) !== '');

/* ---------- Зображення до питання: "images": ["data:image/png;base64,...", ...] ---------- */
const DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s_-]+$/i;
function validateImages(images) {
  if (images === undefined || images === null) return null;
  if (!Array.isArray(images)) return '"images" має бути списком (масивом) рядків.';
  const bad = images.findIndex((src) => typeof src !== 'string' || !DATA_URL_RE.test(src.trim()));
  return bad < 0 ? null
    : `"images[${bad}]" має бути Data URL у форматі "data:image/png;base64,...".`;
}

/* Показ зображень під питанням (перемальовуємо лише при зміні питання, щоб не блимало) */
function renderImages(q) {
  const box = $('question-images');
  if (box._for === q) return;
  box._for = q;
  box.innerHTML = '';
  const list = Array.isArray(q.images) ? q.images : [];
  list.forEach((src, i) => {
    const img = document.createElement('img');
    img.className = 'q-image';
    img.alt = `Зображення ${i + 1} до питання`;
    img.title = 'Натисніть, щоб збільшити';
    img.src = src.trim();
    img.onclick = () => openLightbox(img.src);
    img.onerror = () => {
      const msg = el('span', 'muted', `Не вдалося показати зображення ${i + 1}.`);
      img.replaceWith(msg);
    };
    box.appendChild(img);
  });
  box.hidden = !list.length;
}
function openLightbox(src) {
  $('lightbox-img').src = src;
  $('lightbox').hidden = false;
}
function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightbox-img').removeAttribute('src');
}
$('lightbox').onclick = closeLightbox;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox(); });

/* ---------- Валідація JSON ---------- */
function validate(data) {
  if (!Array.isArray(data) || !data.length) return 'JSON має бути непорожнім масивом.';
  for (let i = 0; i < data.length; i++) {
    const q = data[i];
    const n = i + 1;
    if (!q || typeof q.question !== 'string') return `Питання ${n}: немає поля "question".`;
    if (q.topic !== undefined && q.topic !== null && typeof q.topic !== 'string')
      return `Питання ${n}: поле "topic" має бути рядком.`;
    const imgErr = validateImages(q.images);
    if (imgErr) return `Питання ${n}: ${imgErr}`;
    q.type = TYPE_ALIASES[q.type] || q.type;
    const h = handlers[q.type];
    if (!h) return `Питання ${n}: непідтримуваний тип "${q.type}".`;
    const err = h.validate(q);
    if (err) return `Питання ${n}: ${err}`;
  }
  return null;
}

/* Перевірка і впорядкування тесту.
   "index" (ціле число ≥ 0) задає номер питання, 0 = перше. Питання без index ідуть у кінець у порядку файлу.
   Однакові index лишаються поруч у порядку файлу. Далі скрізь працює лише відсортований масив:
   відповіді, результати і прогрес прив'язані до позиції в ньому. */
function prepareTest(data) {
  const err = validate(data);
  if (err) return { error: err };
  for (let i = 0; i < data.length; i++) {
    const q = data[i];
    if (q.index !== undefined && q.index !== null && !(Number.isInteger(q.index) && q.index >= 0))
      return { error: `Питання ${i + 1}: "index" має бути цілим числом, не меншим за 0.` };
    if (q.explanation !== undefined && q.explanation !== null && typeof q.explanation !== 'string')
      return { error: `Питання ${i + 1}: "explanation" має бути рядком.` };
  }
  const hasIdx = (q) => Number.isInteger(q.index);
  const questions = data.map((q, pos) => ({ q, pos })).sort((a, b) => {
    const ha = hasIdx(a.q), hb = hasIdx(b.q);
    if (ha && hb) return a.q.index - b.q.index || a.pos - b.pos;
    if (ha !== hb) return ha ? -1 : 1;
    return a.pos - b.pos;
  }).map((x) => x.q);
  return { questions };
}

/* Пояснення до питання: непорожній рядок або '' */
const explOf = (q) => (typeof q.explanation === 'string' ? q.explanation.trim() : '');

function fingerprint(questions) {
  const s = questions.map((q) => q.question).join('\u0001');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/* ---------- Копіювання і завантаження ---------- */
async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
  if (!btn) return;
  if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
  btn.textContent = ok ? 'Скопійовано ✓' : 'Не вдалося скопіювати';
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
}

function computeResults() {
  const total = state.questions.length;
  const items = state.questions.map((q, i) => {
    const h = handlers[q.type];
    const a = state.answers[i];
    return { i, q, ok: h.isCorrect(q, a), answered: h.isAnswered(q, a), line: h.format(q, a) };
  });
  const score = items.filter((x) => x.ok).length;
  const okPct = Math.round((score / total) * 100);
  return {
    total, items, score, okPct, badPct: 100 - okPct,
    skipped: items.filter((x) => !x.answered).length
  };
}
const statsLine = (r) =>
  `✅ Правильно: ${r.score} (${r.okPct}%)   ❌ Неправильно: ${r.total - r.score} (${r.badPct}%)` +
  (r.skipped ? ` — з них без відповіді: ${r.skipped}` : '');

/* Повний звіт: бал, відсотки і всі відповіді з порядковими номерами */
function fullReport() {
  const r = computeResults();
  const body = r.items.map((x) => `${x.i + 1}. ${x.q.question}\n${x.line}`).join('\n\n');
  return `Результат: ${r.score} з ${r.total}\n${statsLine(r)}${timerResultText() ? '\n' + timerResultText() : ''}\n\n${body}`;
}
/* Короткий звіт: лише номер і ✅/❌ */
function marksReport() {
  const r = computeResults();
  return 'Результат:\n' + r.items.map((x) => `${x.i + 1}.- ${x.ok ? '✅' : '❌'}`).join('\n');
}
/* Поточні відповіді без позначок правильно/неправильно: "1. А", "2. -" */
function myAnswersReport() {
  return state.questions.map((q, i) => `${i + 1}. ${handlers[q.type].short(q, state.answers[i])}`).join('\n');
}
/* Правильні відповіді на весь тест */
function answersReport() {
  return 'Правильні відповіді:\n\n' + state.questions
    .map((q, i) => `${i + 1}. ${q.question}\n${handlers[q.type].text(q, q.correct)}`)
    .join('\n\n');
}

function downloadResults() {
  const r = computeResults();
  const payload = {
    app: 'json-quiz', version: 1, date: new Date().toISOString(),
    total: r.total, score: r.score, current: state.current, fingerprint: fingerprint(state.questions),
    answers: state.questions.map((q, i) => (state.answers[i] === undefined ? null : state.answers[i])),
    results: r.items.map((x) => x.ok),
    timer: exportTimer()
  };
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `results-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Бали НМТ: правила з окремого JSON-файлу (формат scoring-format.md) ---------- */
let nmtConfig = null;   // { cfg, scaler, warnings, name } — розібраний файл правил (не зберігається)
let nmtError = '';      // помилка завантаження файлу правил

/* Вбудовані пресети правил (ті самі файли правил, що можна завантажити вручну) */
const NMT_PRESETS = [
  { id: "ukrainian", name: "Українська мова", cfg: {"test":{"max-points":45,"score":{"single-choice":{"strategy":"all-or-nothing","points":1,"count":25},"matching-question":{"strategy":"per-pair","points-per-pair":1,"penalty-per-wrong":0,"min-points":0,"max-points":4,"count":5}}},"scaled":{"min-scaled":100,"max-scaled":200,"threshold":{"min-test-points":8,"below-threshold":null},"strategy":"lookup-table","table":{"8":100,"9":105,"10":110,"11":120,"12":125,"13":130,"14":134,"15":136,"16":138,"17":140,"18":142,"19":143,"20":144,"21":145,"22":146,"23":148,"24":149,"25":150,"26":152,"27":154,"28":156,"29":157,"30":159,"31":160,"32":162,"33":163,"34":165,"35":167,"36":170,"37":172,"38":175,"39":177,"40":180,"41":183,"42":186,"43":191,"44":195,"45":200}}} },
  { id: "math", name: "Математика", cfg: {"test":{"max-points":32,"score":{"single-choice":{"strategy":"all-or-nothing","points":1,"count":15},"matching-question":{"strategy":"per-pair","points-per-pair":1,"penalty-per-wrong":0,"min-points":0,"max-points":3,"count":3},"short-answer":{"strategy":"all-or-nothing","points":2,"count":4}}},"scaled":{"min-scaled":100,"max-scaled":200,"threshold":{"min-test-points":5,"below-threshold":null},"strategy":"lookup-table","table":{"5":100,"6":108,"7":115,"8":123,"9":131,"10":134,"11":137,"12":140,"13":143,"14":145,"15":147,"16":148,"17":149,"18":150,"19":151,"20":152,"21":155,"22":159,"23":163,"24":167,"25":170,"26":173,"27":176,"28":180,"29":184,"30":189,"31":194,"32":200}}} },
  { id: "history", name: "Історія України", cfg: {"test":{"max-points":54,"score":{"single-choice":{"strategy":"all-or-nothing","points":1},"multiple-choice":{"strategy":"per-correct","points-per-correct":1,"penalty-per-wrong":0,"min-points":0,"max-points":3},"matching-question":{"strategy":"per-pair","points-per-pair":1,"penalty-per-wrong":0,"min-points":0,"max-points":4},"ordering":{"strategy":"tiers","max-points":3,"tiers":[{"points":3,"when":{"all-positions":true}},{"points":2,"when":{"positions-all":["first","last"]}},{"points":1,"when":{"positions-any":["first","last"]}}],"default-points":0},"true-false":{"strategy":"per-statement","points-per-statement":1,"penalty-per-wrong":0,"min-points":0,"max-points":1}}},"scaled":{"min-scaled":100,"max-scaled":200,"threshold":{"min-test-points":9,"below-threshold":null},"strategy":"lookup-table","table":{"9":100,"10":105,"11":110,"12":115,"13":120,"14":125,"15":130,"16":132,"17":134,"18":136,"19":138,"20":140,"21":141,"22":142,"23":143,"24":144,"25":145,"26":146,"27":147,"28":148,"29":149,"30":150,"31":151,"32":152,"33":154,"34":156,"35":158,"36":160,"37":163,"38":166,"39":168,"40":169,"41":170,"42":172,"43":173,"44":175,"45":177,"46":179,"47":181,"48":183,"49":185,"50":188,"51":191,"52":194,"53":197,"54":200}}} },
  { id: "foreign-language", name: "Іноземна мова", cfg: {"test":{"max-points":32,"score":{"single-choice":{"strategy":"all-or-nothing","points":1,"count":21},"matching-question":{"strategy":"all-or-nothing","points":1,"count":11}}},"scaled":{"min-scaled":100,"max-scaled":200,"threshold":{"min-test-points":5,"below-threshold":null},"strategy":"lookup-table","table":{"5":100,"6":109,"7":118,"8":125,"9":131,"10":134,"11":137,"12":140,"13":143,"14":145,"15":147,"16":148,"17":149,"18":150,"19":151,"20":152,"21":153,"22":155,"23":157,"24":159,"25":162,"26":166,"27":169,"28":173,"29":179,"30":185,"31":191,"32":200}}} },
  { id: "biology", name: "Біологія", cfg: {"test":{"max-points":46,"score":{"single-choice":{"strategy":"all-or-nothing","points":1,"count":24},"matching-question":{"strategy":"per-pair","points-per-pair":1,"penalty-per-wrong":0,"min-points":0,"max-points":4,"count":4},"multiple-choice":{"strategy":"per-correct","points-per-correct":1,"penalty-per-wrong":0,"min-points":0,"max-points":3,"count":2}}},"scaled":{"min-scaled":100,"max-scaled":200,"threshold":{"min-test-points":7,"below-threshold":null},"strategy":"lookup-table","table":{"7":100,"8":107,"9":114,"10":119,"11":124,"12":128,"13":131,"14":134,"15":136,"16":138,"17":140,"18":142,"19":144,"20":145,"21":146,"22":147,"23":148,"24":149,"25":150,"26":151,"27":152,"28":154,"29":156,"30":158,"31":160,"32":162,"33":164,"34":166,"35":168,"36":170,"37":172,"38":175,"39":177,"40":179,"41":182,"42":185,"43":188,"44":192,"45":196,"46":200}}} },
  { id: "physics", name: "Фізика", cfg: {"test":{"max-points":32,"score":{"single-choice":{"strategy":"all-or-nothing","points":1,"count":14},"matching-question":{"strategy":"per-pair","points-per-pair":1,"penalty-per-wrong":0,"min-points":0,"max-points":3,"count":2},"short-answer":{"strategy":"all-or-nothing","points":2,"count":6}}},"scaled":{"min-scaled":100,"max-scaled":200,"threshold":{"min-test-points":5,"below-threshold":null},"strategy":"lookup-table","table":{"5":100,"6":109,"7":118,"8":125,"9":131,"10":134,"11":137,"12":140,"13":143,"14":145,"15":147,"16":148,"17":149,"18":150,"19":151,"20":152,"21":156,"22":160,"23":164,"24":166,"25":169,"26":173,"27":176,"28":179,"29":184,"30":189,"31":194,"32":200}}} },
  { id: "chemistry", name: "Хімія", cfg: {"test":{"max-points":32,"score":{"single-choice":{"strategy":"all-or-nothing","points":1,"count":18},"matching-question":{"strategy":"per-pair","points-per-pair":1,"penalty-per-wrong":0,"min-points":0,"max-points":3,"count":2},"short-answer":{"strategy":"all-or-nothing","points":2,"count":4}}},"scaled":{"min-scaled":100,"max-scaled":200,"threshold":{"min-test-points":5,"below-threshold":null},"strategy":"lookup-table","table":{"5":100,"6":109,"7":118,"8":125,"9":131,"10":134,"11":137,"12":140,"13":143,"14":145,"15":147,"16":148,"17":149,"18":150,"19":151,"20":152,"21":156,"22":160,"23":164,"24":166,"25":169,"26":173,"27":176,"28":179,"29":184,"30":189,"31":194,"32":200}}} }
];

const ALLOWED_STRATEGIES = {
  'single-choice': ['all-or-nothing'],
  'multiple-choice': ['per-correct', 'all-or-nothing'],
  'matching-question': ['per-pair', 'all-or-nothing'],
  'ordering': ['tiers', 'all-or-nothing'],
  'true-false': ['per-statement', 'all-or-nothing'],
  'short-answer': ['all-or-nothing']
};
const PER_UNIT_KEY = {
  'per-correct': 'points-per-correct',
  'per-pair': 'points-per-pair',
  'per-statement': 'points-per-statement'
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const validPos = (p) => p === 'first' || p === 'last' || (Number.isInteger(p) && p >= 1);
const fmtNum = (x) => String(Math.round(x * 1000) / 1000);
/* Нижня межа за замовчуванням 0 (щоб штрафи не вели в мінус), верхня — без обмеження */
const clampPts = (v, r) => Math.min(r['max-points'] ?? Infinity, Math.max(r['min-points'] ?? 0, v));

/* Перевірка одного правила; повертає null або текст помилки */
function validateRule(r) {
  const nn = (v) => isNum(v) && v >= 0;
  if (r.count !== undefined && !(Number.isInteger(r.count) && r.count >= 0))
    return '"count" має бути цілим числом ≥ 0.';
  if (r.strategy === 'all-or-nothing') return nn(r.points) ? null : '"points" має бути числом ≥ 0.';

  if (r.strategy === 'tiers') {
    if (!Array.isArray(r.tiers) || !r.tiers.length) return '"tiers" має бути непорожнім списком.';
    for (const k of ['default-points', 'max-points'])
      if (r[k] !== undefined && !nn(r[k])) return `"${k}" має бути числом ≥ 0.`;
    let prev = Infinity;
    for (let i = 0; i < r.tiers.length; i++) {
      const t = r.tiers[i];
      const n = i + 1;
      if (!isObj(t) || !nn(t.points)) return `рівень ${n}: "points" має бути числом ≥ 0.`;
      if (t.points > prev) return `рівень ${n}: бали зростають зверху вниз (рівні мають іти від найвищого до найнижчого).`;
      prev = t.points;
      if (!nonEmptyObj(t.when)) return `рівень ${n}: "when" має бути непорожнім об'єктом.`;
      for (const [k, v] of Object.entries(t.when)) {
        if (k === 'all-positions') {
          if (v !== true) return `рівень ${n}: "all-positions" може бути лише true.`;
        } else if (k === 'positions-all' || k === 'positions-any') {
          if (!Array.isArray(v) || !v.length || !v.every(validPos))
            return `рівень ${n}: "${k}" має бути списком із "first", "last" або чисел ≥ 1.`;
        } else {
          return `рівень ${n}: невідома умова "${k}".`;
        }
      }
    }
    if (r['max-points'] !== undefined && r.tiers[0].points > r['max-points'])
      return 'найвищий рівень перевищує "max-points".';
    return null;
  }

  const unit = PER_UNIT_KEY[r.strategy];
  if (!nn(r[unit])) return `"${unit}" має бути числом ≥ 0.`;
  for (const k of ['penalty-per-wrong', 'min-points', 'max-points'])
    if (r[k] !== undefined && !nn(r[k])) return `"${k}" має бути числом ≥ 0.`;
  if ((r['min-points'] ?? 0) > (r['max-points'] ?? Infinity)) return '"min-points" не може бути більшим за "max-points".';
  return null;
}

/* Максимум за одне завдання за декларацією правила (для перевірки "count"); undefined, якщо невідомо */
function ruleMax(r) {
  if (r.strategy === 'all-or-nothing') return r.points;
  if (r.strategy === 'tiers') return r['max-points'] ?? Math.max(r['default-points'] ?? 0, ...r.tiers.map((t) => t.points));
  return r['max-points'];
}

/* Блок "scaled": повертає { lo, below, apply(x) } або { error } */
function buildScaler(sc, maxPts) {
  if (!isObj(sc)) return { error: 'має бути об\'єктом.' };
  let thMin = null;
  let below = null;
  if (sc.threshold !== undefined) {
    const th = sc.threshold;
    if (!isObj(th)) return { error: '"threshold" має бути об\'єктом.' };
    if (th['min-test-points'] !== undefined) {
      thMin = th['min-test-points'];
      if (!Number.isInteger(thMin) || thMin < 0 || thMin > maxPts)
        return { error: '"threshold.min-test-points" має бути цілим числом від 0 до "test.max-points".' };
    }
    below = th['below-threshold'] ?? null;
    if (below !== null && !isNum(below)) return { error: '"threshold.below-threshold" має бути числом або null.' };
  }

  let lo;
  let fn;
  if (sc.strategy === 'lookup-table') {
    if (!nonEmptyObj(sc.table)) return { error: '"table" має бути непорожнім об\'єктом.' };
    const table = {};
    for (const [k, v] of Object.entries(sc.table)) {
      if (!/^\d+$/.test(k)) return { error: `ключ таблиці "${k}" має бути цілим тестовим балом.` };
      if (!isNum(v)) return { error: `значення для балу ${k} має бути числом.` };
      table[Number(k)] = v;
    }
    const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
    if (keys[keys.length - 1] > maxPts)
      return { error: `таблиця містить бал ${keys[keys.length - 1]}, що більше за "test.max-points" (${maxPts}).` };
    lo = thMin ?? keys[0];
    for (let x = lo; x <= maxPts; x++)
      if (!(x in table)) return { error: `у таблиці немає тестового балу ${x} (потрібні всі цілі від ${lo} до ${maxPts}).` };
    for (let x = lo + 1; x <= maxPts; x++)
      if (table[x] < table[x - 1]) return { error: `значення спадає на тестовому балі ${x}.` };
    fn = (x) => table[x];
  } else if (sc.strategy === 'piecewise-linear') {
    const an = sc.anchors;
    if (!Array.isArray(an) || an.length < 2 ||
        an.some((p) => !Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])))
      return { error: '"anchors" має бути списком щонайменше з двох пар [тестовий бал, рейтинговий бал].' };
    for (let i = 1; i < an.length; i++) {
      if (an[i][0] <= an[i - 1][0]) return { error: '"anchors" мають іти за зростанням тестового балу.' };
      if (an[i][1] < an[i - 1][1]) return { error: `значення спадає в опорній точці [${an[i][0]}, ${an[i][1]}].` };
    }
    if (an[an.length - 1][0] < maxPts)
      return { error: `остання опорна точка (${an[an.length - 1][0]}) менша за "test.max-points" (${maxPts}).` };
    const rnd = { 'half-up': (v) => Math.floor(v + 0.5), floor: Math.floor, ceil: Math.ceil }[sc.rounding ?? 'half-up'];
    if (!rnd) return { error: '"rounding" має бути "half-up", "floor" або "ceil".' };
    lo = thMin ?? an[0][0];
    fn = (x) => {
      if (x <= an[0][0]) return an[0][1];
      for (let i = 1; i < an.length; i++) {
        if (x <= an[i][0]) {
          const [x0, y0] = an[i - 1];
          const [x1, y1] = an[i];
          return rnd(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
        }
      }
      return an[an.length - 1][1];
    };
  } else {
    return { error: '"strategy" має бути "lookup-table" або "piecewise-linear".' };
  }

  if (sc['min-scaled'] !== undefined && fn(lo) !== sc['min-scaled'])
    return { error: `мінімальний тестовий бал (${lo}) дає ${fn(lo)}, а "min-scaled" = ${sc['min-scaled']}.` };
  if (sc['max-scaled'] !== undefined && fn(maxPts) !== sc['max-scaled'])
    return { error: `максимальний тестовий бал (${maxPts}) дає ${fn(maxPts)}, а "max-scaled" = ${sc['max-scaled']}.` };

  return { lo, below, apply: (x) => (x < lo ? { below: true, value: below } : { below: false, value: fn(x) }) };
}

/* Перевірка всього файлу правил */
function parseScoring(cfg) {
  const warnings = [];
  if (!isObj(cfg) || !isObj(cfg.test)) return { error: 'Це не файл правил балів: немає блоку "test".' };
  const maxPts = cfg.test['max-points'];
  if (!Number.isInteger(maxPts) || maxPts < 1) return { error: '"test.max-points" має бути цілим числом ≥ 1.' };
  const rules = cfg.test.score;
  if (!nonEmptyObj(rules)) return { error: '"test.score" має бути непорожнім об\'єктом.' };

  for (const [type, r] of Object.entries(rules)) {
    const allowed = ALLOWED_STRATEGIES[type];
    if (!allowed) return { error: `"test.score": невідомий тип завдання "${type}".` };
    if (!isObj(r) || !allowed.includes(r.strategy))
      return { error: `"${type}": "strategy" має бути однією з: ${allowed.join(', ')}.` };
    const e = validateRule(r);
    if (e) return { error: `"${type}": ${e}` };
  }

  /* Правило 8: сума count × max-points має збігатися з test.max-points (лише попередження) */
  const types = Object.keys(rules);
  if (types.every((t) => rules[t].count !== undefined && ruleMax(rules[t]) !== undefined)) {
    const sum = types.reduce((s, t) => s + rules[t].count * ruleMax(rules[t]), 0);
    if (sum !== maxPts) warnings.push(`Сума "count × max-points" за типами дорівнює ${sum}, а "test.max-points" = ${maxPts}.`);
  }

  let scaler = null;
  if (cfg.scaled !== undefined) {
    scaler = buildScaler(cfg.scaled, maxPts);
    if (scaler.error) return { error: `"scaled": ${scaler.error}` };
  }
  return { cfg, scaler, warnings };
}

/* Бали за одне завдання. Відсутня відповідь = 0 */
function scoreQuestion(q, a, r) {
  const h = handlers[q.type];
  if (r.strategy === 'all-or-nothing') return h.isCorrect(q, a) ? r.points : 0;
  const pen = r['penalty-per-wrong'] ?? 0;

  if (r.strategy === 'per-correct') {
    const sel = Array.isArray(a) ? [...new Set(a.filter((k) => has(q.choices, k)))] : [];
    if (!sel.length) return 0;
    const c = sel.filter((k) => q.correct.includes(k)).length;
    return clampPts(c * r['points-per-correct'] - (sel.length - c) * pen, r);
  }

  if (r.strategy === 'per-pair') {
    const ans = isObj(a) ? a : {};
    let c = 0;
    let w = 0;
    Object.keys(q.choices).forEach((k) => {
      const v = has(ans, k) ? String(ans[k]) : '';
      if (!v) return;
      if (v === String(q.correct[k])) c++; else w++;
    });
    if (!c && !w) return 0;
    return clampPts(c * r['points-per-pair'] - w * pen, r);
  }

  if (r.strategy === 'per-statement') {
    if (typeof a !== 'boolean') return 0;
    const c = a === q.correct ? 1 : 0;
    return clampPts(c * r['points-per-statement'] - (1 - c) * pen, r);
  }

  /* tiers: рівні зверху вниз, перший, умови якого виконані (усі умови в "when" — разом) */
  const arr = Array.isArray(a) ? a : [];
  if (!arr.some((k) => k !== null && k !== undefined)) return 0;
  const n = q.correct.length;
  const ok = (i) => arr[i] === q.correct[i];
  const idx = (p) => {
    const i = p === 'first' ? 0 : p === 'last' ? n - 1 : p - 1;
    if (i < 0 || i >= n) throw new Error(`позиція ${p} виходить за межі (у питанні пунктів: ${n}).`);
    return i;
  };
  const matches = (w) =>
    (w['all-positions'] === undefined || q.correct.every((_, i) => ok(i))) &&
    (w['positions-all'] === undefined || w['positions-all'].every((p) => ok(idx(p)))) &&
    (w['positions-any'] === undefined || w['positions-any'].some((p) => ok(idx(p))));
  for (const t of r.tiers) if (matches(t.when)) return t.points;
  return r['default-points'] ?? 0;
}

/* Максимум за одне завдання (залежить від самого питання: кількість правильних, пар тощо) */
function maxQuestion(q, r) {
  if (r.strategy === 'all-or-nothing') return r.points;
  if (r.strategy === 'per-correct') return clampPts(q.correct.length * r['points-per-correct'], r);
  if (r.strategy === 'per-pair') return clampPts(Object.keys(q.choices).length * r['points-per-pair'], r);
  if (r.strategy === 'per-statement') return clampPts(r['points-per-statement'], r);
  return Math.min(r['max-points'] ?? Infinity, Math.max(r['default-points'] ?? 0, ...r.tiers.map((t) => t.points)));
}

/* Повний розрахунок: сирі бали → максимум за правилами → масштабування до max-points файлу → рейтинговий бал */
function computeNmt(conf) {
  const { cfg, scaler } = conf;
  const rules = cfg.test.score;
  const fileMax = cfg.test['max-points'];
  const per = {};
  let raw = 0;
  let max = 0;

  state.questions.forEach((q, i) => {
    const r = rules[q.type];
    if (!r) throw new Error(`Питання ${i + 1}: у файлі немає правил для типу "${q.type}".`);
    let s;
    let m;
    try {
      s = scoreQuestion(q, state.answers[i], r);
      m = maxQuestion(q, r);
    } catch (e) {
      throw new Error(`Питання ${i + 1}: ${e.message}`);
    }
    const p = per[q.type] || (per[q.type] = { count: 0, score: 0, max: 0 });
    p.count++; p.score += s; p.max += m;
    raw += s; max += m;
  });
  if (max <= 0) throw new Error('Максимальний тестовий бал за цими правилами дорівнює 0.');

  /* Масштабування: наприклад, у тесті максимум 108, а у файлі 54 → коефіцієнт 108 / 54 = 2, бали ділимо на 2 */
  const factor = max / fileMax;
  const exact = raw / factor;
  const scaledTest = Math.min(fileMax, Math.max(0, Math.round(exact)));
  const rating = scaler ? scaler.apply(scaledTest) : null;

  const warnings = [...conf.warnings];
  Object.entries(rules).forEach(([type, r]) => {
    const have = per[type] ? per[type].count : 0;
    if (r.count !== undefined && r.count !== have)
      warnings.push(`Тип "${type}": у файлі count = ${r.count}, а в тесті питань: ${have}.`);
  });
  return { raw, max, fileMax, factor, exact, scaledTest, rating, per, warnings, lo: scaler ? scaler.lo : null };
}

function renderNmt() {
  const box = $('nmt-box');
  const body = $('nmt-body');
  const err = $('nmt-error');
  body.innerHTML = '';
  err.hidden = true;
  if (!nmtConfig && !nmtError) { box.hidden = true; return; }
  box.hidden = false;
  if (nmtError) { err.textContent = nmtError; err.hidden = false; }
  if (!nmtConfig) return;

  let r;
  try {
    r = computeNmt(nmtConfig);
  } catch (e) {
    err.textContent = 'Не вдалося порахувати: ' + e.message;
    err.hidden = false;
    return;
  }

  const row = (label, value, cls) => {
    const d = el('div', 'nmt-row' + (cls ? ' ' + cls : ''));
    d.append(el('span', 'nmt-label', label), el('span', 'nmt-value', value));
    body.appendChild(d);
  };

  row('Файл правил', nmtConfig.name);
  row('Тестові бали за правилами', `${fmtNum(r.raw)} з ${fmtNum(r.max)}`);
  if (r.max !== r.fileMax) {
    row('Масштабування',
      `максимум у тесті ${fmtNum(r.max)}, у файлі ${r.fileMax}: коефіцієнт ${fmtNum(r.max)} / ${r.fileMax} = ${fmtNum(r.factor)}. ` +
      `${fmtNum(r.raw)} / ${fmtNum(r.factor)} = ${fmtNum(r.exact)} ≈ ${r.scaledTest}`);
  }
  row('Тестові бали для шкали', `${r.scaledTest} з ${r.fileMax}`);

  if (!r.rating) {
    row('Рейтинговий бал', 'у файлі немає блоку "scaled"', 'muted');
  } else if (r.rating.below) {
    const v = r.rating.value;
    row('Рейтинговий бал',
      (v === null ? 'результату немає' : String(v)) + ` (менше за поріг: ${r.lo} тестових балів)`, 'bad');
  } else {
    row('Рейтинговий бал', String(r.rating.value), 'nmt-main');
  }

  const t = el('div', 'nmt-types');
  Object.entries(r.per).forEach(([type, p]) => {
    t.appendChild(el('div', 'muted', `${type}: ${p.count} пит. — ${fmtNum(p.score)} з ${fmtNum(p.max)}`));
  });
  body.appendChild(t);
  r.warnings.forEach((w) => body.appendChild(el('div', 'nmt-warn', '⚠ ' + w)));
}

/* ---------- Таймер / секундомір ----------
   state.timer: { stopped (true = не встановлений), type: 'timer'|'stopwatch', init (с), ms (поточне значення), ended }
   Живий стан (біг/пауза) не зберігається: після завантаження таймер завжди на паузі. */
const TMAX = 99 * 3600 + 59 * 60 + 59;   // межа: 99:59:59
const TR = { t: null, synced: null, t0: 0, base: 0, running: false, open: false };
const isRun = () => TR.running && TR.t === state.timer;

function defaultTimer() { return { stopped: true, type: 'timer', init: 0, ms: 0, ended: false }; }
function normTimer(t) {
  if (!isObj(t) || t.stopped !== false) return defaultTimer();
  const lim = (v) => Math.min(TMAX * 1000, Math.max(0, Number.isFinite(v) ? v : 0));
  return {
    stopped: false, type: t.type === 'stopwatch' ? 'stopwatch' : 'timer',
    init: Math.round(lim(t.init * 1000) / 1000), ms: lim(t.ms), ended: !!t.ended
  };
}
function exportTimer() { return state.timer.stopped ? null : { ...state.timer, ms: tCur() }; }
function timerSync() { if (state.timer && !state.timer.stopped && isRun()) state.timer.ms = tCur(); }

function tCur() {
  const t = state.timer;
  if (t.stopped || !isRun()) return t.ms;
  const d = Date.now() - TR.t0;
  return t.type === 'timer' ? TR.base - d : TR.base + d;
}
const secOf = (ms, type) => Math.min(TMAX, Math.max(0, (type === 'timer' ? Math.ceil : Math.floor)(ms / 1000)));
function fmtT(ms, type) {
  const s = secOf(ms, type);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
}
/* Час вийшов: таймер дійшов до 0 або секундомір до межі */
function tEnd(v) {
  const t = state.timer;
  t.ms = v; t.ended = true; TR.running = false;
  saveState();
}
function tHitEnd(t, v) { return t.type === 'timer' ? v <= 0 : v >= TMAX * 1000; }
function tTick() {
  const t = state.timer;
  if (t.stopped || !isRun()) return;
  const v = tCur();
  if (tHitEnd(t, v)) tEnd(t.type === 'timer' ? 0 : TMAX * 1000);
  updateTimerUI();
}
function tSetRun(on) {
  const t = state.timer;
  if (t.stopped || t.ended || on === isRun()) return;
  if (on) { TR.t = t; TR.base = t.ms; TR.t0 = Date.now(); TR.running = true; }
  else { t.ms = tCur(); TR.running = false; }
  saveState();
  updateTimerUI();
}
function tReadInputs() {
  const g = (id) => Math.min(99, Math.max(0, parseInt($(id).value, 10) || 0));
  return Math.min(TMAX, g('timer-h') * 3600 + g('timer-m') * 60 + g('timer-s'));
}
function tErr(msg) { $('timer-err').textContent = msg || ''; $('timer-err').hidden = !msg; }
function tStart() {
  const type = document.querySelector('input[name="timer-type"]:checked').value;
  const s = tReadInputs();
  if (type === 'timer' && s <= 0) { tErr('Для таймера вкажіть час більший за нуль.'); return; }
  tErr('');
  state.timer = { stopped: false, type, init: s, ms: s * 1000, ended: false };
  TR.t = state.timer; TR.synced = state.timer; TR.base = state.timer.ms; TR.t0 = Date.now(); TR.running = true;
  if (tHitEnd(state.timer, state.timer.ms)) tEnd(state.timer.ms); else saveState();
  updateTimerUI();
}
/* Зупинити остаточно: таймер знову не встановлений */
function tStop() {
  TR.running = false;
  state.timer = defaultTimer();
  saveState();
  updateTimerUI();
}
/* Скинути: повернути початкове значення (fromFields — взяти його з полів вводу); біг/пауза зберігаються */
function tResetInit(fromFields) {
  const t = state.timer;
  if (t.stopped) return;
  if (fromFields) {
    const s = tReadInputs();
    if (t.type === 'timer' && s <= 0) { tErr('Для таймера вкажіть час більший за нуль.'); return; }
    tErr('');
    t.init = s;
  }
  t.ms = t.init * 1000; t.ended = false;
  if (isRun()) { TR.base = t.ms; TR.t0 = Date.now(); }
  if (tHitEnd(t, t.ms)) tEnd(t.ms); else saveState();
  updateTimerUI();
}
/* dir > 0 — на 10 с вперед за ходом часу (для таймера це зменшення), dir < 0 — назад */
function tSeek(dir) {
  const t = state.timer;
  if (t.stopped || t.ended) return;
  const v = Math.min(TMAX * 1000, Math.max(0, tCur() + (t.type === 'timer' ? -dir : dir) * 10000));
  t.ms = v;
  if (isRun()) { TR.base = v; TR.t0 = Date.now(); }
  if (tHitEnd(t, v)) tEnd(v); else saveState();
  updateTimerUI();
}

/* Підсумок для екрана результатів, звіту і файлу результатів */
function timerResultText() {
  const t = state.timer;
  if (t.stopped) return '';
  const ms = tCur();
  if (t.type === 'timer') {
    return t.ended ? `Таймер: час вийшов (було ${fmtT(t.init * 1000, 'stopwatch')})`
      : `Таймер: тест пройдено за ${fmtT(t.init * 1000 - ms, 'stopwatch')}, залишилось ${fmtT(ms, 'timer')}`;
  }
  return `Секундомір: час проходження ${fmtT(Math.max(0, ms - t.init * 1000), 'stopwatch')}` + (t.ended ? ' (досягнуто межу)' : '');
}

function updateTimerUI() {
  const t = state.timer;
  const wrap = $('timer-wrap');
  wrap.hidden = !(state.questions.length > 0 && !homeOpen);
  if (wrap.hidden) return;
  const set = !t.stopped;
  const run = isRun();
  $('timer-box').className = 'timer-box ' + (!set ? 't-off' : t.ended ? 't-end' : run ? 't-run' : 't-pause');
  /* Прилипає, поки налаштований; скинутий, але з відкритим меню — теж лишається, доки меню не звернуть */
  wrap.classList.toggle('sticky', set || TR.open);
  const ms = tCur();
  $('timer-time').hidden = !set;
  if (set) $('timer-time').textContent = fmtT(ms, t.type);
  $('timer-resume-mini').hidden = !(set && !run && !t.ended);
  $('timer-reset-mini').hidden = !(set && t.ended);
  $('timer-panel').hidden = !TR.open;
  if (!TR.open) return;

  const idle = !set || t.ended;
  $('timer-start').textContent = set ? '⬢ Зупинити' : '▶ Запустити';
  $('timer-start').classList.toggle('danger', set);
  $('timer-pause').textContent = run ? '⏸ Пауза' : '▶ Відновити';
  ['timer-pause', 'timer-back', 'timer-fwd'].forEach((id) => { $(id).disabled = idle; });
  $('timer-reset').disabled = !set;
  document.querySelectorAll('input[name="timer-type"]').forEach((i) => { i.disabled = set; });
  if (set && TR.synced !== t) {   // поля тримають початкове значення і не біжать разом із таймером
    TR.synced = t;
    $('timer-h').value = Math.floor(t.init / 3600);
    $('timer-m').value = Math.floor(t.init / 60) % 60;
    $('timer-s').value = t.init % 60;
    document.querySelector(`input[name="timer-type"][value="${t.type}"]`).checked = true;
  }
}
$('timer-toggle').onclick = () => { TR.open = !TR.open; updateTimerUI(); };
/* Клік будь-де поза таймером ховає меню налаштувань */
document.addEventListener('pointerdown', (e) => {
  if (!TR.open || $('timer-box').contains(e.target)) return;
  TR.open = false;
  updateTimerUI();
});
$('timer-start').onclick = () => (state.timer.stopped ? tStart() : tStop());
$('timer-pause').onclick = () => tSetRun(!isRun());
$('timer-resume-mini').onclick = () => tSetRun(true);
$('timer-reset-mini').onclick = tStop;
$('timer-reset').onclick = () => tResetInit(true);
$('timer-back').onclick = () => tSeek(-1);
$('timer-fwd').onclick = () => tSeek(1);
setInterval(tTick, 250);

/* ---------- Екрани ---------- */
function show(screen) {
  ['load', 'quiz', 'result', 'answers'].forEach((s) => { $('screen-' + s).hidden = screen !== s; });
  $('footer').hidden = screen === 'load';
  $('btn-finish').hidden = screen !== 'quiz';
  $('btn-save').hidden = screen !== 'quiz';
  $('btn-copy-mine-f').hidden = screen !== 'quiz';
  $('btn-answers').hidden = screen === 'answers';
}

function updateCtxInfo() {
  let t;
  if (ctx.save !== null) {
    const it = readSaves().items.find((x) => x.id === ctx.save);
    t = `Сейв №${ctx.save}` + (it ? ` «${it.name}»` : '');
  } else if (ctx.key === 'manual') {
    t = 'Ручне завантаження файлу';
  } else {
    t = `Посилання: path=${ctx.path}` + (ctx.mode !== 'default' ? ` · mode=${ctx.mode}` : '') + (ctx.results ? ` · results=${ctx.results}` : '');
  }
  $('ctx-info').textContent = 'Прогрес зберігається: ' + t;
  $('url-box').hidden = !ctx.path || ctx.error !== '';
}

function render() {
  updateCtxInfo();
  updateTimerUI();
  if (homeOpen && state.questions.length) { show('load'); renderHome(); renderSaves(); return; }
  homeOpen = false;
  renderHome();
  if (!state.questions.length || answersOpen || state.finished) lastQuizIdx = -1;
  if (!state.questions.length) { show('load'); renderSaves(); return; }
  if (answersOpen) return renderAnswers();
  if (state.finished) return renderResults();
  renderQuiz();
}

/* Головна: якщо тест завантажено — замість вибору файлів кнопки «Продовжити» і «Скинути» */
function renderHome() {
  const active = homeOpen && state.questions.length > 0;
  $('home-active').hidden = !active;
  $('load-block').hidden = active;
  $('review-block').hidden = active;
  if (active) {
    const total = state.questions.length;
    $('home-info').textContent =
      (state.fileName ? `Файл: ${state.fileName}. ` : '') +
      `Тест завантажено: питань ${total}, виконано ${answeredCount()}` + (state.finished ? ' · завершено' : '') + '.';
  }
}

function renderQuiz() {
  /* Показ відповіді діє лише поки ви на цьому питанні */
  if (lastQuizIdx !== state.current) {
    checked = !isReview() && !!state.showCorrect;
    explShown = false;
  }
  lastQuizIdx = state.current;
  const review = isReview();
  const total = state.questions.length;
  const q = state.questions[state.current];
  const h = handlers[q.type];
  const answer = state.answers[state.current];
  const pos = review ? state.wrong.indexOf(state.current) : state.current;
  const count = review ? state.wrong.length : total;

  show('quiz');
  $('file-info').textContent = state.fileName ? `Файл: ${state.fileName}` : '';
  $('file-info').hidden = !state.fileName;
  $('counter').textContent = review
    ? `Робота над помилками: ${pos + 1} з ${count} (питання № ${state.current + 1})`
    : `Питання ${state.current + 1}/${total}`;
  if (topicOf(q)) $('counter').textContent += ` (${topicOf(q)})`;
  renderViewSwitch();
  const done = answeredCount();
  $('done-counter').textContent = `Виконано: ${done} з ${total} (без відповіді: ${total - done})`;
  $('progress-bar').style.width = `${(pos / count) * 100}%`;
  $('question').textContent = q.question;
  renderImages(q);
  $('rv-legend').hidden = !review;
  $('chk-show-correct').checked = !!state.showCorrect;
  document.querySelectorAll('#rv-legend [data-rv]').forEach((tag) => {
    tag.hidden = tag.dataset.rv === 'reveal' ? !state.showCorrect : !!state.showCorrect;
  });

  const rv = review ? { old: state.old[state.current], reveal: !!state.showCorrect || checked } : null;
  h.render(q, answer, $('answer-area'), (value) => {
    state.answers[state.current] = value;
    saveState();
    render();
  }, rv, !review && checked);

  /* Зелена плашка з правильною відповіддю (+ червона з вашою, якщо вона неправильна) */
  const hasAnswer = sig(answer) !== 'null';
  $('btn-reset-answer').disabled = !hasAnswer;
  $('btn-reveal').textContent = checked ? 'Сховати відповідь' : 'Показати відповідь';
  $('chk-check-next').checked = !!state.checkOnNext;
  $('chk-explain-next').checked = !!state.explainOnNext;
  $('btn-explain').hidden = !explOf(q);
  $('reveal-box').hidden = !checked;
  if (checked) {
    $('reveal-text').textContent = `Правильна відповідь:\n${h.text(q, q.correct)}`;
    const wrongMine = hasAnswer && !h.isCorrect(q, answer);
    $('reveal-mine').hidden = !wrongMine;
    if (wrongMine) $('reveal-mine').textContent = `Ваша відповідь:\n${h.text(q, answer)}`;
  }

  renderPalette();
  $('btn-prev').disabled = pos === 0;
  $('btn-next').disabled = false;
  $('btn-next').textContent = pos === count - 1 ? 'Завершити' : 'Далі →';
}

/* Скільки питань мають відповідь (непорожню) */
const answeredCount = () => state.questions.filter((q, i) => handlers[q.type].isAnswered(q, state.answers[i])).length;

function renderViewSwitch() {
  $('view-buttons').hidden = !hasTopics();
  $('view-order').classList.toggle('active', state.view !== 'topics');
  $('view-topics').classList.toggle('active', state.view === 'topics');
}
function setView(v) {
  if (state.view === v) return;
  state.view = v;
  saveState();
  render();
}
$('view-order').onclick = () => setView('order');
$('view-topics').onclick = () => setView('topics');

function paletteButton(i) {
  const review = isReview();
  const q = state.questions[i];
  const btn = document.createElement('button');
  btn.textContent = i + 1;
  btn.title = `Питання ${i + 1}` + (topicOf(q) ? ` (${topicOf(q)})` : '');
  if (review) {
    btn.classList.add('rv-wrong');
    if (!sameAnswer(q, state.answers[i], state.old[i])) {
      btn.classList.add('rv-changed');
      btn.title += ' — відповідь змінено';
    }
  } else if (handlers[q.type].isAnswered(q, state.answers[i])) {
    btn.classList.add('answered');
  }
  if (i === state.current) btn.classList.add('current');
  btn.onclick = () => { state.current = i; saveState(); render(); };
  return btn;
}

let paletteKeys = [];   // ключі блоків, намальованих зараз (для «Згорнути все»)

function toggleBlock(key) {
  if (state.collapsed[key]) delete state.collapsed[key]; else state.collapsed[key] = true;
  saveState();
  renderPalette();
}
$('btn-collapse-all').onclick = () => {
  const allCollapsed = paletteKeys.length > 0 && paletteKeys.every((k) => state.collapsed[k]);
  paletteKeys.forEach((k) => { if (allCollapsed) delete state.collapsed[k]; else state.collapsed[k] = true; });
  saveState();
  renderPalette();
};

function renderPalette() {
  const box = $('palette');
  box.innerHTML = '';
  const review = isReview();
  const indexes = review ? state.wrong : state.questions.map((q, i) => i);
  const grouped = state.view === 'topics' && hasTopics();
  box.classList.add('grouped');

  /* Блоки: за порядком — один блок «Усі питання»; за темами — спочатку «Без теми», далі теми в порядку першої появи.
     Усередині блоку номери за зростанням. Навігація «Далі/Назад» від цього не залежить і йде за порядком питань */
  const blocks = [];
  if (!grouped) {
    blocks.push({ key: 'all', name: 'Усі питання', list: indexes });
  } else {
    const groups = new Map([['', []]]);
    indexes.forEach((i) => {
      const t = topicOf(state.questions[i]);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(i);
    });
    groups.forEach((list, topic) => {
      if (list.length) blocks.push({ key: 't:' + topic, name: topic || 'Без теми', list });
    });
  }
  paletteKeys = blocks.map((x) => x.key);

  blocks.forEach(({ key, name, list }) => {
    const collapsed = !!state.collapsed[key];
    const done = review ? 0 : list.filter((i) => handlers[state.questions[i].type].isAnswered(state.questions[i], state.answers[i])).length;
    const head = el('div', 'palette-title', `${collapsed ? '▸' : '▾'} ${name} — ${review ? list.length : done + '/' + list.length}`);
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.title = collapsed ? 'Розгорнути' : 'Згорнути';
    head.onclick = () => toggleBlock(key);
    head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBlock(key); } };

    const items = el('div', 'palette-items');
    items.hidden = collapsed;
    list.forEach((i) => items.appendChild(paletteButton(i)));

    const g = el('div', 'palette-group');
    g.append(head, items);
    box.appendChild(g);
  });

  const allCollapsed = paletteKeys.length > 0 && paletteKeys.every((k) => state.collapsed[k]);
  $('btn-collapse-all').textContent = allCollapsed ? 'Розгорнути все' : 'Згорнути все';
}

function renderResults() {
  show('result');
  tSetRun(false);   // після завершення тесту таймер зупиняється
  const r = computeResults();
  const list = $('result-list');
  list.innerHTML = '';

  r.items.forEach((x) => {
    const li = document.createElement('li');
    const title = document.createElement('div');
    title.className = 'q-text';
    title.textContent = x.q.question;
    const line = document.createElement('div');
    line.className = 'line ' + (x.ok ? 'ok' : 'bad');
    line.textContent = x.line;
    li.append(title, line);
    list.appendChild(li);
  });

  $('score').textContent = `Результат: ${r.score} з ${r.total}`;
  $('bar-ok').style.width = r.okPct + '%';
  $('bar-bad').style.width = r.badPct + '%';
  $('stats-text').textContent = statsLine(r);

  const rs = $('review-stats');
  if (isReview()) {
    const was = state.questions.filter((q, i) => handlers[q.type].isCorrect(q, state.old[i])).length;
    const changed = state.wrong.filter((i) =>
      !sameAnswer(state.questions[i], state.answers[i], state.old[i])).length;
    rs.textContent = `Робота над помилками: було правильно ${was}, стало ${r.score}. Змінено відповідей: ${changed}.`;
    rs.hidden = false;
  } else {
    rs.hidden = true;
  }
  const tt = timerResultText();
  $('timer-result').textContent = tt;
  $('timer-result').hidden = !tt;
  renderNmt();
}

function renderAnswers() {
  show('answers');
  const list = $('answers-list');
  list.innerHTML = '';
  state.questions.forEach((q, i) => {
    const li = document.createElement('li');
    const title = el('div', 'q-text', q.question);
    const line = el('div', 'line ok', handlers[q.type].text(q, q.correct));
    li.append(title, line);
    list.appendChild(li);
  });
}

/* ---------- Події ---------- */
/* Перше «Далі» при увімкненому чекбоксі лише показує відповідь, друге — переходить */
function wantsCheck() {
  if (!state.checkOnNext || checked) return false;
  if (state.showCorrect) return false;
  return sig(state.answers[state.current]) !== 'null';
}
/* Друге «Далі»: пояснення (якщо чекбокс увімкнено, пояснення є, відповідь дана і його ще не відкривали) */
function wantsExplain() {
  if (!state.explainOnNext || explShown) return false;
  if (!explOf(state.questions[state.current])) return false;
  return sig(state.answers[state.current]) !== 'null';
}
function openExplain() {
  const q = state.questions[state.current];
  const text = explOf(q);
  if (!text) return;
  explShown = true;
  explainOpener = document.activeElement;
  $('explain-text').textContent = text;
  $('explain-modal').hidden = false;
  $('btn-explain-ok').focus();
}
function closeExplain() {
  $('explain-modal').hidden = true;
  $('explain-text').textContent = '';
  const o = explainOpener;
  explainOpener = null;
  if (o && o !== document.body && document.contains(o) && typeof o.focus === 'function') o.focus();
}
function step(dir) {
  if (dir > 0 && wantsCheck()) { checked = true; render(); return; }
  if (dir > 0 && wantsExplain()) { openExplain(); return; }
  if (isReview()) {
    const list = state.wrong;
    const target = dir > 0
      ? list.find((i) => i > state.current)
      : [...list].reverse().find((i) => i < state.current);
    if (target !== undefined) state.current = target;
    else if (dir > 0) state.finished = true;
  } else if (dir > 0) {
    if (state.current < state.questions.length - 1) state.current++;
    else state.finished = true;
  } else if (state.current > 0) {
    state.current--;
  }
  saveState();
  render();
}
$('btn-next').onclick = () => step(1);
$('btn-prev').onclick = () => step(-1);

$('btn-restart').onclick = () => {
  if (!confirm(`Почати спочатку для ${scopeText()}? Поточні відповіді буде стерто (інші сейви й посилання не зачіпаються).`)) return;
  answersOpen = false;
  state.finished = false;
  checked = false;
  tResetInit();
  if (isReview()) {
    state.answers = { ...state.old };
    state.current = state.wrong[0];
  } else {
    state.answers = {};
    state.current = 0;
  }
  saveState();
  render();
};
$('btn-finish').onclick = () => {
  state.finished = true;
  saveState();
  render();
};
$('btn-continue').onclick = () => {
  state.finished = false;
  saveState();
  render();
};
function resetTest(message) {
  if (!confirm(message)) return;
  clearState();
  state = newState();
  resetTransient();
  checked = false;
  explShown = false;
  homeOpen = false;
  $('save-warning').hidden = true;
  $('file-input').value = '';
  $('error').textContent = '';
  render();
}
$('btn-new').onclick = () =>
  resetTest(`Очистити результат для ${scopeText()}? Тест і відповіді буде видалено лише тут (інші сейви й посилання не зачіпаються).`);

/* Головна поверх завантаженого тесту */
$('btn-home').onclick = () => { homeOpen = true; render(); };
$('btn-home-continue').onclick = () => { homeOpen = false; render(); };
$('btn-home-reset').onclick = () =>
  resetTest(`Скинути тест для ${scopeText()}? Тест і весь прогрес буде видалено лише тут (інші сейви й посилання не зачіпаються), після чого можна завантажити новий тест.`);

/* Пояснення */
$('btn-explain').onclick = openExplain;
$('btn-explain-ok').onclick = closeExplain;
$('chk-explain-next').onchange = (e) => {
  state.explainOnNext = e.target.checked;
  saveState();
  render();
};

/* Клавіатура. Вікно пояснення: Esc або Enter закривають його. Поза вікнами Enter = клік «Далі»,
   якщо фокус не на елементі, який сам обробляє Enter (поле, кнопка, посилання, список) */
document.addEventListener('keydown', (e) => {
  if (!$('explain-modal').hidden) {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) closeExplain();
    }
    return;
  }
  if (!$('nmt-modal').hidden) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeNmtModal();
    }
    return;
  }
  if (e.key !== 'Enter' || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if ($('screen-quiz').hidden || !$('lightbox').hidden) return;
  if (e.target && e.target.closest && e.target.closest('input, select, textarea, button, a, [tabindex]')) return;
  e.preventDefault();
  $('btn-next').click();
}, true);

$('btn-reveal').onclick = () => { checked = !checked; render(); };
$('btn-reset-answer').onclick = () => {
  delete state.answers[state.current];
  saveState();
  render();
};
$('chk-check-next').onchange = (e) => {
  state.checkOnNext = e.target.checked;
  saveState();
  render();
};
$('btn-reveal-copy').onclick = (e) => {
  const q = state.questions[state.current];
  copyText(`${state.current + 1}. ${q.question}\n${handlers[q.type].text(q, q.correct)}`, e.currentTarget);
};

$('btn-copy-full').onclick = (e) => copyText(fullReport(), e.currentTarget);
$('btn-copy-marks').onclick = (e) => copyText(marksReport(), e.currentTarget);
$('btn-copy-mine').onclick = (e) => copyText(myAnswersReport(), e.currentTarget);
$('btn-copy-mine-f').onclick = (e) => copyText(myAnswersReport(), e.currentTarget);
$('btn-download').onclick = downloadResults;

/* Бали НМТ: запит файлу правил */
let nmtOpener = null;
function openNmtModal() {
  nmtOpener = document.activeElement;
  const list = $('nmt-presets');
  list.innerHTML = '';
  NMT_PRESETS.forEach((p) => {
    const b = el('button', 'nmt-preset' + (nmtConfig && nmtConfig.presetId === p.id ? ' active' : ''));
    b.type = 'button';
    b.append(el('span', 'nmt-preset-name', p.name), el('span', 'nmt-preset-meta', `макс. ${p.cfg.test['max-points']} балів`));
    b.onclick = () => applyNmtPreset(p);
    list.appendChild(b);
  });
  $('nmt-modal').hidden = false;
  (list.querySelector('.nmt-preset') || $('btn-nmt-upload')).focus();
}
function closeNmtModal() {
  $('nmt-modal').hidden = true;
  const o = nmtOpener;
  nmtOpener = null;
  if (o && o !== document.body && document.contains(o) && typeof o.focus === 'function') o.focus();
}
function applyNmtPreset(p) {
  closeNmtModal();
  nmtConfig = null;
  nmtError = '';
  const res = parseScoring(p.cfg);
  if (res.error) nmtError = `Пресет «${p.name}»: ${res.error}`;
  else nmtConfig = { ...res, name: `${p.name} (пресет)`, presetId: p.id };
  render();
}
$('btn-nmt').onclick = openNmtModal;
$('btn-nmt-cancel').onclick = closeNmtModal;
$('btn-nmt-upload').onclick = () => { closeNmtModal(); $('nmt-input').click(); };
$('nmt-modal').onclick = (e) => { if (e.target === $('nmt-modal')) closeNmtModal(); };
$('nmt-input').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  readJsonFile(file, (readErr, data) => {
    nmtConfig = null;
    nmtError = '';
    if (readErr) nmtError = readErr;
    else {
      const res = parseScoring(data);
      if (res.error) nmtError = res.error;
      else nmtConfig = { ...res, name: file.name };
    }
    render();
  });
};
$('btn-save').onclick = downloadResults;

$('chk-show-correct').onchange = (e) => {
  state.showCorrect = e.target.checked;
  if (!isReview()) checked = state.showCorrect;
  saveState();
  render();
};

const openAnswers = () => { answersOpen = true; render(); };
$('btn-answers').onclick = openAnswers;
$('btn-show-answers').onclick = openAnswers;
$('btn-answers-back').onclick = () => { answersOpen = false; render(); };
$('btn-copy-answers').onclick = (e) => copyText(answersReport(), e.currentTarget);

/* ---------- Завантаження файлів ---------- */
function readJsonFile(file, done) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch (ex) { return done('Не вдалося прочитати JSON: ' + ex.message); }
    done(null, data);
  };
  reader.onerror = () => done('Не вдалося прочитати файл.');
  reader.readAsText(file);
}

function resetTransient() {
  answersOpen = false;
  pendingTest = null;
  pendingSaved = null;
  $('saved-actions').hidden = true;
  $('review-test-input').value = '';
  $('review-results-input').value = '';
  $('review-results-input').disabled = true;
  $('review-info').textContent = '';
  $('review-error').textContent = '';
}

/* ---------- Розбір файлу результатів (спільний для файлу і для ?results=) ---------- */
const MISMATCH_MSG = 'Схоже, ці результати належать до іншого тесту. Продовжити все одно?';
function parseResultsData(qs, data) {
  if (!isObj(data) || !Array.isArray(data.answers))
    return { error: 'Це не файл результатів: у ньому немає списку "answers".' };
  if (data.answers.length !== qs.length)
    return { error: `У результатах ${data.answers.length} відповідей, а в тесті ${qs.length} питань.` };
  const mismatch = !!data.fingerprint && data.fingerprint !== fingerprint(qs);

  const old = {};
  data.answers.forEach((a, i) => { if (a !== null && a !== undefined) old[i] = a; });
  const answered = qs.filter((q, i) => handlers[q.type].isAnswered(q, old[i])).length;
  const wrong = qs.map((q, i) => i).filter((i) => !handlers[qs[i].type].isCorrect(qs[i], old[i]));

  /* Де продовжувати: збережена позиція, інакше перше питання без відповіді */
  let current = Number.isInteger(data.current) && data.current >= 0 && data.current < qs.length
    ? data.current
    : qs.findIndex((q, i) => !handlers[q.type].isAnswered(q, old[i]));
  if (current < 0) current = 0;
  return { old, wrong, current, answered, mismatch, timer: normTimer(data.timer) };
}

/* Звичайний режим */
$('file-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  readJsonFile(file, (readErr, data) => {
    if (readErr) { $('error').textContent = readErr; return; }
    const prep = prepareTest(data);
    if (prep.error) { $('error').textContent = prep.error; return; }
    state = newState(prep.questions);
    state.fileName = file.name;
    resetTransient();
    $('error').textContent = '';
    saveState();
    render();
  });
};

/* Робота над помилками, крок 1: тест */
$('review-test-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pendingTest = null;
  pendingSaved = null;
  $('saved-actions').hidden = true;
  $('review-results-input').value = '';
  $('review-results-input').disabled = true;
  $('review-info').textContent = '';
  $('review-error').textContent = '';
  readJsonFile(file, (readErr, data) => {
    const prep = readErr ? null : prepareTest(data);
    const err = readErr || prep.error;
    if (err) { $('review-error').textContent = err; return; }
    pendingTest = prep.questions;
    pendingTestName = file.name;
    $('review-results-input').disabled = false;
    $('review-info').textContent = `Тест завантажено (питань: ${pendingTest.length}). Тепер оберіть файл результатів.`;
  });
};

/* Збережені результати, крок 2: файл результатів → вибір «продовжити» або «робота над помилками» */
$('review-results-input').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !pendingTest) return;
  const qs = pendingTest;
  pendingSaved = null;
  $('saved-actions').hidden = true;
  const fail = (msg) => { $('review-info').textContent = ''; $('review-error').textContent = msg; };
  $('review-error').textContent = '';

  readJsonFile(file, (readErr, data) => {
    if (readErr) return fail(readErr);
    const r = parseResultsData(qs, data);
    if (r.error) return fail(r.error);
    if (r.mismatch && !confirm(MISMATCH_MSG)) return fail('Скасовано: результати не збігаються з тестом.');

    pendingSaved = { old: r.old, wrong: r.wrong, current: r.current, timer: r.timer };
    $('review-info').textContent =
      `Результати завантажено: відповідей ${r.answered} з ${qs.length}, ` +
      `неправильних або без відповіді — ${r.wrong.length}.`;
    $('btn-start-review').disabled = !r.wrong.length;
    $('btn-start-review').title = r.wrong.length ? '' : 'У цих результатах немає помилок';
    $('saved-actions').hidden = false;
  });
};

/* Продовжити як звичайний тест із збереженими відповідями */
$('btn-continue-saved').onclick = () => {
  if (!pendingTest || !pendingSaved) return;
  state = { ...newState(pendingTest), fileName: pendingTestName, answers: { ...pendingSaved.old }, current: pendingSaved.current, timer: pendingSaved.timer };
  resetTransient();
  saveState();
  render();
};

/* Режим роботи над помилками */
$('btn-start-review').onclick = () => {
  if (!pendingTest || !pendingSaved || !pendingSaved.wrong.length) return;
  const { old, wrong } = pendingSaved;
  state = {
    ...newState(pendingTest), fileName: pendingTestName, mode: 'review', old, wrong,
    current: wrong[0], answers: { ...old }
  };
  resetTransient();
  saveState();
  render();
};

/* ---------- Старт ---------- */
function restoreState() {
  const s = loadState();
  if (!s || !Array.isArray(s.questions) || !s.questions.length) return;
  try { if (validate(s.questions)) return; } catch (e) { return; }

  const st = Object.assign(newState(s.questions), s);
  const n = st.questions.length;
  if (!isObj(st.answers)) st.answers = {};
  if (!isObj(st.old)) st.old = {};
  delete st.revealed;
  st.wrong = (Array.isArray(st.wrong) ? st.wrong : []).filter((i) => Number.isInteger(i) && i >= 0 && i < n);
  st.mode = st.mode === 'review' && st.wrong.length ? 'review' : 'quiz';
  st.finished = !!st.finished;
  st.fileName = typeof s.fileName === 'string' ? s.fileName : '';
  st.showCorrect = !!st.showCorrect;
  st.checkOnNext = !!st.checkOnNext;
  st.explainOnNext = !!st.explainOnNext;
  st.view = st.view === 'topics' ? 'topics' : 'order';
  if (!isObj(st.collapsed)) st.collapsed = {};
  if (!Number.isInteger(st.current) || st.current < 0 || st.current >= n) st.current = 0;
  if (st.mode === 'review' && !st.wrong.includes(st.current)) st.current = st.wrong[0];
  st.timer = normTimer(s.timer);   // після завантаження таймер завжди на паузі
  state = st;
}
/* ---------- Автозавантаження за посиланням (?path=&mode=&results=) ---------- */
let autoloading = false;
/* Назва файлу з адреси: останній сегмент шляху без параметрів */
function urlFileName(p) {
  try {
    const seg = new URL(p, location.href).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg) || p;
  } catch (e) { return p; }
}
async function fetchJson(url, what) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    throw new Error(`Не вдалося завантажити ${what}: ${url}. ` +
      (location.protocol === 'file:' ? 'Сторінку відкрито як файл — для параметра path потрібен http(s)-сервер.' : 'Перевірте шлях і CORS.'));
  }
  if (!res.ok) throw new Error(`${what}: сервер відповів ${res.status} (${url}).`);
  try { return await res.json(); } catch (e) { throw new Error(`${what}: некоректний JSON (${e.message}).`); }
}

async function autoload() {
  if (autoloading || !ctx.path || ctx.error) return;
  autoloading = true;
  $('error').textContent = '';
  $('url-status').textContent = 'Завантаження…';
  try {
    const raw = await fetchJson(absUrl(ctx.path), 'тест');
    const prep = prepareTest(raw);
    if (prep.error) throw new Error('Тест: ' + prep.error);
    const data = prep.questions;

    let saved = null;
    if (ctx.results) {
      saved = parseResultsData(data, await fetchJson(absUrl(ctx.results), 'результати'));
      if (saved.error) throw new Error('Результати: ' + saved.error);
      if (saved.mismatch && !confirm(MISMATCH_MSG)) throw new Error('Скасовано: результати не збігаються з тестом.');
    }

    if (ctx.mode === 'error-correction') {
      if (!saved.wrong.length) throw new Error('У цих результатах немає помилок.');
      state = {
        ...newState(data), fileName: urlFileName(ctx.path), mode: 'review', old: saved.old, wrong: saved.wrong,
        current: saved.wrong[0], answers: { ...saved.old }
      };
    } else {
      state = newState(data);
      state.fileName = urlFileName(ctx.path);
      if (saved) { state.answers = { ...saved.old }; state.current = saved.current; state.timer = saved.timer; }
    }
    resetTransient();
    saveState();
    $('url-status').textContent = '';
    render();
  } catch (e) {
    $('url-status').textContent = '';
    $('error').textContent = e.message;
  } finally {
    autoloading = false;
  }
}
$('btn-autoload').onclick = autoload;

/* ---------- Сейви на початковому екрані ---------- */
function renderSaves() {
  const list = $('saves-list');
  list.innerHTML = '';
  const s = readSaves();
  $('saves-empty').hidden = s.items.length > 0;
  $('btn-saves-clear').hidden = !s.items.length;

  s.items.forEach((it) => {
    const li = el('li', 'save-item');
    const a = el('a', 'save-link', it.name);
    a.href = '?save=' + it.id;
    const meta = readMeta(it.id);
    const info = el('span', 'muted save-info',
      `?save=${it.id}` + (meta ? ` · ${meta.answered}/${meta.total}${meta.finished ? ' · завершено' : ''}` : ' · порожній') +
      (meta && meta.fileName ? ` · 📄 ${meta.fileName}` : ''));

    const copy = el('button', 'secondary small', 'Копіювати посилання');
    copy.onclick = (e) => copyText(saveUrl(it.id), e.currentTarget);

    const rename = el('button', 'secondary small', 'Перейменувати');
    rename.onclick = () => {
      const name = prompt('Нова назва сейву:', it.name);
      if (name === null || !name.trim()) return;
      const cur = readSaves();
      const x = cur.items.find((v) => v.id === it.id);
      if (x) { x.name = name.trim(); writeSaves(cur); }
      render();
    };

    const remove = el('button', 'secondary small', '✕');
    remove.title = 'Прибрати кнопку (збережений прогрес лишається за посиланням ?save=' + it.id + ')';
    remove.onclick = () => {
      if (!confirm(`Прибрати кнопку «${it.name}»? Прогрес не видаляється, сейв відкриється за посиланням ?save=${it.id}.`)) return;
      const cur = readSaves();
      cur.items = cur.items.filter((v) => v.id !== it.id);
      writeSaves(cur);
      render();
    };

    li.append(a, info, copy, rename, remove);
    list.appendChild(li);
  });
}

$('btn-save-create').onclick = () => {
  createSave($('save-name').value);
  $('save-name').value = '';
  render();
};
$('save-name').onkeydown = (e) => { if (e.key === 'Enter') $('btn-save-create').click(); };

$('btn-saves-clear').onclick = () => {
  if (!confirm('Видалити всі кнопки-сейви? Збережений прогрес НЕ видаляється: його можна відкрити за посиланням ?save=N.')) return;
  const cur = readSaves();
  cur.items = [];
  writeSaves(cur);
  render();
};

/* ---------- Повне очищення localStorage ---------- */
function wipeAll() {
  if (!confirm('Стерти ВЕСЬ localStorage цього сайту?\n\nБуде видалено прогрес усіх сейвів і посилань, усі кнопки-сейви та всі збережені тести ' +
               '(а також дані інших сторінок на цьому самому домені). Дію не можна скасувати.')) return;
  try { localStorage.clear(); } catch (e) {}
  state = newState();
  resetTransient();
  checked = false;
  $('save-warning').hidden = true;
  $('error').textContent = '';
  $('file-input').value = '';
  render();
}
$('btn-wipe').onclick = wipeAll;
$('btn-wipe-main').onclick = wipeAll;

restoreState();
render();
if (!state.questions.length) {
  if (ctx.error) $('error').textContent = ctx.error;
  else if (ctx.path) autoload();
}

/* Маркер збірки: має збігатися з версією в index.html */
$('js-ver').textContent = '20261006d';
