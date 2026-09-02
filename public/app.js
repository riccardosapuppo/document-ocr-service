/**
 * The page, in plain JavaScript.
 *
 * No framework, and that is a choice rather than a shortcut. This page exists
 * so somebody can hold the API for five minutes; a build step between them and
 * that is a build step for nothing. It is also the honest demonstration of the
 * claim the service makes — that any HTTP client can use it — and a page that
 * needed a framework to talk to it would be quietly arguing the opposite.
 *
 * The streaming reader below is the part worth reading. It is nine lines, and
 * they are the whole client side of `POST /api/read/live`.
 */

const $ = (id) => document.getElementById(id);

/** The chosen file, named where somebody can see it. */
function chose(name) {
  const el = $('chosen');
  el.textContent = name ?? 'nothing chosen';
  el.dataset.chosen = name ? 'yes' : 'no';
}

/** The demonstration clients, and what each one is for. */
const CLIENTS = [
  ['reader-and-writer', 'demo-secret-both-1234', 'submits and collects', 'ocr:read ocr:write'],
  ['uploader', 'demo-secret-write-1234', 'submits, and may not read back', 'ocr:write'],
  ['collector', 'demo-secret-read-1234', 'collects, and may not submit', 'ocr:read'],
  ['impatient', 'demo-secret-slow-1234', 'three calls a minute', 'ocr:read ocr:write'],
  ['retired', 'demo-secret-retired-1234', 'switched off in the file', '—'],
];

let token = null;

document.getElementById('document').addEventListener('change', (event) => {
  chose(event.target.files?.[0]?.name ?? null);
});

// ------------------------------------------------------------------ the shell

for (const [id, secret, what, scope] of CLIENTS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'client';
  button.dataset.client = id;
  button.innerHTML = `<strong>${id}</strong><span>${what}</span><em>${scope}</em>`;
  button.addEventListener('click', () => {
    $('clientId').value = id;
    $('clientSecret').value = secret;
    for (const other of document.querySelectorAll('.client')) other.classList.remove('picked');
    button.classList.add('picked');
  });
  $('clients').append(button);
}

document.querySelector('.client')?.classList.add('picked');

fetch('/api/health')
  .then((response) => response.json())
  .then((health) => {
    $('whereItReads').textContent = health.reads_pixels
      ? 'text layers and pixels'
      : 'text layers only';

    $('engines').innerHTML = health.engines
      .map(
        (engine) =>
          `<span class="engine" data-ready="${engine.needs === 'nothing' || health.reads_pixels}">${engine.name}<em>${
            engine.needs === 'nothing' ? 'needs nothing' : `needs ${engine.needs}`
          }</em></span>`
      )
      .join('');
  })
  .catch(() => {
    $('whereItReads').textContent = 'the service is not answering';
  });

// ------------------------------------------------------------------- a token

$('getToken').addEventListener('click', async () => {
  say('POST /oauth/token', 'sent');

  const response = await fetch('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: $('clientId').value,
      client_secret: $('clientSecret').value,
    }),
  });

  const body = await response.json();
  show(body);

  if (!response.ok) {
    token = null;
    state('none', `${response.status} — ${body.error_description ?? body.error}`);
    say(`refused: ${body.error}`, 'bad');
    return;
  }

  token = body.access_token;
  state('held', `${$('clientId').value} · ${body.scope} · ${body.expires_in}s`);
  say(`token for ${$('clientId').value}, scope ${body.scope}`, 'good');
});

// ------------------------------------------------------------- the samples

for (const button of document.querySelectorAll('[data-sample]')) {
  button.addEventListener('click', async () => {
    const name = button.dataset.sample;
    say(`fetching samples/${name}`, 'sent');

    const bytes = await (await fetch(`/samples/${name}`)).blob();
    const type = name.endsWith('.pdf') ? 'application/pdf' : 'image/png';
    const file = new File([bytes], name, { type });

    const held = new DataTransfer();
    held.items.add(file);
    $('document').files = held.files;

    chose(name);
    say(`${name} ready — now choose one of the three ways`, 'good');
  });
}

// -------------------------------------------------------------- sending it

$('readForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const way = event.submitter?.value ?? 'wait';
  const file = $('document').files?.[0];

  if (!file) return say('choose a file first', 'bad');
  if (!token) return say('get a token first — the API will refuse this without one', 'bad');

  const form = new FormData();
  form.set('document', file);
  if ($('engine').value) form.set('engine', $('engine').value);

  $('text').textContent = '';
  progress(0);

  if (way === 'wait') return waitForIt(form);
  if (way === 'live') return watchItWork(form);
  return comeBackForIt(form);
});

