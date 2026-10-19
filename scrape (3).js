// scrape.js
//
// Récupère mon propre emploi du temps sur le Passeport Électronique de
// Compétences du Cnam et génère docs/calendar.ics.
//
// Choix de confidentialité :
//  - les noms des enseignants ne sont jamais conservés : seules les initiales
//    sont extraites (le calcul se fait dans la page, le nom complet ne sort
//    jamais du navigateur) ;
//  - aucune capture d'écran ni aucun fichier de debug n'est produit.
//
// Variables d'environnement :
//   CNAM_USERNAME, CNAM_PASSWORD, CALENDAR_URL   (secrets GitHub)
//   MONTHS_FORWARD (défaut 6), MONTHS_BACKWARD (défaut 1)
//   DEFAULT_DURATION_HOURS (défaut 3)
//   SESSION_YEAR, SESSION_PROGRAM

import { chromium } from 'playwright';
import ical from 'ical-generator';
import fs from 'fs';
import crypto from 'crypto';

const USERNAME = process.env.CNAM_USERNAME;
const PASSWORD = process.env.CNAM_PASSWORD;
const CALENDAR_URL = process.env.CALENDAR_URL;
const MONTHS_FORWARD = parseInt(process.env.MONTHS_FORWARD || '6', 10);
const MONTHS_BACKWARD = parseInt(process.env.MONTHS_BACKWARD || '1', 10);
const DEFAULT_DURATION_HOURS = parseFloat(process.env.DEFAULT_DURATION_HOURS || '3');
const SESSION_YEAR = process.env.SESSION_YEAR || '2026-2027';
const SESSION_PROGRAM =
  process.env.SESSION_PROGRAM || 'Ingénieur Génie électrique - Smart Grids - Année 2';

if (!USERNAME || !PASSWORD || !CALENDAR_URL) {
  console.error('CNAM_USERNAME, CNAM_PASSWORD et CALENDAR_URL sont requis.');
  process.exit(1);
}

// Extrait les événements de la vue "mois" affichée. Les initiales des profs
// sont calculées ici, dans la page : seul "AM" sort, jamais "Prénom NOM".
async function extractMonthEvents(page) {
  return page.$$eval('td.fc-daygrid-day', (cells) => {
    const toInitials = (label) =>
      (label || '')
        .replace(/-\s*$/, '')
        .split(/[\s-]+/)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase())
        .join('');

    const results = [];
    cells.forEach((cell) => {
      const date = cell.getAttribute('data-date');
      cell.querySelectorAll('a.fc-event').forEach((a) => {
        const timeEl = a.querySelector('.fc-event-time');
        const titleEl = a.querySelector('.fc-event-title');
        const ariaEl = a.querySelector('[aria-label]');
        results.push({
          date,
          time: timeEl ? timeEl.textContent.trim() : null,
          title: titleEl ? titleEl.textContent.trim() : (a.textContent || '').trim(),
          initials: ariaEl ? toInitials(ariaEl.getAttribute('aria-label')) : '',
        });
      });
    });
    return results;
  });
}

async function goToAdjacentMonth(page, direction) {
  const firstCellBefore = await page.$eval('td.fc-daygrid-day', (el) => el.getAttribute('data-date'));
  const selector = direction === 'next' ? 'button.fc-next-button' : 'button.fc-prev-button';
  await page.click(selector);
  await page.waitForFunction(
    (prevDate) => {
      const cell = document.querySelector('td.fc-daygrid-day');
      return cell && cell.getAttribute('data-date') !== prevDate;
    },
    firstCellBefore,
    { timeout: 15000 }
  );
  await page.waitForTimeout(300);
}

function parseHourLabel(label) {
  if (!label) return null;
  const match = label.match(/(\d{1,2})\s*h\s*(\d{2})?/i);
  if (!match) return null;
  return parseInt(match[1], 10) + (match[2] ? parseInt(match[2], 10) : 0) / 60;
}

function buildStableUid(ev) {
  const raw = `${ev.date}|${ev.time}|${ev.title}`;
  return crypto.createHash('md5').update(raw).digest('hex') + '@cnam-calendar-sync';
}

const stripCourseCode = (title) => title.replace(/^\[[^\]]+\]\s*/, '').trim();

