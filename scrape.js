// scrape.js
//
// Se connecte au Passeport Électronique de Compétences du Cnam,
// parcourt le calendrier (FullCalendar) mois par mois, et génère
// un fichier .ics standard dans docs/calendar.ics.
//
// Variables d'environnement attendues :
//   CNAM_USERNAME       identifiant Cnam
//   CNAM_PASSWORD       mot de passe Cnam
//   CALENDAR_URL        URL de la page calendrier (avec le token perso)
//   MONTHS_FORWARD       nombre de mois à scraper vers l'avenir (défaut 6)
//   MONTHS_BACKWARD       nombre de mois à scraper vers le passé (défaut 1)
//   DEFAULT_DURATION_HOURS  durée par défaut d'un cours sans heure de fin (défaut 3)

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

if (!USERNAME || !PASSWORD || !CALENDAR_URL) {
  console.error('CNAM_USERNAME, CNAM_PASSWORD et CALENDAR_URL sont requis.');
  process.exit(1);
}

// Extrait tous les événements visibles dans la vue "mois" actuellement affichée.
async function extractMonthEvents(page) {
  return page.$$eval('td.fc-daygrid-day', (cells) => {
    const results = [];
    cells.forEach((cell) => {
      const date = cell.getAttribute('data-date'); // ex: "2026-08-31"
      const eventLinks = cell.querySelectorAll('a.fc-event');
      eventLinks.forEach((a) => {
        const timeEl = a.querySelector('.fc-event-time');
        const titleEl = a.querySelector('.fc-event-title');
        const ariaEl = a.querySelector('[aria-label]');
        let teacher = null;
        if (ariaEl) {
          const label = ariaEl.getAttribute('aria-label') || '';
          teacher = label.replace(/-\s*$/, '').trim() || null;
        }
        results.push({
          date,
          time: timeEl ? timeEl.textContent.trim() : null, // ex: "09 h"
          title: titleEl ? titleEl.textContent.trim() : (a.textContent || '').trim(),
          teacher,
        });
      });
    });
    return results;
  });
}

// Clique sur "suivant" ou "précédent" et attend que le calendrier ait bien changé de mois.
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
  // petite marge pour laisser le temps au rendu de se stabiliser
  await page.waitForTimeout(300);
}

function parseHourLabel(label) {
  // "09 h" -> 9 ; "09h30" -> 9.5 ; null -> null
  if (!label) return null;
  const match = label.match(/(\d{1,2})\s*h\s*(\d{2})?/i);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  return hours + minutes / 60;
}

function buildStableUid(ev) {
  const raw = `${ev.date}|${ev.time}|${ev.title}`;
  return crypto.createHash('md5').update(raw).digest('hex') + '@cnam-calendar-sync';
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Navigation vers le calendrier...');
  await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded' });
  console.log('URL après premier chargement :', page.url());

  // Si un formulaire de connexion est présent, on se connecte.
  const loginFieldSelector = '#identifiant';
  const isLoginPage = await page.$(loginFieldSelector);
  console.log('Formulaire de connexion détecté ?', !!isLoginPage);
  if (isLoginPage) {
    console.log('Connexion en cours...');
    await page.fill('#identifiant', USERNAME);
    await page.fill('#mdp', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.click('button.btn.btn-primary-color[type="submit"]'),
    ]);
    console.log('URL après tentative de connexion :', page.url());
  }

  // On attend que le calendrier soit bien chargé (peut nécessiter une redirection
  // supplémentaire vers la page calendrier après connexion).
  try {
    await page.waitForSelector('td.fc-daygrid-day', { timeout: 15000 });
  } catch {
    console.log('Calendrier non trouvé, nouvelle tentative de navigation directe...');
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded' });
    console.log('URL après seconde tentative :', page.url());
    try {
      await page.waitForSelector('td.fc-daygrid-day', { timeout: 15000 });
    } catch (err) {
      console.log('Échec définitif. Capture de débogage en cours...');
      fs.mkdirSync('debug', { recursive: true });
      await page.screenshot({ path: 'debug/failure.png', fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      fs.writeFileSync('debug/failure.html', html);
      console.log('URL finale :', page.url());
      throw err;
    }
  }

  console.log('Connecté. Recul de %d mois...', MONTHS_BACKWARD);
  for (let i = 0; i < MONTHS_BACKWARD; i++) {
    await goToAdjacentMonth(page, 'prev');
  }

  const allEvents = [];
  const totalMonths = MONTHS_BACKWARD + MONTHS_FORWARD + 1;

  for (let m = 0; m < totalMonths; m++) {
    console.log(`Extraction du mois ${m + 1}/${totalMonths}...`);
    allEvents.push(...(await extractMonthEvents(page)));
    if (m < totalMonths - 1) {
      await goToAdjacentMonth(page, 'next');
    }
  }

  await browser.close();

  console.log(`${allEvents.length} événements bruts extraits. Génération du fichier .ics...`);

  const cal = ical({ name: 'Emploi du temps Cnam' });

  // Déduplique (le même événement peut apparaître si un mois est vu deux fois)
  const seen = new Set();

  for (const ev of allEvents) {
    if (!ev.date || !ev.title) continue;
    const uid = buildStableUid(ev);
    if (seen.has(uid)) continue;
    seen.add(uid);

    const hourDecimal = parseHourLabel(ev.time);

    if (hourDecimal === null) {
      // Événement sans heure précise (ex: "Indisponible", "Entreprise") -> journée entière
      cal.createEvent({
        id: uid,
        start: ev.date,
        allDay: true,
        summary: ev.title,
        description: ev.teacher || undefined,
      });
    } else {
      const [year, month, day] = ev.date.split('-').map((n) => parseInt(n, 10));
      const startHour = Math.floor(hourDecimal);
      const startMinute = Math.round((hourDecimal - startHour) * 60);
      const start = new Date(year, month - 1, day, startHour, startMinute);
      const end = new Date(start.getTime() + DEFAULT_DURATION_HOURS * 60 * 60 * 1000);

      cal.createEvent({
        id: uid,
        start,
        end,
        summary: ev.title,
        description: ev.teacher || undefined,
      });
    }
  }

  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/calendar.ics', cal.toString());

  console.log(`Fichier docs/calendar.ics généré avec ${seen.size} événements uniques.`);
})().catch((err) => {
  console.error('Erreur pendant le scraping :', err);
  process.exit(1);
});
