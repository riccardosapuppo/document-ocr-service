/**
 * The page, in plain JavaScript.
 *
 * No framework, and that is a choice rather than a shortcut. This page exists
 * so somebody can hold the API for five minutes; a build step between them and
 * that is a build step for nothing. It is also the honest demonstration of the
 * claim the service makes — that any HTTP client can use it — and a page that
 * needed a framework to talk to it would be quietly arguing the opposite.
 *
 * ── What changed, and why ────────────────────────────────────────────────────
 *
 * The first version made getting a token step one. Somebody who arrived, dropped
 * a PDF in and was told to authenticate first read that as "it wants a key I do
 * not have" — and left, having learnt the opposite of what the project shows,
 * which is that most PDFs are read here with no account anywhere.
 *
 * So the token is taken on load, with the credentials that are in the
 * repository anyway. Nothing is hidden by that: the request appears in the
 * transcript like every other one, and the whole of the permission machinery is
 * still on the page, one fold down, where it can be played with on purpose
 * rather than tripped over.
 *
 * The streaming reader below is still the part worth reading. It is nine lines,
 * and they are the whole client side of `POST /api/read/live`.
 */

/**
 * Nothing here installs a service worker, and this makes sure nothing has.
 *
 * A service worker outlives the version that installed it and it outlives the
 * page: it goes on answering from its own cache long after the code that put it
 * there is gone. A panel served on 127.0.0.1 shares an origin with every other
 * thing anybody has ever run on that port, so a worker left behind by an
 * unrelated project is enough to serve somebody a page that no longer exists.
 * The symptom is a stale screen that only Ctrl+F5 fixes, which sends people
 * looking at caching headers that were right all along.
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((workers) => Promise.all(workers.map((one) => one.unregister())))
    .then((undone) => {
      if (undone.length > 0) console.info(`unregistered ${undone.length} service worker(s) left on this origin`);
      return globalThis.caches?.keys().then((names) => Promise.all(names.map((one) => caches.delete(one))));
    })
    .catch(() => {
      /* a browser that will not say has nothing for us to undo */
    });
}

const $ = (id) => document.getElementById(id);

/** The demonstration clients, and what each one is for. */
const CLIENTS = [
  ['reader-and-writer', 'demo-secret-both-1234', 'submits and collects', 'ocr:read ocr:write'],
  ['uploader', 'demo-secret-write-1234', 'submits, and may not read back', 'ocr:write'],
  ['collector', 'demo-secret-read-1234', 'collects, and may not submit', 'ocr:read'],
  ['impatient', 'demo-secret-slow-1234', 'three calls a minute', 'ocr:read ocr:write'],
  ['retired', 'demo-secret-retired-1234', 'switched off in the file', '—'],
];

let token = null;
let readsPixels = false;

// ------------------------------------------------------------------ the file

/** The chosen file, named where somebody can see it. */
function chose(name) {
  const el = $('chosen');
  el.textContent = name ?? 'or click to choose one';
  el.dataset.chosen = name ? 'yes' : 'no';
  $('drop').dataset.chosen = name ? 'yes' : 'no';
}

$('document').addEventListener('change', (event) => {
  chose(event.target.files?.[0]?.name ?? null);
});

/**
 * Dropping a file on the label.
 *
 * `dragover` has to be cancelled or the browser does its own thing with the
 * file, which is to navigate away from the page and open it — losing everything
 * on screen, in a way that looks like a crash.
 */
for (const kind of ['dragenter', 'dragover']) {
  $('drop').addEventListener(kind, (event) => {
    event.preventDefault();
    $('drop').dataset.over = 'yes';
  });
}

for (const kind of ['dragleave', 'drop']) {
  $('drop').addEventListener(kind, () => {
    $('drop').dataset.over = 'no';
  });
}

$('drop').addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;

  const held = new DataTransfer();
  held.items.add(file);
  $('document').files = held.files;
  chose(file.name);
});

