/* Erebus landing — scroll choreography.
   No libraries: one rAF loop reads scroll, everything else is CSS. */

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------- boot ----- */
addEventListener('load', () => {
  setTimeout(() => document.getElementById('boot').classList.add('done'), reduced ? 0 : 1700);
});

/* ------------------------------------------------- hero title stagger --- */
const title = document.getElementById('title');
if (title) {
  const letters = [...title.textContent];
  title.textContent = '';
  letters.forEach((ch, i) => {
    const span = document.createElement('span');
    span.className = 'ch';
    span.textContent = ch;
    span.style.transform = 'translateY(120%) rotate(6deg)';
    span.style.opacity = '0';
    span.style.transition = `transform 1.2s cubic-bezier(.22,1,.36,1) ${1.75 + i * 0.06}s, opacity .9s ease ${1.75 + i * 0.06}s`;
    title.appendChild(span);
  });
  addEventListener('load', () =>
    requestAnimationFrame(() =>
      title.querySelectorAll('.ch').forEach((s) => {
        s.style.transform = 'none';
        s.style.opacity = '1';
      }),
    ),
  );
}

/* --------------------------------------------------- pointer aura ------- */
const aura = document.getElementById('aura');
let auraX = innerWidth / 2;
let auraY = innerHeight / 2;
let auraTX = auraX;
let auraTY = auraY;
addEventListener('pointermove', (e) => {
  auraTX = e.clientX;
  auraTY = e.clientY;
});

/* --------------------------------------------------- reveal on scroll --- */
const revealer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      revealer.unobserve(entry.target);
    }
  },
  { rootMargin: '0px 0px -12% 0px', threshold: 0.15 },
);
document.querySelectorAll('[data-reveal]').forEach((el) => revealer.observe(el));

/* ------------------------------------------------ ambient section loops -- */
const ambients = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const v = entry.target;
      if (entry.isIntersecting) {
        if (!v.src) v.src = v.dataset.src;
        v.play().then(
          () => v.classList.add('on'),
          () => {
            /* autoplay refused — the section just stays plain */
          },
        );
      } else {
        v.classList.remove('on');
        v.pause();
      }
    }
  },
  // Start fetching a screen early so the fade-in is not the loading spinner.
  { rootMargin: '80% 0px' },
);
if (!reduced) document.querySelectorAll('.ambient').forEach((v) => ambients.observe(v));

/* ------------------------------------------------------- counters ------- */
const counters = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      counters.unobserve(el);
      const target = Number(el.dataset.count);
      // The markup already opens with a "0" text node ahead of the unit <span>;
      // that node is the one to rewrite. Adding a second one left the old digit
      // stuck on the end ("1,015" rendered as "7790").
      const digits = el.firstChild;
      if (!digits || digits.nodeType !== Node.TEXT_NODE) continue;
      const started = performance.now();
      const tick = (now) => {
        const t = clamp((now - started) / 1600);
        const eased = 1 - Math.pow(1 - t, 4);
        digits.nodeValue = Math.round(target * eased).toLocaleString('en-US');
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  },
  { threshold: 0.6 },
);
document.querySelectorAll('[data-count]').forEach((el) => counters.observe(el));

/* -------------------------------------------------- card pointer glow --- */
document.querySelectorAll('.card').forEach((card) => {
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
    card.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
  });
});

/* ------------------------------------------------------ magnetic CTA --- */
if (!reduced) {
  document.querySelectorAll('.btn').forEach((btn) => {
    btn.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
      const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
      btn.style.transform = `translate(${dx * 10}px, ${dy * 6}px)`;
    });
    btn.addEventListener('pointerleave', () => (btn.style.transform = ''));
  });
}

/* ------------------------------------------------------ hero scrub ----- */
const hero = document.getElementById('hero');
const film = document.getElementById('film');
const heroCopy = document.getElementById('heroCopy');
const hint = document.getElementById('hint');
const notes = [...document.querySelectorAll('.hero-note')];

let filmDuration = 0;
let filmTarget = 0;
let filmCurrent = 0;
let filmReady = false;