async function waitFor(locator, timeout) {
  return locator
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // 1. Connexion via le portail lecnam.net (même parcours qu'un humain).
  console.log('Connexion via lecnam.net...');
  await page.goto('https://www.lecnam.net', { waitUntil: 'domcontentloaded' });
  const connectLink = page.getByText('Se connecter', { exact: false }).first();
  await connectLink.waitFor({ timeout: 20000 });
  await connectLink.click();
  await page.waitForSelector('#identifiant', { timeout: 20000 });
  await page.fill('#identifiant', USERNAME);
  await page.fill('#mdp', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('button.btn.btn-primary-color[type="submit"]'),
  ]);

  // 2. Accès au PEC ; SSO via la popup si l'écran de choix s'affiche.
  console.log('Accès au calendrier PEC...');
  await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded' });

  const choiceVisible = await waitFor(
    page.getByText('SE CONNECTER AVEC CNAM', { exact: false }).first(),
    15000
  );
  if (choiceVisible) {
    const popupPromise = page.waitForEvent('popup');
    await page.getByText('SE CONNECTER AVEC CNAM', { exact: false }).first().click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded').catch(() => {});

    const needsCredentials = await popup
      .waitForSelector('#identifiant', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (needsCredentials) {
      await popup.fill('#identifiant', USERNAME);
      await popup.fill('#mdp', PASSWORD);
      await popup.click('button.btn.btn-primary-color[type="submit"]');
    }
    await popup.waitForEvent('close', { timeout: 20000 }).catch(() => {});
    await popup.close().catch(() => {});
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded' });
  }

  // 3. Sélection de la session si l'écran apparaît.
  const sessionModal = await waitFor(
    page.getByText('Sélectionner une session', { exact: false }).first(),
    20000
  );
  console.log('Sélection de session nécessaire ?', sessionModal);
  if (sessionModal) {
    const program = page.getByText(SESSION_PROGRAM, { exact: false }).first();
    if (!(await waitFor(program, 3000))) {
      await page.getByText('CNAM Pays de la Loire', { exact: false }).first().click();
      await page.waitForTimeout(500);
      await page.getByText(SESSION_YEAR, { exact: false }).first().click();
      await page.waitForTimeout(500);
    }
    await program.click();
    await page.waitForTimeout(1500);
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded' });
  }

  // 4. Le calendrier doit être là, sinon on s'arrête sans rien écrire.
  try {
    await page.waitForSelector('td.fc-daygrid-day', { timeout: 20000 });
  } catch (err) {
    console.error('Calendrier introuvable. URL finale :', page.url().split('?')[0]);
    throw err;
  }

  // 5. Parcours des mois.
  for (let i = 0; i < MONTHS_BACKWARD; i++) await goToAdjacentMonth(page, 'prev');

  const allEvents = [];
  const totalMonths = MONTHS_BACKWARD + MONTHS_FORWARD + 1;
  for (let m = 0; m < totalMonths; m++) {
    const monthEvents = await extractMonthEvents(page);
    console.log(`Mois ${m + 1}/${totalMonths} : ${monthEvents.length} événements`);
    allEvents.push(...monthEvents);
    if (m < totalMonths - 1) await goToAdjacentMonth(page, 'next');
  }
  await browser.close();

  // 6. Génération du .ics (sans noms de profs, uniquement des initiales).
  const cal = ical({ name: 'Emploi du temps Cnam' });
  const seen = new Set();

  for (const ev of allEvents) {
    if (!ev.date || !ev.title) continue;
    const uid = buildStableUid(ev);
    if (seen.has(uid)) continue;
    seen.add(uid);

    const summary = stripCourseCode(ev.title);
    const description = ev.initials ? `Prof : ${ev.initials}` : undefined;
    const hour = parseHourLabel(ev.time);

    if (hour === null) {
      cal.createEvent({ id: uid, start: ev.date, allDay: true, summary, description });
    } else {
      const [y, mo, d] = ev.date.split('-').map((n) => parseInt(n, 10));
      const start = new Date(y, mo - 1, d, Math.floor(hour), Math.round((hour % 1) * 60));
      const end = new Date(start.getTime() + DEFAULT_DURATION_HOURS * 3600 * 1000);
      cal.createEvent({ id: uid, start, end, summary, description });
    }
  }

  // Garde-fou : ne jamais écraser un bon fichier par un fichier quasi vide.
  if (seen.size < 5) {
    throw new Error(`Seulement ${seen.size} événements extraits : fichier non écrasé.`);
  }

  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/calendar.ics', cal.toString());
  console.log(`docs/calendar.ics généré : ${seen.size} événements.`);
})().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