// ----------------------------------------------------------------- the shell

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
    void signIn();
  });
  $('clients').append(button);
}

document.querySelector('.client')?.classList.add('picked');

/**
 * What this service can read at all, said once and permanently.
 *
 * Not as an error after somebody has already tried. Both states are normal, and
 * a page that mentions the key only at the moment of refusal teaches its
 * visitor that the refusal was a fault.
 */
fetch('/api/health')
  .then((response) => response.json())
  .then((health) => {
    readsPixels = Boolean(health.reads_pixels);

    $('whereItReads').textContent = readsPixels ? 'text layers and pixels' : 'text layers only';

    $('mode').dataset.key = readsPixels ? 'set' : 'unset';
    $('modeSays').innerHTML = readsPixels
      ? 'An API key is set, so this reads <strong>both</strong> the text inside a PDF and the pixels of a scan.'
      : 'No API key is set, and it does not need one: this reads <strong>any PDF that carries its own text</strong>, ' +
        'which is most of them. Only a scan or a photograph will be refused — it has no text to carry — and the ' +
        'refusal says so and names the one thing that changes it, <code>MISTRAL_API_KEY</code>.';

    $('engines').innerHTML = health.engines
      .map(
        (engine) =>
          `<span class="engine" data-ready="${engine.needs === 'nothing' || readsPixels}">${engine.name}<em>${
            engine.needs === 'nothing' ? 'needs nothing' : `needs ${engine.needs}`
          }</em></span>`
      )
      .join('');
  })
  .catch(() => {
    $('whereItReads').textContent = 'the service is not answering';
    $('modeSays').textContent = 'The service is not answering. Is it still running?';
  });

// ------------------------------------------------------------------- a token

/**
 * Signs in with whichever client is in the boxes. Called on load, and again
 * whenever somebody picks a different one.
 */
async function signIn() {
  const who = $('clientId').value;
  say(`POST /oauth/token as ${who}`, 'sent');

  try {
    const response = await fetch('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: who,
        client_secret: $('clientSecret').value,
      }),
    });

    const body = await response.json();
    show(body);

    if (!response.ok) {
      token = null;
      state('none', `${response.status} — ${body.error_description ?? body.error}`);
      summary('whoNow', `${who} was refused a token`);
      say(`refused: ${body.error}`, 'bad');
      return false;
    }

    token = body.access_token;
    state('held', `${who} · ${body.scope} · ${body.expires_in}s`);
    summary('whoNow', `signed in as ${who} · ${body.scope}`);
    say(`token for ${who}, scope ${body.scope}`, 'good');
    return true;
  } catch {
    token = null;
    summary('whoNow', 'the service is not answering');
    say('the service is not answering', 'bad');
    return false;
  }
}

$('getToken').addEventListener('click', () => void signIn());

// Signed in before anybody asks, so the first thing on the page is the thing
// the page is about.
void signIn();

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
    say(`${name} ready`, 'good');
  });
}

// -------------------------------------------------------------- sending it

$('readForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const file = $('document').files?.[0];
  if (!file) return chose(null) ?? say('choose a document first', 'bad');

  // A missing token is fixed rather than complained about. Somebody who has
  // never opened the fold below should not be told about scopes.
  if (!token && !(await signIn())) return;

  const form = new FormData();
  form.set('document', file);
  if ($('engine').value) form.set('engine', $('engine').value);

  $('text').textContent = '';
  $('textCard').hidden = true;
  $('howCard').hidden = true;
  progress(0);

  const way = $('way').value;
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

  arrived(body);
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
    arrived(event);
    return say(`read by ${event.engine} in ${event.took_ms} ms`, 'good');
  }

  progress(1);
  show(event);
  couldNotRead(event);
  say(`stopped: ${event.error}`, 'bad');
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
      arrived(job.result);
      return say(`collected after ${asked + 1} ${asked === 0 ? 'ask' : 'asks'}`, 'good');
    }

    if (job.state === 'failed') {
      show(job);
      couldNotRead(job.problem ?? {});
      return say(`stopped: ${job.problem?.error}`, 'bad');
    }
  }

  say('gave up asking', 'bad');
}