function armFilm() {
  if (filmReady || !film || !(film.duration > 0)) return;
  filmDuration = film.duration;
  filmReady = true;
  // A first seek proves scrubbing works and warms the decoder.
  try {
    film.currentTime = 0.001;
  } catch {
    /* ignore */
  }
  // Safari can stop at metadata — especially for a tab opened in the
  // background — and then the first seeks have no data to land on and the hero
  // looks frozen. A muted play immediately followed by pause forces the fetch
  // and the decoder without ever showing motion.
  try {
    const started = film.play();
    if (started && typeof started.then === 'function') {
      started.then(() => film.pause(), () => {});
    }
    film.pause();
  } catch {
    /* autoplay refused — the scrub still works, it just buffers later */
  }
}

if (film) {
  film.addEventListener('loadedmetadata', armFilm);
  film.addEventListener('durationchange', armFilm);
  // Served from cache the metadata can already be there by the time this runs,
  // and then loadedmetadata never fires — the hero would sit on its poster.
  armFilm();
  // If the file never arrives, the poster stays and nothing below breaks.
  film.addEventListener('error', () => (filmReady = false));
}

/* ---------------------------------------------------------- statement -- */
const statement = document.getElementById('statement');
const litLines = [...document.querySelectorAll('.statement .fade')];

/* -------------------------------------------------------------- tour --- */
const tour = document.getElementById('tour');
const steps = [...document.querySelectorAll('.tour-step')];
const shots = [...document.querySelectorAll('.frame img')];
let shownStep = 0;

if (tour) {
  // Give the section enough scroll for one screen per step.
  tour.style.height = `${steps.length * 95 + 40}vh`;
}

/* --------------------------------------------------------- main loop --- */
const progressBar = document.getElementById('progress');
const nav = document.getElementById('nav');
const docHeight = () => document.documentElement.scrollHeight - innerHeight;

function frame() {
  const y = scrollY;

  /* progress + nav */
  progressBar.style.transform = `scaleX(${clamp(y / Math.max(docHeight(), 1))})`;
  nav.classList.toggle('solid', y > innerHeight * 0.6);

  /* aura */
  auraX = lerp(auraX, auraTX, 0.09);
  auraY = lerp(auraY, auraTY, 0.09);
  aura.style.transform = `translate3d(${auraX}px, ${auraY}px, 0)`;

  /* hero */
  if (hero) {
    const span = hero.offsetHeight - innerHeight;
    const p = clamp((y - hero.offsetTop) / Math.max(span, 1));

    if (!filmReady) armFilm(); // last resort: whatever order the events arrived in
    if (filmReady && filmDuration) {
      filmTarget = p * (filmDuration - 0.06);
      filmCurrent = lerp(filmCurrent, filmTarget, 0.16);
      // Queueing another seek while one is still running gets it dropped in
      // WebKit, so wait for the current one. fastSeek is skipped deliberately:
      // keyframes sit two frames apart, so a plain assignment is already exact
      // and it is the path both engines agree on.
      if (!film.seeking && Math.abs(filmCurrent - film.currentTime) > 0.02) {
        film.currentTime = filmCurrent;
      }
    }

    // The opening copy lifts away over the first fifth of the scroll.
    const fade = clamp(p / 0.2);
    heroCopy.style.opacity = String(1 - fade);
    heroCopy.style.transform = `translateY(${-70 * fade}px) scale(${1 - 0.06 * fade})`;
    hint.style.opacity = String(1 - clamp(p / 0.08));

    for (const note of notes) {
      const at = Number(note.dataset.at);
      note.classList.toggle('on', p > at && p < at + 0.2);
    }
  }

  /* The pinned statement lights one line per slice of its own scroll,
     finishing a little before the section releases. */
  if (statement && litLines.length) {
    const span = statement.offsetHeight - innerHeight;
    const p = clamp((y - statement.offsetTop) / Math.max(span, 1));
    litLines.forEach((line, i) => {
      line.classList.toggle('lit', p * (litLines.length + 0.8) > i + 0.35);
    });
  }

  /* tour */
  if (tour && steps.length) {
    const span = tour.offsetHeight - innerHeight;
    const p = clamp((y - tour.offsetTop) / Math.max(span, 1));
    const index = clamp(Math.floor(p * steps.length), 0, steps.length - 1);
    if (index !== shownStep) {
      steps[shownStep].classList.remove('on');
      shots[shownStep].classList.remove('on');
      shownStep = index;
      steps[index].classList.add('on');
      shots[index].classList.add('on');
    }
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* Preload the tour screenshots so a step never lands on a blank frame. */
addEventListener('load', () => {
  shots.forEach((img) => {
    if (!img.complete) img.loading = 'eager';
  });
});