/** 1. The simple one: hold the connection until it is done. */
async function waitForIt(form) {
  say('POST /api/read — holding the connection', 'sent');
  progress(0.5);

  const response = await fetch('/api/read', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const body = await response.json();
  show(body);
  progress(1);

  if (!response.ok) return refused(response, body);

  $('text').textContent = body.text;
  say(`read by ${body.engine} in ${body.took_ms} ms — ${body.characters} characters`, 'good');
}

/**
 * 2. The streaming one.
 *
 * NDJSON, so this is a reader and a split rather than a client library. The
 * buffer matters: a chunk boundary lands wherever the network put it, which is
 * routinely in the middle of a line, and `JSON.parse` on half an object throws.
 * Everything up to the last newline is complete; what follows waits.
 */
async function watchItWork(form) {
  say('POST /api/read/live — one line per step', 'sent');

  const response = await fetch('/api/read/live', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.json();
    show(body);
    return refused(response, body);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    rest += decoder.decode(value, { stream: true });
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';

    for (const line of lines.filter(Boolean)) onEvent(JSON.parse(line));
  }

  if (rest.trim()) onEvent(JSON.parse(rest));
}

function onEvent(event) {
  if (event.type === 'started') return say(`started · ${event.filename}`, 'sent');

  if (event.type === 'progress') {
    progress(event.progress);
    return say(`${Math.round(event.progress * 100)}% · ${event.step}`);
  }

  if (event.type === 'result') {
    progress(1);
    show(event);
    $('text').textContent = event.text;
    return say(`read by ${event.engine} in ${event.took_ms} ms`, 'good');
  }

  progress(1);
  show(event);
  say(`stopped: ${event.error}`, 'bad');
  for (const tried of event.tried ?? []) say(`  ${tried.engine}: ${tried.outcome}`, 'bad');
}

/** 3. The one for work that takes a while: an id, and come back. */
async function comeBackForIt(form) {
  say('POST /api/jobs — asking for an id', 'sent');

  const opened = await fetch('/api/jobs', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const accepted = await opened.json();
  show(accepted);

  if (!opened.ok) return refused(opened, accepted);

  say(`job ${accepted.job_id} — collecting from ${accepted.collect_from}`, 'sent');

  for (let asked = 0; asked < 100; asked += 1) {
    await new Promise((done) => setTimeout(done, 250));

    const response = await fetch(accepted.collect_from, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const job = await response.json();

    if (!response.ok) {
      show(job);
      // The refusal worth meeting: `uploader` may submit and may not read back.
      // It is the reason the two scopes exist and it is one click away.
      return refused(response, job);
    }

    progress(job.progress);
    say(`${job.state} · ${job.step}`);

    if (job.state === 'done') {
      show(job);
      $('text').textContent = job.result.text;
      return say(`collected after ${asked + 1} ${asked === 0 ? 'ask' : 'asks'}`, 'good');
    }

    if (job.state === 'failed') {
      show(job);
      return say(`stopped: ${job.problem?.error}`, 'bad');
    }
  }

  say('gave up asking', 'bad');
}

function refused(response, body) {
  progress(1);
  say(`${response.status} — ${body.error_description ?? body.error}`, 'bad');

  if (body.you_have) say(`  this token holds: ${body.you_have.join(' ') || 'nothing'}`, 'bad');
  if (body.retry_after_seconds) say(`  try again in ${body.retry_after_seconds}s`, 'bad');
  for (const tried of body.tried ?? []) say(`  ${tried.engine}: ${tried.outcome}`, 'bad');
}

// ------------------------------------------------------------------ the panel

function say(line, kind = '') {
  const at = new Date().toLocaleTimeString('en-GB');
  const el = $('transcript');

  if (el.dataset.empty !== 'no') {
    el.textContent = '';
    el.dataset.empty = 'no';
  }

  const row = document.createElement('span');
  row.className = `line ${kind}`;
  row.textContent = `${at}  ${line}`;
  el.append(row, '\n');
  el.scrollTop = el.scrollHeight;
}

function progress(fraction) {
  $('progressFill').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function show(body) {
  $('json').textContent = JSON.stringify(body, null, 2);
}

function state(which, words) {
  const el = $('tokenState');
  el.dataset.state = which;
  el.textContent = words;
}