// ------------------------------------------------------- showing the outcome

/** It was read. Show by what, and show the text. */
function arrived(body) {
  $('text').textContent = body.text ?? '';
  $('textCard').hidden = false;

  const pages = body.pages ? `${body.pages} page${body.pages === 1 ? '' : 's'}` : null;

  saidHow(
    `Read by <strong>${body.engine}</strong>${pages ? `, ${pages}` : ''}${
      body.took_ms === undefined ? '' : `, in ${body.took_ms} ms`
    }.`,
    body.tried ?? [{ engine: body.engine, outcome: 'read it' }]
  );
}

/**
 * It could not be read, which for a scan without a key is not a fault.
 *
 * The distinction matters more than it looks. "No engine could read this
 * document" beside a red mark reads as breakage. What actually happened is that
 * the cheap engine correctly declined a file it is not for, and the expensive
 * one is not configured — which is the documented state of a service running
 * without a key, and the page said so at the top before anybody pressed
 * anything.
 */
function couldNotRead(body) {
  const tried = body.tried ?? [];
  const wantsAKey = tried.some((one) => /MISTRAL_API_KEY/.test(one.outcome ?? ''));

  $('textCard').hidden = true;

  saidHow(
    wantsAKey
      ? 'Nothing here to read without an API key. <strong>This is the expected answer</strong>: the file has no ' +
          'text layer, so it needs the engine that reads pixels, and that one is not configured. Set ' +
          '<code>MISTRAL_API_KEY</code> and this same file comes back as text.'
      : `Not read. <strong>${body.error ?? 'no engine could read this document'}</strong>`,
    tried,
    wantsAKey ? 'needs-a-key' : 'bad'
  );
}

/**
 * The engine chain: what was tried, in order, and what each one said.
 *
 * This is the argument of the whole project drawn in six lines of DOM. The
 * cheap engine is asked first and the expensive one only ever sees what the
 * cheap one could not do — which is invisible in a result and obvious here.
 */
function saidHow(lede, tried, tone = 'good') {
  $('howCard').hidden = false;
  $('howCard').dataset.tone = tone;
  $('howSays').innerHTML = lede;

  $('chain').innerHTML = tried
    .map((one) => {
      const read = /read it/i.test(one.outcome ?? '');
      const notForIt = /not for this kind of file/i.test(one.outcome ?? '');

      return `<li data-outcome="${read ? 'read' : notForIt ? 'passed' : 'declined'}">
        <span class="who">${one.engine}</span>
        <span class="said">${one.outcome ?? ''}</span>
      </li>`;
    })
    .join('');
}

function refused(response, body) {
  progress(1);
  say(`${response.status} — ${body.error_description ?? body.error}`, 'bad');

  if (body.you_have) say(`  this token holds: ${body.you_have.join(' ') || 'nothing'}`, 'bad');
  if (body.retry_after_seconds) say(`  try again in ${body.retry_after_seconds}s`, 'bad');
  for (const tried of body.tried ?? []) say(`  ${tried.engine}: ${tried.outcome}`, 'bad');

  if (body.tried) return couldNotRead(body);

  // A refusal by the boundary rather than by the engines: that is what the fold
  // below is about, so it opens itself rather than leaving somebody wondering
  // where the explanation went.
  $('howCard').hidden = false;
  $('howCard').dataset.tone = 'bad';
  $('howSays').innerHTML =
    `<strong>${response.status} — ${body.error_description ?? body.error}</strong>. ` +
    'This is the permission boundary, not the reader. What each client may do is in the fold below.';
  $('chain').innerHTML = '';
  $('boundaryFold').open = true;
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

  summary('wireSay', line);
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

/** The one line a closed fold shows, so it is never a box with no news in it. */
function summary(id, words) {
  const el = $(id);
  if (el) el.textContent = words;
}
