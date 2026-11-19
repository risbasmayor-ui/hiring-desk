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

  const starterTemplates = [
    {name:'L2 initial screening',questions:['mpls','ospf','bgp','stp','panorama','ipsec','sdwan','incident','change','fund_subnet','fund_dhcp']},
    {name:'Firewall focused',questions:['panorama','ipsec','web','nat','ha','cert','change']},
    {name:'Routing focused',questions:['mpls','ospf','bgp','stp','routecompare','bgpflap','fund_subnet']},
    {name:'L1 assessment',questions:['fund_vlan','fund_ip','fund_subnet','fund_dhcp','fund_dns','fund_tools','monitor','incident']}
  ];
  let settings = {edits:{}, custom:[], templates:starterTemplates.map(t=>({...t,questions:[...t.questions]}))};
  let settingsRevision = null;
  let settingsQueue = Promise.resolve();
  let workspaceReady = false;
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
  let pipelineFilter = 'all';
  let pipelineSearch = '';
  let pipelineStage = 'all';
  let difficultyFilter = 'all';
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

  const advancedIds = new Set(['ospf','bgpflap','cert','sdwanpolicy','majorincident','rca','redistribution','appid','dos','sase','failedchange','mentoring']);
  const difficultyOf = q => (['Foundation','Core','Advanced'].includes(q?.[5]) ? q[5] : null) || (q?.[1] === 6 || ['vlan','subnet','overlay'].includes(q?.[0]) ? 'Foundation' : advancedIds.has(q?.[0]) ? 'Advanced' : 'Core');

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
      completion: c.completion && typeof c.completion === 'object' ? c.completion : null,
      answers: c.answers && typeof c.answers === 'object' ? c.answers : {},
      selectedQuestions: Array.isArray(c.selectedQuestions) ? c.selectedQuestions : null,
    };
    // Legacy records without an explicit selection retain their answered questions.
    if (!candidate.selectedQuestions) {
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

  function saveSettings() {
    const snapshot = JSON.stringify(settings);
    const backupKey = 'hiring-desk-settings-pending-' + user.id;
    localStorage.setItem(backupKey, snapshot);
    pendingWrites++;
    settingsQueue = settingsQueue.then(async () => {
      if (failed) throw new Error('An earlier save failed. Your question settings remain in this browser.');
      let result;
      if (settingsRevision === null) {
        result = await client.from('hiring_settings').insert({owner_id:user.id,data:JSON.parse(snapshot)}).select('revision');
      } else {
        result = await client.from('hiring_settings').update({data:JSON.parse(snapshot),revision:settingsRevision+1}).eq('owner_id',user.id).eq('revision',settingsRevision).select('revision');
      }
      if (result.error || !result.data.length) throw new Error('Could not save questions or templates. They may have changed on another device. Your changes remain in this browser.');
      settingsRevision = result.data[0].revision;
      if (localStorage.getItem(backupKey) === snapshot) localStorage.removeItem(backupKey);
      toast('Changes saved');
    }).catch(error => {
      failed = true;
      alert(error.message);
    }).finally(() => { pendingWrites--; });
    return settingsQueue;
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
    if (c.completion) return c.completion.result;
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
    const visible = candidates.map((candidate, index) => ({candidate, result:results[index]}))
      .filter(item => pipelineFilter === 'all' || (pipelineFilter === 'pending' ? item.result.label === 'Evidence pending' : item.result.label === 'Proceed'))
      .filter(({candidate}) => pipelineStage === 'all' || candidate.stage === pipelineStage)
      .filter(({candidate}) => !pipelineSearch || `${candidate.name} ${candidate.role}`.toLowerCase().includes(pipelineSearch.toLowerCase()));
    const filterName = pipelineFilter === 'pending' ? 'Evidence pending' : 'Recommended to proceed';
    return (
      hero(
        'Technical screening',
        'MS L2 hiring workspace',
        'Screen candidates before scheduling the next interview with Aries.',
        '<button type="button" class="primary" data-action="add">＋ Add candidate</button>'
      ) +
      `<div class="metrics">
        <button type="button" class="metric ${pipelineFilter === 'all' ? 'active' : ''}" data-pipeline-filter="all" aria-pressed="${pipelineFilter === 'all'}"><strong>${candidates.length}</strong><span>Candidates</span></button>
        <button type="button" class="metric accent-pending ${pipelineFilter === 'pending' ? 'active' : ''}" data-pipeline-filter="pending" aria-pressed="${pipelineFilter === 'pending'}"><strong>${results.filter((r) => !r.ready).length}</strong><span>Evidence pending</span></button>
        <button type="button" class="metric accent-good ${pipelineFilter === 'proceed' ? 'active' : ''}" data-pipeline-filter="proceed" aria-pressed="${pipelineFilter === 'proceed'}"><strong>${results.filter((r) => r.proceed).length}</strong><span>Recommended to proceed</span></button>
      </div>
      <section class="panel">
        <div class="row between">
          <h2>Candidate pipeline</h2>
          <div class="toolbar">
            ${candidates.length > 1 ? '<button type="button" data-view="compare">Compare</button>' : ''}
            ${candidates.length ? '<button type="button" data-action="export">Export JSON</button>' : ''}
          </div>
        </div>
        <div class="pipeline-filters"><label>Search candidates<input type="search" data-pipeline-search value="${esc(pipelineSearch)}" placeholder="Name or role"></label><label>Stage<select data-stage-filter><option value="all">All stages</option>${stages.map(stage=>`<option value="${esc(stage)}" ${pipelineStage===stage?'selected':''}>${esc(stage)}</option>`).join('')}</select></label>${(pipelineFilter!=='all'||pipelineStage!=='all'||pipelineSearch)?'<button type="button" data-clear-pipeline>Clear filters</button>':''}</div>
        ${pipelineFilter !== 'all' ? `<p class="hint">Showing ${filterName} (${visible.length})</p>` : ''}
        ${
          visible.length
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
                <tbody>${visible
                  .map(({candidate: c, result: r}) => {
                    const style = r.ready ? (r.proceed ? 'good' : 'bad') : 'pending';
                    return `<tr>
                      <td><b>${esc(c.name)}</b> ${c.completion ? pill('Completed', 'good') : ''}<div class="muted">${esc(c.role) || '—'}</div></td>
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
            : candidates.length
              ? `<div class="empty"><h3>No candidates match these filters</h3><button type="button" data-clear-pipeline>Clear filters</button></div>`
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
      ? questions.filter((q) => (c.selectedQuestions || []).includes(q[0])).sort((a, b) => a[1] - b[1])
      : questions;
    const selectedCounts = groups.map((_, group) =>
      available.filter((question) => question[1] === group).length
    );
    const controls = c
      ? `<div class="panel">${selecting ? `<label>Apply template <select data-template><option value="">Choose a template</option>${settings.templates.map((t,i)=>`<option value="${i}">${esc(t.name)}</option>`).join('')}</select></label><button type="button" data-action="save-template">Save current selection as template</button>` : ''}
          <div class="row between">
            <div>
              <h2>${selecting ? 'Choose questions' : 'Interview questionnaire'}</h2>
              <p class="hint">${selecting ? 'Choose 3 questions for each competency you want to assess. A competency currently counts toward the score when at least one answer has a rating and an observation note.' : `${available.length} question${available.length === 1 ? '' : 's'} selected · changes save as you type`}</p>
            </div>
            <button type="button" class="primary" data-action="choose-questions">${selecting ? 'Done selecting' : 'Choose questions'}</button>
          </div>
          ${
            selecting
              ? `<div class="row tabs competency" role="tablist" aria-label="Competencies">${groups
                  .map(([name], i) => {
                    const count = selectedCounts[i];
                    const needed = count > 0 && count < 3 ? ` — ${3 - count} more needed` : '';
                    return `<button type="button" role="tab" aria-selected="${filter === String(i)}" data-competency="${i}" class="${filter === String(i) ? 'active' : ''}">${esc(name)}: ${count} selected${needed}</button>`;
                  })
                  .join('')}</div>`
              : ''
          }
          ${selecting ? `<div class="difficulty-filters" aria-label="Question difficulty">${['all','Foundation','Core','Advanced'].map(level=>`<button type="button" data-difficulty="${level}" aria-pressed="${difficultyFilter===level}">${level==='all'?'All':level}</button>`).join('')}</div>` : ''}
          ${selecting && filter !== 'all' && selectedCounts[Number(filter)] < 3 ? `<p class="hint" role="status">Select ${3 - selectedCounts[Number(filter)]} more question${3 - selectedCounts[Number(filter)] === 1 ? '' : 's'} for ${esc(groups[Number(filter)][0])}.</p>` : ''}
          ${selecting && selectedCounts.some(count => count > 3) ? '<p class="hint" role="status">Some existing competencies have more than 3 questions. These selections are preserved. Remove questions to meet the new limit.</p>' : ''}
        </div>`
      : `<div class="panel">${filterMarkup()}</div>`;

    const visible = c
      ? selecting
        ? questions.filter((q) => String(q[1]) === filter && (difficultyFilter === 'all' || difficultyOf(q) === difficultyFilter))
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
            <h3>${esc(title)} <span class="difficulty-badge">${esc(difficultyOf(questions.find(q=>q[0]===id)))}</span></h3>
            
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
            <td>${verifiedCount} / ${rowCount}${verifiedCount === 1 ? ' · Limited evidence' : ''}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table></div>`;
  }

  function snapshot(c, r) {
    const style = r.ready ? (r.proceed ? 'good' : 'bad') : 'pending';
    const missing = [];
    if (r.weight < 80) missing.push(`coverage needs ${80 - r.weight}% more`);
    if (r.ratings[0] === null) missing.push('Routing evidence required');
    if (r.ratings[1] === null) missing.push('Firewall evidence required');
    const gate = missing.length ? `Coverage ${r.weight}% of 80% needed · ${missing.join(' · ')}` : `Coverage ${r.weight}% · gate met · ${r.label}`;
    const uncovered = groups.filter((_, index) => r.ratings[index] === null).map(([name]) => name);
    const uncoveredNote = r.weight < 80 && uncovered.length
      ? `<p class="hint">Competencies without scored evidence: ${uncovered.map(esc).join(', ')}. You can reach 80% through different combinations.</p>` : '';
    const breakdown = groups.map(([name, weight], index) => {
      const scored = r.verified.filter(item => item.group === index).length;
      const selected = r.rows.filter(item => item.group === index).length;
      const covered = scored > 0;
      return `<li><span>${esc(name)} <strong>${scored}/${selected}</strong> · ${covered ? weight + '% counted' : 'not covered'}</span><span class="competency-progress" role="progressbar" aria-label="${esc(name)} weight covered" aria-valuemin="0" aria-valuemax="${weight}" aria-valuenow="${covered ? weight : 0}"><i style="width:${covered ? 100 : 0}%"></i></span></li>`;
    }).join('');
    return `<div class="score-header panel">
        ${scoreRing(r.score)}
        <div class="meta">
          <div class="row between" style="margin-bottom:8px">
            <h2>Screening snapshot</h2>
            ${pill(r.label, style)}
          </div>
          ${coverageBar(r.weight, 'Competency weight covered')}
          <p class="hint">${r.verified.length}/${r.rows.length} selected questions scored with evidence</p>
          <p class="hint"><strong>${esc(gate)}</strong></p>
          ${uncoveredNote}
          <details><summary>Competency coverage</summary><ul class="coverage-list">${breakdown}</ul></details>
        </div>
        ${tab === 'interview' ? '<button type="button" class="primary" data-action="complete">Complete assessment</button>' : ''}
        <button type="button" class="danger" data-action="delete" ${candidates.length ? '' : 'hidden'}>Delete candidate</button>
      </div>`;
  }

  function refreshSnapshot(c) {
    const header = main.querySelector('.score-header');
    if (header) header.outerHTML = snapshot(c, assess(c));
  }

  function makeCompletion(candidate) {
    const result = assess(candidate);
    const evidence = (candidate.selectedQuestions || []).map(id => {
      const question = questions.find(item => item[0] === id);
      const response = answer(candidate, id);
      return {id, title:question?.[2] || 'Question unavailable', prompt:question?.[3] || '', competency:question ? groups[question[1]][0] : 'Unknown', status:response.status, note:response.note || ''};
    });
    return {
      version: 1,
      completedAt: new Date().toISOString(),
      candidateName: candidate.name,
      candidateRole: candidate.role,
      interviewer: candidate.interviewer,
      assessment: candidate.assessment,
      result: JSON.parse(JSON.stringify(result)),
      competencies: groups.map(([name, weight], index) => ({
        name, weight, score:result.ratings[index],
        scored:result.verified.filter(item=>item.group===index).length,
        selected:result.rows.filter(item=>item.group===index).length
      })),
      evidence,
      feedback: candidate.feedback === null || candidate.feedback === undefined ? draft(candidate,result) : candidate.feedback
    };
  }

  function completedSummary(candidate) {
    const record = candidate.completion;
    const result = record.result;
    const date = new Date(record.completedAt);
    const completedDate = Number.isNaN(date.getTime()) ? record.completedAt : date.toLocaleString();
    return `<section class="panel"><div class="row between"><div><h2>Completed assessment</h2><p class="hint">Completed ${esc(completedDate)} · Assessment is locked</p></div><button type="button" data-action="print-completed">Print / save PDF</button></div>
      <p class="hint">Final record for ${esc(record.candidateName)}${record.candidateRole ? ' · '+esc(record.candidateRole) : ''}</p>
      <p><strong> ${percent(result.score)} weighted score · ${esc(result.weight)}% coverage · ${esc(result.label)}</strong></p></section>
      <section class="panel"><h2>Competency breakdown</h2><div class="table"><table><thead><tr><th>Competency</th><th>Weight</th><th>Score</th><th>Evidence</th></tr></thead><tbody>
      ${record.competencies.map(item=>`<tr><td>${esc(item.name)}</td><td>${esc(item.weight)}%</td><td>${percent(item.score)}</td><td>${esc(item.scored)}/${esc(item.selected)}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="panel"><h2>Question evidence</h2><div class="table"><table><thead><tr><th>Competency</th><th>Question</th><th>Result</th><th>Observation</th></tr></thead><tbody>
      ${record.evidence.map(item=>`<tr><td>${esc(item.competency)}</td><td><b>${esc(item.title)}</b><p>${esc(item.prompt)}</p></td><td>${esc(item.status)}</td><td>${esc(item.note) || '—'}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="panel"><h2>HR feedback</h2><pre>${esc(record.feedback)}</pre></section>`;
  }

  function showCompletionDialog(candidate) {
    const result = assess(candidate);
    const unscored = candidate.selectedQuestions.length - result.verified.length;
    const popup = document.createElement('dialog');
    popup.setAttribute('aria-labelledby', 'complete-title');
    popup.innerHTML = `<h2 id="complete-title">Complete assessment?</h2>
      <p>Questions scored with evidence: ${result.verified.length} of ${candidate.selectedQuestions.length}</p>
      <p>Weighted score: ${percent(result.score)}</p>
      <p>Coverage: ${result.weight}% of 80% needed</p><p>Current verdict: ${esc(result.label)}</p>
      ${unscored > 0 ? `<p class="hint">${unscored} selected question${unscored === 1 ? ' is' : 's are'} unscored or missing an observation.</p>` : ''}
      ${result.weight < 80 ? '<p class="hint">Coverage is below 80%. You may still complete this assessment.</p>' : ''}
      <p class="hint">Completion permanently locks the assessment. It cannot be reopened or edited.</p>
      <div class="actions"><button type="button" data-cancel-completion>Keep editing</button><button type="button" class="primary" data-confirm-completion>Complete assessment</button></div>`;
    document.body.appendChild(popup);
    popup.addEventListener('close', () => popup.remove(), {once:true});
    popup.querySelector('[data-cancel-completion]').addEventListener('click', () => popup.close());
    popup.querySelector('[data-confirm-completion]').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      clearTimeout(writeTimer);
      await syncCandidates();
      await queue;
      if (failed) {button.disabled = false; alert('The assessment could not be saved. Resolve pending changes before completing.'); return;}
      candidate.completion = makeCompletion(candidate);
      save();
      clearTimeout(writeTimer);
      await syncCandidates();
      await queue;
      if (failed) {
        candidate.completion = null;
        button.disabled = false;
        alert('The completed assessment could not be confirmed as saved. Your unsaved changes are retained in this browser.');
        return;
      }
      popup.close();
      selecting = false;
      render();
    });
    popup.showModal();
  }

  function candidate() {
    const c = candidates.find((item) => item.id === selected);
    if (!c) {
      view = 'pipeline';
      return pipeline();
    }
    const r = assess(c);
    const style = r.ready ? (r.proceed ? 'good' : 'bad') : 'pending';
    if (c.completion) {
      return `<div class="top"><button type="button" data-view="pipeline">← Candidates</button></div>` +
        hero('Candidate screening', esc(c.name), 'Completed assessment', '<button type="button" data-action="edit">Edit profile</button>') +
        `<section class="panel"><label>Screening stage<select data-stage>${stages.map(stage=>`<option ${stage === (c.stage || 'New') ? 'selected' : ''} ${!['HR review','Closed'].includes(stage) ? 'disabled' : ''}>${esc(stage)}</option>`).join('')}</select></label></section>` +
        completedSummary(c);
    }
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

    const isSelected = id => pair.some(candidate => (candidate.selectedQuestions || []).includes(id));
    const evidenceRow = ([id, , title]) => row(esc(title), pair.map(candidate => {
      if (!(candidate.selectedQuestions || []).includes(id)) return 'Not selected';
      const result = answer(candidate, id);
      if (result.status === 'Not tested') return 'Not tested';
      return result.note.trim()
        ? `<b>${esc(result.status)}</b><div>${esc(result.note)}</div>`
        : `${esc(result.status)} · No evidence note`;
    }));
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
            ${questions.filter(([id]) => isSelected(id)).sort((a, b) => a[1] - b[1]).map(evidenceRow).join('')}

          </tbody>
        </table></div>
        ${questions.some(([id]) => !isSelected(id)) ? `<details><summary>Show unselected questions</summary>
          <div class="table"><table><thead><tr><th scope="col">Question</th>${pair.map(candidate => `<th scope="col">${esc(candidate.name)}</th>`).join('')}</tr></thead>
          <tbody>${questions.filter(([id]) => !isSelected(id)).map(evidenceRow).join('')}</tbody></table></div>
        </details>` : ''}
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
    if (!workspaceReady) return;
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
    for (const table of main.querySelectorAll('.table table')) {
      const headers = Array.from(table.querySelectorAll('thead th'), header => header.textContent.trim());
      for (const cell of table.querySelectorAll('tbody td')) {
        cell.dataset.label = headers[cell.cellIndex] || '';
      }
    }
    closeMobileNav();
  }

  function focusFirstDialogField() {
    const first = form.querySelector('input, textarea, button');
    first?.focus();
  }

  function parseScreeningDate(value) {
    const input = value.trim();
    if (!input) return '';
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
    const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : input;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const year = Number(iso.slice(0, 4));
    const month = Number(iso.slice(5, 7));
    const day = Number(iso.slice(8, 10));
    if (year < 1 || month < 1 || month > 12 || day < 1) return null;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= days[month - 1] ? iso : null;
  }
  function displayScreeningDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
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
    form.elements.date.setCustomValidity('');
    form.elements.date.value = displayScreeningDate(c?.date || '');
    document.querySelector('#date-picker').value = parseScreeningDate(c?.date || '') || '';
    dialog.showModal();
    focusFirstDialogField();
  }

  function exportCandidates() {
    const blob = new Blob([JSON.stringify({candidates, questions:questions.map(q=>({id:q[0],competency:groups[q[1]][0],title:q[2],prompt:q[3],expectedAnswer:q[4],difficulty:difficultyOf(q)}))}, null, 2)], {
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
            if (candidates[idx].completion) continue;
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

  form.elements.date.addEventListener('input', () => {
    form.elements.date.setCustomValidity('');
    const iso = parseScreeningDate(form.elements.date.value);
    document.querySelector('#date-picker').value = iso || '';
  });
  document.querySelector('#date-picker').addEventListener('change', event => {
    form.elements.date.value = displayScreeningDate(event.target.value);
    form.elements.date.setCustomValidity('');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!workspaceReady) return;
    const data = Object.fromEntries(
      Array.from(new FormData(form), ([k, v]) => [k, String(v).trim()])
    );
    if (!data.name) {
      form.elements.name.focus();
      return;
    }
    const parsedDate = parseScreeningDate(data.date);
    if (parsedDate === null) {
      form.elements.date.setCustomValidity('Enter a valid date in DD/MM/YYYY format.');
      form.elements.date.reportValidity();
      return;
    }
    data.date = parsedDate;
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
    if (!workspaceReady) return;
    const b = event.target.closest('button');
    if (!b) return;

    if (b.hasAttribute('data-clear-pipeline')) { pipelineSearch=''; pipelineStage='all'; pipelineFilter='all'; render(); return; }
    if (b.dataset.difficulty) { difficultyFilter=b.dataset.difficulty; render(); return; }
    if (b.dataset.pipelineFilter) {
      const choice = b.dataset.pipelineFilter;
      pipelineFilter = choice === pipelineFilter ? 'all' : choice;
      render();
    }
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
    if (b.dataset.action === 'complete') {
      const candidate = candidates.find(item => item.id === selected);
      if (candidate && !candidate.completion) showCompletionDialog(candidate);
    }
    if (b.dataset.action === 'print-completed') {
      const candidate = candidates.find(item => item.id === selected);
      if (!candidate?.completion) return;
      const popup = window.open('', '_blank');
      if (!popup) {alert('Allow pop-ups to print the assessment.'); return;}
      popup.document.write('<!doctype html><title>Completed assessment</title><style>body{font:14px/1.5 system-ui;margin:32px}section{margin:22px 0}table{border-collapse:collapse;width:100%}td,th{padding:8px;border:1px solid #ccc;vertical-align:top}pre{white-space:pre-wrap}button{display:none}</style>' + completedSummary(candidate));
      popup.document.close(); popup.focus(); popup.print();
    }
    if (b.dataset.action === 'save-template') {
      const c = candidates.find(item=>item.id===selected);
      if (c.completion) return;
      if (!c.selectedQuestions.length) {alert('Select at least one question first.'); return;}
      const name = prompt('Template name');
      if (!name?.trim()) return;
      settings.templates.push({name:name.trim(),questions:[...c.selectedQuestions]});
      await saveSettings(); render();
    }
    if (b.dataset.action === 'add') profile();
    if (b.dataset.action === 'edit') profile(candidates.find((item) => item.id === selected));
    if (b.dataset.action === 'choose-questions') {
      if (candidates.find(item=>item.id===selected)?.completion) return;
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
    if (b.dataset.action === 'export-recovery') {
      const prefix = 'hiring-desk-recovery-' + user.id + '-';
      const backups = Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key)));
      const blob = new Blob([JSON.stringify(backups.map(item => ({
        createdAt:item.createdAt,
        candidates:item.candidates ? JSON.parse(item.candidates) : [],
        settings:item.settings ? JSON.parse(item.settings) : null
      })),null,2)],{type:'application/json'});
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download='hiring-desk-recovery.json'; link.click(); URL.revokeObjectURL(link.href);
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
      const popup=document.createElement('dialog');
      const count=assess(c).verified.length;
      popup.innerHTML=`<h2>Delete candidate?</h2><p><strong>${esc(c.name)}</strong> · ${esc(c.role || 'No role specified')} · ${count} questions scored with evidence</p><p>The candidate and all scores, notes and evidence will be permanently removed. This cannot be undone.</p>${c.completion ? '<p><strong>The completed assessment and its locked evidence will also be deleted.</strong></p>' : ''}<div class="actions"><button type="button" data-cancel-delete>Cancel</button><button type="button" class="danger" data-confirm-delete>Delete permanently</button></div>`;
      document.body.appendChild(popup); popup.showModal();
      const confirmed=await new Promise(resolve=>{popup.querySelector('[data-cancel-delete]').onclick=()=>resolve(false); popup.querySelector('[data-confirm-delete]').onclick=()=>resolve(true); popup.addEventListener('cancel',e=>{e.preventDefault();resolve(false);});});
      popup.close(); popup.remove(); if (!confirmed) return;
      candidates = candidates.filter((item) => item.id !== selected);
      save();
      selected = '';
      view = 'pipeline';
      render();
      toast('Deletion pending save');
    }
    if (b.dataset.action === 'regenerate-feedback') {
      const candidate = candidates.find(item => item.id === selected);
      if (candidate?.completion) return;
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
    if (!workspaceReady) return;
    const el = event.target;
    if (el.matches('[data-stage-filter]')) { pipelineStage=el.value; render(); }
    if (el.matches('[data-difficulty-filter]')) { difficultyFilter=el.value; render(); }
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
      if (c.completion) return;
      const template = settings.templates[Number(el.value)];
      const selection = new Set(c.selectedQuestions);
      const skipped = [];
      let added = 0;
      for (const id of template.questions) {
        const question = questions.find(item => item[0] === id);
        if (!question || selection.has(id)) continue;
        const count = questions.filter(item => item[1] === question[1] && selection.has(item[0])).length;
        if (count >= 3) {
          skipped.push(question[2]);
          continue;
        }
        selection.add(id);
        added++;
      }
      c.selectedQuestions = [...selection];
      if (added) save();
      render();
      if (skipped.length) {
        alert(`Added ${added} question${added === 1 ? '' : 's'}. These were not added because their competency already has 3 selected: ${skipped.join(', ')}. You can change the selection manually.`);
      } else {
        toast(`Added ${added} question${added === 1 ? '' : 's'} from the template`);
      }
    }
    if (el.matches('[data-stage]')) {
      const candidate = candidates.find(item => item.id === selected);
      if (candidate.completion && !['HR review', 'Closed'].includes(el.value)) {
        el.value = candidate.stage;
        return;
      }
      candidate.stage = el.value;
      save();
    }
    const checkbox = el.closest('[data-select-question]');
    if (checkbox) {
      const c = candidates.find((item) => item.id === selected);
      if (c.completion) return;
      const set = new Set(c.selectedQuestions || []);
      if (checkbox.checked) {
        const question = questions.find(item => item[0] === checkbox.value);
        const selectedInGroup = questions.filter(item => item[1] === question?.[1] && set.has(item[0])).length;
        if (selectedInGroup >= 3) {
          checkbox.checked = false;
          alert('You can select up to 3 questions for this competency. Remove one before adding another.');
          return;
        }
        set.add(checkbox.value);
      } else set.delete(checkbox.value);
      c.selectedQuestions = Array.from(set);
      save();
      const pos = window.scrollY;
      render();
      window.scrollTo(0, pos);
    }
  });

  main.addEventListener('input', (event) => {
    if (!workspaceReady) return;
    if (event.target.matches('[data-pipeline-search]')) { pipelineSearch=event.target.value; const pos=event.target.selectionStart; render(); const input=main.querySelector('[data-pipeline-search]'); input?.focus(); input?.setSelectionRange(pos,pos); }
    if (event.target.matches('[data-note]')) storeAnswer(event.target);
    if (event.target.matches('[data-assessment]')) {
      if (candidates.find(item => item.id === selected)?.completion) return;
      candidates.find(item => item.id === selected).assessment = event.target.value;
      save();
    }
    if (event.target.matches('#feedback')) {
      if (candidates.find(item => item.id === selected)?.completion) return;
      candidates.find(item => item.id === selected).feedback = event.target.value;
      save();
    }
  });

  function storeAnswer(el) {
    const fields = el.closest('[data-question]');
    const c = candidates.find((item) => item.id === selected);
    if (!c || c.completion) return;
    c.answers[fields.dataset.question] = {
      status: fields.querySelector('[data-status]').value,
      note: fields.querySelector('[data-note]').value,
    };
    save();
    refreshSnapshot(c);
  }

  importInput.addEventListener('change', () => {
    if (!workspaceReady) return;
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
      let authPending = false;
      async function authenticate(register) {
        if (authPending) return;
        authPending = true;
        const buttons = authForm.querySelectorAll('button');
        buttons.forEach(button => { button.disabled = true; });
        const message = document.querySelector('#auth-message');
        message.textContent = register ? 'Creating account…' : 'Signing in…';
        try {
          const values = new FormData(authForm);
          const credentials = {email:String(values.get('email')),password:String(values.get('password'))};
          const response = register ? await client.auth.signUp({...credentials,options:{emailRedirectTo:location.origin + location.pathname}}) : await client.auth.signInWithPassword(credentials);
          message.textContent = response.error ? response.error.message : register && !response.data.session ? 'Check your email to confirm your account, then sign in.' : 'Signed in.';
          if (response.data?.session) location.reload();
        } catch {
          message.textContent = 'Unable to connect. Please try again.';
        } finally {
          authPending = false;
          buttons.forEach(button => { button.disabled = false; });
        }
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
    let difficultyNeedsSave = false;
    for (const q of questions) {
      if (!['Foundation','Core','Advanced'].includes(q[5])) {
        q[5] = difficultyOf(q);
        const custom = settings.custom.find(item => item[0] === q[0]);
        if (custom) custom[5] = q[5];
        else settings.edits[q[0]] = [...q];
        difficultyNeedsSave = true;
      }
    }
    candidates = result.data.map(row => normalizeCandidate(row.data));
    revisions = new Map(result.data.map(row => [row.id,row.revision]));
    savedSnapshots = new Map(candidates.map(candidate => [candidate.id,JSON.stringify(candidate)]));
    const pendingKey = 'hiring-desk-pending-' + user.id;
    const settingsKey = 'hiring-desk-settings-pending-' + user.id;
    const pending = localStorage.getItem(pendingKey);
    const pendingSettings = localStorage.getItem(settingsKey);

    function enterWorkspace() {
      workspaceReady = true;
      document.body.classList.remove('auth-locked');
      const hasBackup = Object.keys(localStorage).some(key => key.startsWith('hiring-desk-recovery-' + user.id + '-'));
      document.querySelector('.local').innerHTML = '<strong>Account storage</strong> Records are saved to your account. <button type="button" data-action="import-browser">Import browser records</button>' +
        (hasBackup ? ' <button type="button" data-action="export-recovery">Export recovery backup</button>' : '') +
        ' <button type="button" data-action="sign-out">Sign out</button>';
      render();
      if (difficultyNeedsSave) { difficultyNeedsSave = false; saveSettings(); }
    }

    if (pending || pendingSettings) {
      main.innerHTML = `<section class="panel"><h2>Unsaved changes found</h2>
        <p>Changes from an earlier session remain on this device and may not be saved to your account.</p>
        <p>Export a backup, or continue with the records saved in your account. A recovery copy will stay on this device.</p>
        <button type="button" data-action="export-pending">Export pending backup</button>
        <button type="button" data-action="review-pending">Continue with saved records</button>
        <div id="recovery-confirm" hidden><p>Continuing loads the account records without applying the pending changes. A copy of those changes will remain on this device.</p>
          <button type="button" data-action="confirm-pending">Continue</button>
          <button type="button" data-action="cancel-pending">Go back</button>
        </div><p id="recovery-message" role="status"></p></section>`;
      main.querySelector('[data-action="export-pending"]').onclick = () => {
        const data = JSON.stringify({candidates:pending ? JSON.parse(pending) : [],settings:pendingSettings ? JSON.parse(pendingSettings) : null},null,2);
        const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([data],{type:'application/json'})); link.download='hiring-desk-pending.json'; link.click(); URL.revokeObjectURL(link.href);
      };
      main.querySelector('[data-action="review-pending"]').onclick = () => { main.querySelector('#recovery-confirm').hidden = false; };
      main.querySelector('[data-action="cancel-pending"]').onclick = () => { main.querySelector('#recovery-confirm').hidden = true; };
      main.querySelector('[data-action="confirm-pending"]').onclick = () => {
        const message = main.querySelector('#recovery-message');
        try {
          if (localStorage.getItem(pendingKey) !== pending || localStorage.getItem(settingsKey) !== pendingSettings) {
            message.textContent = 'Pending changes changed in another tab. Refresh this page before continuing.';
            return;
          }
          const backupKey = 'hiring-desk-recovery-' + user.id + '-' + crypto.randomUUID();
          localStorage.setItem(backupKey, JSON.stringify({createdAt:new Date().toISOString(),candidates:pending,settings:pendingSettings}));
          localStorage.removeItem(pendingKey);
          localStorage.removeItem(settingsKey);
          failed = false;
          enterWorkspace();
        } catch {
          message.textContent = 'Could not preserve the recovery copy. Export the backup and try again.';
        }
      };
      return;
    }
    enterWorkspace();
  }
  start();
})();






