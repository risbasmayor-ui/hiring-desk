(() => {
  const main = document.querySelector('#main');
  const dialog = document.querySelector('#profile');
  const form = document.querySelector('#profile-form');
  const sidebar = document.querySelector('#sidebar');
  const navToggle = document.querySelector('#nav-toggle');
  const navBackdrop = document.querySelector('#nav-backdrop');
  const importInput = document.querySelector('#import-file');

  const STORAGE_KEY = 'ms-l2-hiring-v1';
  const statuses = ['Not tested', 'Partial', 'Passed', 'Failed'];
  const stages = ['New', 'Technical screening', 'Interview with Aries', 'HR review', 'Closed'];
  const points = { Passed: 100, Partial: 50, Failed: 0 };

  let settings = {edits:{}, custom:[], templates:[]};
  let settingsRevision = null;
  let candidates = [];
  let client;
  let user;
  let revisions = new Map();
  let savedSnapshots = new Map();
  let writeTimer;
  let queue = Promise.resolve();
  let failed = false;
  let pendingWrites = 0;
  let dirty = false;
  let view = 'pipeline';
  let selected = '';
  let tab = 'interview';
  let filter = 'all';
  let editing = '';
  let selecting = false;
  let picks = ['', ''];
  let lastFocusBeforeDialog = null;

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
    );

  const percent = (x) => (x == null ? '—' : `${Math.round(x)}%`);

  const answer = (c, id) => c.answers[id] || { status: 'Not tested', note: '' };

  function loadCandidates() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.map(normalizeCandidate);
    } catch {
      return [];
    }
  }

  function normalizeCandidate(c) {
    const candidate = {
      id: c.id || crypto.randomUUID(),
      name: c.name || '',
      role: c.role || '',
      date: c.date || '',
      interviewer: c.interviewer || '',
      notes: c.notes || '',
      stage: stages.includes(c.stage) ? c.stage : 'New',
      assessment: c.assessment || '',
      feedback: typeof c.feedback === 'string' ? c.feedback : null,
      answers: c.answers && typeof c.answers === 'object' ? c.answers : {},
      selectedQuestions: Array.isArray(c.selectedQuestions) ? c.selectedQuestions : null,
    };
    // Earlier versions preselected the entire bank. Keep recorded answers visible.
    if (
      !candidate.selectedQuestions ||
      candidate.selectedQuestions.length === questions.length
    ) {
      candidate.selectedQuestions = Object.keys(candidate.answers).filter((id) => {
        const response = candidate.answers[id];
        return (
          response &&
          (response.status !== 'Not tested' || (response.note || '').trim())
        );
      });
    }
    return candidate;
  }

  function save() {
    if (!user) return;
    dirty = true;
    localStorage.setItem('hiring-desk-pending-' + user.id, JSON.stringify(candidates));
    clearTimeout(writeTimer);
    writeTimer = setTimeout(syncCandidates, 600);
  }

  function syncCandidates() {
    if (!user || failed || !dirty) return queue;
    dirty = false;
    const snapshot = JSON.parse(JSON.stringify(candidates));
    const account = user.id;
    pendingWrites++;
    queue = queue.then(async () => {
      const ids = new Set(snapshot.map(c => c.id));
      for (const [id, revision] of revisions) {
        if (ids.has(id)) continue;
        const result = await client.from('hiring_candidates').delete().eq('owner_id', account).eq('id', id).eq('revision', revision).select('id');
        if (result.error || !result.data.length) throw new Error('A record changed elsewhere. Your local changes are kept in this browser.');
        revisions.delete(id);
        savedSnapshots.delete(id);
      }
      for (const candidate of snapshot) {
        const data = JSON.stringify(candidate);
        if (savedSnapshots.get(candidate.id) === data) continue;
        const revision = revisions.get(candidate.id);
        let result;
        if (revision === undefined) {
          result = await client.from('hiring_candidates').insert({owner_id:account,id:candidate.id,data:candidate}).select('revision');
        } else {
          result = await client.from('hiring_candidates').update({data:candidate,revision:revision+1,updated_at:new Date().toISOString()}).eq('owner_id',account).eq('id',candidate.id).eq('revision',revision).select('revision');
        }
        if (result.error || !result.data.length) throw new Error('Could not save. A record may have changed on another device. Your local changes are kept in this browser.');
        revisions.set(candidate.id,result.data[0].revision);
        savedSnapshots.set(candidate.id,data);
      }
      if (!dirty && pendingWrites === 1 && !failed) localStorage.removeItem('hiring-desk-pending-' + account);
      toast('Changes saved');
    }).catch(error => {
      failed = true;
      toast(error.message);
      alert(error.message);
    }).finally(() => { pendingWrites--; });
    return queue;
  }

  async function saveSettings() {
    pendingWrites++;
    try {
      let result;
      if (settingsRevision === null) {
        result = await client.from('hiring_settings').insert({owner_id:user.id,data:settings}).select('revision');
      } else {
        result = await client.from('hiring_settings').update({data:settings,revision:settingsRevision+1}).eq('owner_id',user.id).eq('revision',settingsRevision).select('revision');
      }
      if (result.error || !result.data.length) throw new Error('Could not save questions or templates. They may have changed on another device. Export your candidate records and reload.');
      settingsRevision = result.data[0].revision;
      toast('Changes saved');
    } catch (error) {
      failed = true;
      alert(error.message);
    } finally { pendingWrites--; }
  }

  window.addEventListener('beforeunload', event => {
    if (dirty || failed || pendingWrites) {event.preventDefault(); event.returnValue = '';}
  });

  function toast(message) {
    document.querySelectorAll('.toast').forEach((el) => el.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  function assess(c) {
    const rows = questions
      .filter((q) => (c.selectedQuestions || []).includes(q[0]))
      .map(([id, group, title]) => ({ id, group, title, ...answer(c, id) }));
    const verified = rows.filter((r) => r.status !== 'Not tested' && r.note.trim());
    const ratings = groups.map((_, i) => {
      const subset = verified.filter((r) => r.group === i);
      return subset.length
        ? subset.reduce((sum, r) => sum + points[r.status], 0) / subset.length
        : null;
    });
    const weight = groups.reduce((sum, [, w], i) => sum + (ratings[i] === null ? 0 : w), 0);
    const score = weight
      ? groups.reduce((sum, [, w], i) => sum + (ratings[i] ?? 0) * w, 0) / weight
      : null;
    const ready = weight >= 80 && ratings[0] !== null && ratings[1] !== null;
    const proceed =
      ready && Math.round(score) >= 70 && ratings[0] >= 50 && ratings[1] >= 50;
    return {
      rows,
      verified,
      ratings,
      weight,
      score,
      ready,
      proceed,
      label: !ready ? 'Evidence pending' : proceed ? 'Proceed' : 'Not recommended',
    };
  }

  function pill(label, style = '') {
    return `<span class="pill ${style}">${esc(label)}</span>`;
  }

  function hero(label, title, body, action = '') {
    return `<header class="hero"><div><div class="eyebrow">${label}</div><h1>${title}</h1><p>${body}</p></div>${action}</header>`;
  }

  function scoreRing(score) {
    if (score == null) {
      return `<div class="score-ring null" aria-label="No score yet">—</div>`;
    }
    const pct = Math.max(0, Math.min(100, Math.round(score)));
    return `<div class="score-ring" style="--pct:${pct}" aria-label="Weighted score ${pct}%">${pct}%</div>`;
  }

  function coverageBar(weight, label) {
    const w = Math.max(0, Math.min(100, weight || 0));
    return `<div class="progress-block">
      <div class="row between"><span class="muted">${esc(label)}</span><strong>${w}%</strong></div>
      <div class="progress-bar" role="progressbar" aria-valuenow="${w}" aria-valuemin="0" aria-valuemax="100" aria-label="Evidence coverage"><i style="width:${w}%"></i></div>
    </div>`;
  }

  function closeMobileNav() {
    sidebar.classList.remove('open');
    document.body.classList.remove('nav-open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'Open navigation');
    navBackdrop.hidden = true;
  }

  function openMobileNav() {
    sidebar.classList.add('open');
    document.body.classList.add('nav-open');
    navToggle.setAttribute('aria-expanded', 'true');
    navToggle.setAttribute('aria-label', 'Close navigation');
    navBackdrop.hidden = false;
  }

  function pipeline() {
    const results = candidates.map(assess);
    return (
      hero(
        'Technical screening',
        'MS L2 hiring workspace',
        'Screen candidates before scheduling the next interview with Aries.',
        '<button type="button" class="primary" data-action="add">＋ Add candidate</button>'
      ) +
      `<div class="metrics">
        <div class="metric"><strong>${candidates.length}</strong><span>Candidates</span></div>
        <div class="metric accent-pending"><strong>${results.filter((r) => !r.ready).length}</strong><span>Evidence pending</span></div>
        <div class="metric accent-good"><strong>${results.filter((r) => r.proceed).length}</strong><span>Recommended to proceed</span></div>
      </div>
      <section class="panel">
        <div class="row between">
          <h2>Candidate pipeline</h2>
          <div class="toolbar">
            ${candidates.length > 1 ? '<button type="button" data-view="compare">Compare</button>' : ''}
            ${candidates.length ? '<button type="button" data-action="export">Export JSON</button>' : ''}
          </div>
        </div>
        ${
          candidates.length
            ? `<div class="table"><table>
                <thead><tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">Stage</th><th scope="col">Screening date</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Coverage</th>
                  <th scope="col">Score</th>
                  <th scope="col">Recommendation</th>
                  <th scope="col"><span class="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>${candidates
                  .map((c, i) => {
                    const r = results[i];
                    const style = r.ready ? (r.proceed ? 'good' : 'bad') : 'pending';
                    return `<tr>
                      <td><b>${esc(c.name)}</b><div class="muted">${esc(c.role) || '—'}</div></td>
                      <td>${esc(c.stage || 'New')}</td><td>${esc(c.date) || '—'}</td>
                      <td>${r.verified.length} / ${r.rows.length}</td>
                      <td style="min-width:120px">${coverageBar(r.weight, 'Weight')}</td>
                      <td>${percent(r.score)}</td>
                      <td>${pill(r.label, style)}</td>
                      <td><button type="button" data-open="${c.id}">Open screening</button></td>
                    </tr>`;
                  })
                  .join('')}</tbody>
              </table></div>`
            : `<div class="empty">
                <div class="empty-icon" aria-hidden="true">▤</div>
                <h3>No candidates yet</h3>
                <p class="muted">Add a candidate to start their technical screening against the MS L2 question bank.</p>
                <button type="button" class="primary" data-action="add">Add first candidate</button>
              </div>`
        }
      </section>`
    );
  }

  function filterMarkup() {
    return `<div class="filter-bar"><label>Competency
      <select data-filter aria-label="Filter by competency">
        <option value="all">All competencies</option>
        ${groups
          .map(
            ([label], i) =>
              `<option value="${i}" ${filter === String(i) ? 'selected' : ''}>${esc(label)}</option>`
          )
          .join('')}
      </select>
    </label></div>`;
  }

  function questionList(c) {
    const available = c
      ? questions.filter((q) => (c.selectedQuestions || []).includes(q[0]))
      : questions;
    const controls = c
      ? `<div class="panel">${selecting ? `<label>Apply template <select data-template><option value="">Choose a template</option>${settings.templates.map((t,i)=>`<option value="${i}">${esc(t.name)}</option>`).join('')}</select></label><button type="button" data-action="save-template">Save current selection as template</button>` : ''}
          <div class="row between">
            <div>
              <h2>${selecting ? 'Choose questions' : 'Interview questionnaire'}</h2>
              <p class="hint">${selecting ? 'Select a competency, then tick questions to include.' : `${available.length} question${available.length === 1 ? '' : 's'} selected · changes save as you type`}</p>
            </div>
            <button type="button" class="primary" data-action="choose-questions">${selecting ? 'Done selecting' : 'Choose questions'}</button>
          </div>
          ${
            selecting
              ? `<div class="row tabs competency" role="tablist" aria-label="Competencies">${groups
                  .map(
                    ([name], i) =>
                      `<button type="button" role="tab" aria-selected="${filter === String(i)}" data-competency="${i}" class="${filter === String(i) ? 'active' : ''}">${esc(name)}</button>`
                  )
                  .join('')}</div>`
              : ''
          }
        </div>`
      : `<div class="panel">${filterMarkup()}<button data-action="add-question">Add question</button></div>`;

    const visible = c
      ? selecting
        ? questions.filter((q) => String(q[1]) === filter)
        : available
      : questions.filter((q) => filter === 'all' || String(q[1]) === filter);

    const emptySelect =
      c && !selecting && !visible.length
        ? `<div class="panel empty">
            <div class="empty-icon" aria-hidden="true">▥</div>
            <h3>No questions selected</h3>
            <p class="muted">Choose questions from the bank to build this candidate’s questionnaire.</p>
            <button type="button" class="primary" data-action="choose-questions">Choose questions</button>
          </div>`
        : '';

    const bankEmpty =
      !c && !visible.length
        ? `<div class="panel empty"><h3>No questions in this filter</h3><p class="muted">Try another competency.</p></div>`
        : '';

    return (
      controls +
      emptySelect +
      bankEmpty +
      visible
        .map(([id, group, title, prompt, expected]) => {
          const a = c ? answer(c, id) : null;
          const checked = c && (c.selectedQuestions || []).includes(id);
          return `<article class="question">
            ${
              c && selecting
                ? `<label class="select-row"><input type="checkbox" data-select-question value="${id}" ${checked ? 'checked' : ''}> Include in this candidate’s questionnaire</label>`
                : ''
            }
            <div class="eyebrow">${esc(groups[group][0])}</div>
            <h3>${esc(title)}</h3>
            ${!c ? `<button type="button" data-edit-question="${esc(id)}">Edit question</button>` : ''}
            <p>${esc(prompt)}</p>
            <details>
              <summary>Expected answer</summary>
              <p>${esc(expected)}</p>
            </details>
            ${
              a && !selecting
                ? `<div class="fields" data-question="${id}">
                    <label>Result
                      <select data-status aria-label="Result for ${esc(title)}">${statuses
                        .map((s) => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`)
                        .join('')}</select>
                    </label>
                    <label>Observed evidence
                      <textarea data-note rows="2" placeholder="What did the candidate say or demonstrate?" aria-label="Evidence for ${esc(title)}">${esc(a.note)}</textarea>
                    </label>
                  </div>`
                : ''
            }
          </article>`;
        })
        .join('')
    );
  }

  function evidenceSummary(r) {
    const list = (title, items, empty) =>
      `<section class="panel"><h3>${title}</h3>${
        items.length
          ? `<ul class="list">${items.map((el) => `<li>${el}</li>`).join('')}</ul>`
          : `<p class="muted">${empty}</p>`
      }</section>`;
    return (
      list(
        'Observed strengths',
        r.verified
          .filter((a) => a.status === 'Passed')
          .map((a) => `<b>${esc(a.title)}</b> · ${esc(a.note.trim())}`),
        'No passed answers with evidence yet.'
      ) +
      list(
        'Observed gaps',
        r.verified
          .filter((a) => a.status !== 'Passed')
          .map((a) => `<b>${esc(a.title)}</b> · ${a.status} · ${esc(a.note.trim())}`),
        'No partial or failed answers with evidence yet.'
      ) +
      list(
        'Missing or untested evidence',
        r.rows
          .filter((a) => !r.verified.includes(a))
          .map(
            (a) =>
              `${esc(a.title)} · ${a.status === 'Not tested' ? 'Not tested' : 'Rating recorded without notes'}`
          ),
        'All questions have a rating and evidence note.'
      )
    );
  }

  function draft(c, r) {
    const summarize = (items) =>
      items
        .map((a) => `${a.title} (${a.status}) — ${a.note.trim().replace(/\s+/g, ' ')}`)
        .join('\n• ');
    const strengths = summarize(r.verified.filter((a) => a.status === 'Passed'));
    const gaps = summarize(r.verified.filter((a) => a.status !== 'Passed'));
    const untested = r.rows.filter((a) => a.status === 'Not tested').length;
    const missing = r.rows.length - r.verified.length - untested;
    const missingGroups = groups.filter((_, i) => r.ratings[i] === null && r.rows.some((row) => row.group === i)).map(([name]) => name);
    const next = !r.ready
      ? 'Complete the screening evidence before making a recommendation.'
      : r.proceed
        ? 'Proceed to an interview with Aries.'
        : 'Not recommended for the MS L2 Engineer role based on the current screening evidence.';
    return `${c.name} | ${c.role || 'MS L2 Engineer'} technical screening

${r.score === null ? 'No scored evidence yet.' : `Weighted score ${percent(r.score)} across ${r.weight}% of competency weight.`} ${r.verified.length}/${r.rows.length} selected questions have evidence.

Strengths
${strengths ? '• ' + strengths : 'No passed answers with evidence recorded.'}

Gaps
${gaps ? '• ' + gaps : 'No partial or failed answers with evidence recorded.'}

Evidence still open
${untested} untested. ${missing} rated without notes.${missingGroups.length ? ' Competencies without scored evidence include ' + missingGroups.join(', ') + '.' : ''}

Recommendation
${next}`;
  }

  function scoreTable(r) {
    return `<div class="table"><table>
      <thead><tr><th scope="col">Competency</th><th scope="col">Weight</th><th scope="col">Score</th><th scope="col">Evidence</th></tr></thead>
      <tbody>${groups
        .map(([name, w], i) => {
          const verifiedCount = r.verified.filter((a) => a.group === i).length;
          const rowCount = r.rows.filter((a) => a.group === i).length;
          return `<tr>
            <td>${esc(name)}</td>
            <td>${w}%</td>
            <td>${percent(r.ratings[i])}</td>
            <td>${verifiedCount} / ${rowCount}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table></div>`;
  }

  function snapshot(c, r) {
    const style = r.ready ? (r.proceed ? 'good' : 'bad') : 'pending';
    return `<div class="score-header panel">
        ${scoreRing(r.score)}
        <div class="meta">
          <div class="row between" style="margin-bottom:8px">
            <h2>Screening snapshot</h2>
            ${pill(r.label, style)}
          </div>
          ${coverageBar(r.weight, 'Competency weight covered')}
          <p class="hint">${r.verified.length}/${r.rows.length} selected questions scored with evidence · Routing &amp; Switching and Firewall &amp; Security required for a recommendation</p>
        </div>
        <button type="button" class="danger" data-action="delete" ${candidates.length ? '' : 'hidden'}>Delete candidate</button>
      </div>`;
  }

  function refreshSnapshot(c) {
    const header = main.querySelector('.score-header');
    if (header) header.outerHTML = snapshot(c, assess(c));
  }

  function candidate() {
    const c = candidates.find((item) => item.id === selected);
    if (!c) {
      view = 'pipeline';
      return pipeline();
    }
    const r = assess(c);
    const style = r.ready ? (r.proceed ? 'good' : 'bad') : 'pending';
    const meta = [c.role, c.date, c.interviewer].filter(Boolean).map(esc).join(' · ') || 'MS L2 Engineer';

    return (
      `<div class="top"><button type="button" data-view="pipeline">← Candidates</button></div>` +
      hero('Candidate screening', esc(c.name), meta, '<button type="button" data-action="edit">Edit profile</button>') +
      (c.notes
        ? `<div class="panel"><h3>Profile notes</h3><p class="muted">Candidate background and claims to validate</p><pre>${esc(c.notes)}</pre></div>`
        : '') +
      `<section class="panel"><label>Screening stage
        <select data-stage>${stages.map(stage => `<option ${stage === (c.stage || 'New') ? 'selected' : ''}>${esc(stage)}</option>`).join('')}</select>
      </label><label>Interviewer assessment
        <textarea data-assessment rows="4" placeholder="Relevant experience, strengths, gaps, and areas for Aries to validate">${esc(c.assessment || '')}</textarea>
      </label></section>` +
      snapshot(c, r) +
      `<div class="row tabs" role="tablist" aria-label="Candidate views">${[
        ['interview', 'Interview'],
        ['evidence', 'Score & evidence'],
        ['feedback', 'HR feedback'],
      ]
        .map(
          ([id, t]) =>
            `<button type="button" role="tab" aria-selected="${tab === id}" class="${tab === id ? 'active' : ''}" data-tab="${id}">${t}</button>`
        )
        .join('')}</div>` +
      (tab === 'interview'
        ? '<p class="top muted">Changes save as you type. Add an observation note to include a rating in the score.</p>' +
          questionList(c)
        : tab === 'evidence'
          ? `<section class="panel">
              <div class="row between"><h2>${percent(r.score)} weighted score</h2>${pill(r.label, style)}</div>
              <p class="muted">${r.weight}% of competency weight covered · ${r.verified.length}/${r.rows.length} selected questions scored</p>
              ${scoreTable(r)}
            </section>` + evidenceSummary(r)
          : `<section class="panel">
              <div class="row between">
                <h2>Draft for HR</h2>
                <button type="button" data-action="regenerate-feedback">Regenerate draft</button> <button type="button" data-action="print-feedback">Print / save PDF</button> <button type="button" class="primary" data-action="copy">Copy feedback</button>
              </div>
              <p class="hint">Edit the draft before sharing. Changes are saved with this candidate.</p>
              <label>Feedback<textarea id="feedback" class="feedback">${esc(c.feedback === null || c.feedback === undefined ? draft(c, r) : c.feedback)}</textarea></label>
              <p class="hint feedback-state" aria-live="polite"></p>
            </section>`)
    );
  }

  function comparison() {
    const header = hero(
      'Technical screening',
      'Compare candidates',
      'Review scores alongside evidence coverage and question outcomes.'
    );
    if (candidates.length < 2) {
      return (
        header +
        `<section class="panel empty">
          <div class="empty-icon" aria-hidden="true">◫</div>
          <h3>Need at least two candidates</h3>
          <p class="muted">Add another candidate to compare scores and evidence side by side.</p>
          <button type="button" data-view="pipeline">Back to candidates</button>
        </section>`
      );
    }
    if (!picks[0] || !candidates.find((c) => c.id === picks[0])) {
      picks = [candidates[0].id, candidates[1].id];
    }
    if (!picks[1] || !candidates.find((c) => c.id === picks[1]) || picks[1] === picks[0]) {
      picks[1] = candidates.find((c) => c.id !== picks[0])?.id || candidates[1].id;
    }
    const pair = picks.map((id) => candidates.find((c) => c.id === id));
    const evaluations = pair.map(assess);
    const row = (label, values) =>
      `<tr><th scope="row">${label}</th>${values.map((v) => `<td>${v}</td>`).join('')}</tr>`;

    return (
      header +
      `<section class="panel">
        <div class="compare-picks">${picks
          .map(
            (id, i) =>
              `<label>Candidate ${i + 1}
                <select data-pick="${i}" aria-label="Select candidate ${i + 1}">
                  ${candidates
                    .map(
                      (c) =>
                        `<option value="${c.id}" ${c.id === id ? 'selected' : ''} ${c.id === picks[1 - i] ? 'disabled' : ''}>${esc(c.name)}</option>`
                    )
                    .join('')}
                </select>
              </label>`
          )
          .join('')}</div>
        <div class="table"><table>
          <thead><tr><th scope="col">Screening</th>${pair.map((c) => `<th scope="col">${esc(c.name)}</th>`).join('')}</tr></thead>
          <tbody>
            ${row('Weighted score', evaluations.map((r) => percent(r.score)))}
            ${row(
              'Evidence coverage',
              evaluations.map(
                (r) => `${r.weight}% of weight · ${r.verified.length}/${r.rows.length} selected questions`
              )
            )}
            ${row(
              'Recommendation',
              evaluations.map((r) =>
                pill(r.label, r.ready ? (r.proceed ? 'good' : 'bad') : 'pending')
              )
            )}
            ${groups
              .map(([n], i) =>
                row(
                  esc(n),
                  evaluations.map((r) =>
                    r.ratings[i] === null
                      ? 'No scored evidence'
                      : `${percent(r.ratings[i])} · ${r.verified.filter((a) => a.group === i).length} scored`
                  )
                )
              )
              .join('')}
          </tbody>
        </table></div>
      </section>
      <section class="panel">
        <h2>Question evidence</h2>
        <div class="table"><table>
          <thead><tr><th scope="col">Question</th>${pair.map((c) => `<th scope="col">${esc(c.name)}</th>`).join('')}</tr></thead>
          <tbody>
            ${questions
              .map(([id, , title]) =>
                row(
                  esc(title),
                  pair.map((c) => {
                    const a = answer(c, id);
                    if (a.status === 'Not tested') return 'Not tested';
                    return a.note.trim()
                      ? `<b>${a.status}</b><div>${esc(a.note)}</div>`
                      : `${a.status} · No evidence note`;
                  })
                )
              )
              .join('')}
          </tbody>
        </table></div>
      </section>`
    );
  }

  function rubric() {
    return (
      hero(
        'Technical screening',
        'Scoring rubric',
        'Use the same evidence standard for every candidate.'
      ) +
      `<section class="panel">
        <h2>Question ratings</h2>
        <ul class="list">
          <li><b>Passed · 100</b> — Demonstrated a sound approach and relevant validation.</li>
          <li><b>Partial · 50</b> — Identified some correct checks but missed important steps or reasoning.</li>
          <li><b>Failed · 0</b> — Attempted the question and could not demonstrate the required approach.</li>
          <li><b>Not tested · excluded</b> — The question was skipped. Ratings without an observation are also excluded.</li>
        </ul>
      </section>
      <section class="panel">
        <h2>Competency weights</h2>
        <ul class="list">${groups.map(([n, w]) => `<li>${esc(n)} · ${w}%</li>`).join('')}</ul>
        <p>Each competency averages its scored questions. The overall score is the weighted average across competencies with evidence. Coverage shows how much of the full rubric was scored.</p>
      </section>
      <section class="panel">
        <h2>Recommendation rules</h2>
        <p>Evidence stays pending until at least 80% of the competency weight is covered, including Routing &amp; Switching and Firewall &amp; Security. Proceed requires a displayed score of at least 70% and scores of at least 50% in both of those competencies. Otherwise, the recommendation is Not recommended once coverage is sufficient. Review the notes before deciding whether to schedule with Aries.</p>
      </section>`
    );
  }

  function bankView() {
    return (
      hero(
        'Interviewer resources',
        'Question bank',
        `${questions.length} reusable prompts and expected answers across seven competencies.`
      ) + questionList()
    );
  }

  function render() {
    document.querySelectorAll('.nav-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === (view === 'candidate' ? 'pipeline' : view))
    );
    const views = {
      pipeline,
      candidate,
      compare: comparison,
      rubric,
      bank: bankView,
    };
    main.innerHTML = views[view]();
    closeMobileNav();
  }

  function focusFirstDialogField() {
    const first = form.querySelector('input, textarea, button');
    first?.focus();
  }

  function profile(c) {
    editing = c?.id || '';
    lastFocusBeforeDialog = document.activeElement;
    document.querySelector('#form-title').textContent = c ? 'Edit candidate' : 'Add candidate';
    form.reset();
    if (c) {
      for (const field of form.querySelectorAll('[name]')) {
        field.value = c[field.name] || '';
      }
    }
    dialog.showModal();
    focusFirstDialogField();
  }

  function exportCandidates() {
    const blob = new Blob([JSON.stringify(candidates, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ms-l2-candidates-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`);
  }

  function importCandidates(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.candidates)
            ? data.candidates
            : null;
        if (!list) throw new Error('Expected a JSON array of candidates');
        const existing = new Set(candidates.map((c) => c.id));
        let added = 0;
        let updated = 0;
        for (const raw of list) {
          if (!raw || typeof raw !== 'object') continue;
          const next = normalizeCandidate(raw);
          if (!next.name) continue;
          const idx = candidates.findIndex((c) => c.id === next.id);
          if (idx >= 0) {
            candidates[idx] = next;
            updated++;
          } else if (existing.has(next.id)) {
            continue;
          } else {
            candidates.push(next);
            existing.add(next.id);
            added++;
          }
        }
        save();
        render();
        toast(`Import complete: ${added} added, ${updated} updated`);
      } catch (err) {
        toast(err.message || 'Could not import that file');
      }
    };
    reader.readAsText(file);
  }

  document.querySelector('#cancel').addEventListener('click', () => {
    dialog.close();
  });

  dialog.addEventListener('close', () => {
    if (lastFocusBeforeDialog && typeof lastFocusBeforeDialog.focus === 'function') {
      lastFocusBeforeDialog.focus();
    }
    lastFocusBeforeDialog = null;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(
      Array.from(new FormData(form), ([k, v]) => [k, String(v).trim()])
    );
    if (!data.name) {
      form.elements.name.focus();
      return;
    }
    const c = editing
      ? candidates.find((item) => item.id === editing)
      : {
          id: crypto.randomUUID(),
          answers: {},
          selectedQuestions: [],
        };
    Object.assign(c, data);
    if (!editing) candidates.push(c);
    save();
    dialog.close();
    if (!editing) {
      selected = c.id;
      view = 'candidate';
      tab = 'interview';
      filter = 'all';
    }
    render();
  });

  navToggle.addEventListener('click', () => {
    if (sidebar.classList.contains('open')) closeMobileNav();
    else openMobileNav();
  });

  navBackdrop.addEventListener('click', closeMobileNav);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebar.classList.contains('open')) {
      closeMobileNav();
    }
  });

  document.addEventListener('click', async (event) => {
    const b = event.target.closest('button');
    if (!b) return;

    if (b.dataset.view) {
      view = b.dataset.view;
      filter = 'all';
      selecting = false;
      render();
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    }
    if (b.dataset.open) {
      selected = b.dataset.open;
      view = 'candidate';
      tab = 'interview';
      filter = 'all';
      selecting = false;
      render();
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    }
    if (b.dataset.tab) {
      tab = b.dataset.tab;
      render();
    }
    if (b.dataset.action === 'add-question' || b.dataset.editQuestion) {
      const old = b.dataset.editQuestion ? questions.find(q => q[0] === b.dataset.editQuestion) : null;
      const groupText = prompt('Competency number: ' + groups.map((g,i)=>`${i+1}. ${g[0]}`).join('  '), old ? String(old[1]+1) : '1');
      if (groupText === null) return;
      const group = Number(groupText)-1;
      if (!Number.isInteger(group) || group < 0 || group >= groups.length) {alert('Choose a valid competency number.'); return;}
      const title = prompt('Question title', old?.[2] || '');
      if (title === null) return;
      const promptText = prompt('Interview question', old?.[3] || '');
      if (promptText === null) return;
      const expected = prompt('Expected answer', old?.[4] || '');
      if (expected === null) return;
      if (![title,promptText,expected].every(v=>v.trim())) {alert('Complete every field.'); return;}
      const id = old?.[0] || crypto.randomUUID();
      const next = [id,group,title.trim(),promptText.trim(),expected.trim()];
      if (old) {
        const customIndex = settings.custom.findIndex(q=>q[0] === id);
        if (customIndex >= 0) settings.custom[customIndex] = next;
        else settings.edits[id] = next;
      } else settings.custom.push(next);
      const existingIndex = questions.findIndex(q=>q[0] === id);
      if (existingIndex >= 0) questions.splice(existingIndex,1,next); else questions.push(next);
      await saveSettings(); render();
    }
    if (b.dataset.action === 'save-template') {
      const c = candidates.find(item=>item.id===selected);
      if (!c.selectedQuestions.length) {alert('Select at least one question first.'); return;}
      const name = prompt('Template name');
      if (!name?.trim()) return;
      settings.templates.push({name:name.trim(),questions:[...c.selectedQuestions]});
      await saveSettings(); render();
    }
    if (b.dataset.action === 'add') profile();
    if (b.dataset.action === 'edit') profile(candidates.find((item) => item.id === selected));
    if (b.dataset.action === 'choose-questions') {
      selecting = !selecting;
      filter = selecting ? '0' : 'all';
      render();
    }
    if (b.dataset.competency !== undefined) {
      filter = b.dataset.competency;
      render();
    }
    if (b.dataset.action === 'export') exportCandidates();
    if (b.dataset.action === 'import-browser') {
      const existing = new Set(candidates.map(c => c.id));
      const prior = loadCandidates().filter(c => !existing.has(c.id));
      candidates.push(...prior);
      if (prior.length) save();
      render();
      toast(prior.length + ' browser records added');
    }
    if (b.dataset.action === 'sign-out') {
      if (dirty || failed || pendingWrites) { alert('Save pending changes before signing out.'); return; }
      await queue;
      if (failed) return;
      await client.auth.signOut();
      location.reload();
    }
    if (b.dataset.action === 'delete') {
      const c = candidates.find((item) => item.id === selected);
      if (!c) return;
      if (!confirm(`Delete ${c.name}? This cannot be undone.`)) return;
      candidates = candidates.filter((item) => item.id !== selected);
      save();
      selected = '';
      view = 'pipeline';
      render();
      toast('Candidate deleted');
    }
    if (b.dataset.action === 'regenerate-feedback') {
      const candidate = candidates.find(item => item.id === selected);
      if (candidate.feedback && !confirm('Replace the saved feedback with a new draft?')) return;
      candidate.feedback = draft(candidate, assess(candidate));
      save(); render();
    }
    if (b.dataset.action === 'print-feedback') {
      const popup = window.open('', '_blank');
      if (!popup) {alert('Allow pop-ups to print the feedback.'); return;}
      popup.document.write('<!doctype html><title>HR feedback</title><style>body{font:15px/1.5 system-ui;margin:40px;white-space:pre-wrap}</style>' + esc(document.querySelector('#feedback').value));
      popup.document.close();
      popup.focus(); popup.print();
    }
    if (b.dataset.action === 'copy') {
      const field = document.querySelector('#feedback');
      const state = document.querySelector('.feedback-state');
      try {
        await navigator.clipboard.writeText(field.value);
        state.textContent = 'Copied to clipboard.';
      } catch {
        field.focus();
        field.select();
        state.textContent = 'Feedback selected. Use your device’s copy command.';
      }
    }
  });

  main.addEventListener('change', (event) => {
    const el = event.target;
    if (el.matches('[data-filter]')) {
      filter = el.value;
      render();
    }
    if (el.matches('[data-pick]')) {
      picks[Number(el.dataset.pick)] = el.value;
      render();
    }
    if (el.matches('[data-status]')) storeAnswer(el);
    if (el.matches('[data-template]') && el.value !== '') {
      const c = candidates.find(item=>item.id===selected);
      const template = settings.templates[Number(el.value)];
      c.selectedQuestions = [...new Set([...c.selectedQuestions,...template.questions.filter(id=>questions.some(q=>q[0]===id))])];
      save(); render();
    }
    if (el.matches('[data-stage]')) {
      candidates.find(item => item.id === selected).stage = el.value;
      save();
    }
    const checkbox = el.closest('[data-select-question]');
    if (checkbox) {
      const c = candidates.find((item) => item.id === selected);
      const set = new Set(c.selectedQuestions || []);
      checkbox.checked ? set.add(checkbox.value) : set.delete(checkbox.value);
      c.selectedQuestions = Array.from(set);
      save();
      const pos = window.scrollY;
      render();
      window.scrollTo(0, pos);
    }
  });

  main.addEventListener('input', (event) => {
    if (event.target.matches('[data-note]')) storeAnswer(event.target);
    if (event.target.matches('[data-assessment]')) {
      candidates.find(item => item.id === selected).assessment = event.target.value;
      save();
    }
    if (event.target.matches('#feedback')) {
      candidates.find(item => item.id === selected).feedback = event.target.value;
      save();
    }
  });

  function storeAnswer(el) {
    const fields = el.closest('[data-question]');
    const c = candidates.find((item) => item.id === selected);
    c.answers[fields.dataset.question] = {
      status: fields.querySelector('[data-status]').value,
      note: fields.querySelector('[data-note]').value,
    };
    save();
    refreshSnapshot(c);
  }

  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (file) importCandidates(file);
    importInput.value = '';
  });

  async function start() {
    if (!window.supabase) {
      main.innerHTML = '<section class="panel"><h2>Unable to load sign-in</h2><p>Check your connection and refresh. Browser records remain on this device.</p></section>';
      return;
    }
    client = window.supabase.createClient('https://leolozdgikkiufybwxjm.supabase.co', 'sb_publishable_peX0Uc2ogkh941xHVH9Zpw_2j3kEjHq');
    const {data, error} = await client.auth.getSession();
    if (error) { alert(error.message); return; }
    if (!data.session) {
      main.innerHTML = `<section class="panel"><h1>Sign in to Hiring Desk</h1><p>Use your hiring workspace account.</p>
        <form id="auth-form"><label>Email <input name="email" type="email" required></label>
        <label>Password <input name="password" type="password" minlength="8" required></label>
        <div class="actions"><button class="primary" type="submit">Sign in</button><button type="button" id="register">Create account</button></div>
        <p id="auth-message" role="status"></p></form></section>`;
      const authForm = document.querySelector('#auth-form');
      async function authenticate(register) {
        const values = new FormData(authForm);
        const credentials = {email:String(values.get('email')),password:String(values.get('password'))};
        const response = register ? await client.auth.signUp(credentials) : await client.auth.signInWithPassword(credentials);
        document.querySelector('#auth-message').textContent = response.error ? response.error.message : register && !response.data.session ? 'Check your email to confirm your account, then sign in.' : 'Signed in.';
        if (response.data?.session) location.reload();
      }
      authForm.addEventListener('submit', event => {event.preventDefault(); authenticate(false);});
      document.querySelector('#register').addEventListener('click', () => {if (authForm.reportValidity()) authenticate(true);});
      return;
    }
    user = data.session.user;
    const result = await client.from('hiring_candidates').select('id,data,revision');
    if (result.error) {main.innerHTML = '<section class="panel"><h2>Unable to load records</h2><p>Refresh to try again. Browser records remain on this device.</p></section>'; return;}
    const settingsResult = await client.from('hiring_settings').select('data,revision').maybeSingle();
    if (settingsResult.error) {main.innerHTML = '<section class="panel"><h2>Unable to load question settings</h2><p>Refresh and try again.</p></section>'; return;}
    if (settingsResult.data) {
      settings = settingsResult.data.data;
      settings.edits ||= {}; settings.custom ||= []; settings.templates ||= [];
      settingsRevision = settingsResult.data.revision;
      for (const [id, question] of Object.entries(settings.edits)) {
        const index = questions.findIndex(q=>q[0]===id);
        if (index >= 0) questions.splice(index,1,question);
      }
      for (const question of settings.custom) {
        if (!questions.some(q=>q[0]===question[0])) questions.push(question);
      }
    }
    candidates = result.data.map(row => normalizeCandidate(row.data));
    revisions = new Map(result.data.map(row => [row.id,row.revision]));
    savedSnapshots = new Map(candidates.map(candidate => [candidate.id,JSON.stringify(candidate)]));
    const pending = localStorage.getItem('hiring-desk-pending-' + user.id);
    if (pending) {
      failed = true;
      main.innerHTML = '<section class="panel"><h2>Unsaved changes found</h2><p>Changes from an earlier session remain in this browser. Export the browser backup before making further changes.</p><button data-action="export-pending">Export pending backup</button> <button data-action="discard-pending">Discard pending backup and load saved records</button></section>';
      document.querySelector('[data-action="export-pending"]').onclick = () => {
        const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([pending],{type:'application/json'})); link.download='hiring-desk-pending.json'; link.click(); URL.revokeObjectURL(link.href);
      };
      document.querySelector('[data-action="discard-pending"]').onclick = () => {
        if (confirm('Discard the unsaved backup? Export it first if you need those changes.')) {
          localStorage.removeItem('hiring-desk-pending-' + user.id);
          location.reload();
        }
      };
      return;
    }
    document.querySelector('.local').innerHTML = '<strong>Account storage</strong> Records are saved to your account. <button type="button" data-action="import-browser">Import browser records</button> <button type="button" data-action="sign-out">Sign out</button>';
    render();
  }
  start();
})();

