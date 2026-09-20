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

async function extractMonthEvents(page) {
  return page.$$eval('td.fc-daygrid-day', (cells) => {
    const results = [];
    cells.forEach((cell) => {
      const date = cell.getAttribute('data-date');
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
          time: timeEl ? timeEl.textContent.trim() : null,
          title: titleEl ? titleEl.textContent.trim() : (a.textContent || '').trim(),
          teacher,
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
  const hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  return hours + minutes / 60;
}

function buildStableUid(ev) {
  const raw = `${ev.date}|${ev.time}|${ev.title}`;
  return crypto.createHash('md5').update(raw).digest('hex') + '@cnam-calendar-sync';
}

async function waitForAnyState(page, timeout) {
  const attempts = [
    page.waitForSelector('#identifiant', { timeout }).then(() => 'login'),
    page.waitForSelector('td.fc-daygrid-day', { timeout }).then(() => 'calendar'),
    page
      .getByText('SE CONNECTER AVEC VOS IDENTIFIANTS', { exact: false })
      .first()
      .waitFor({ timeout })
      .then(() => 'choice'),
  ];
  return Promise.any(attempts);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Navigation vers le calendrier...');
  await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded' });
  console.log('URL après premier chargement :', page.url());

  let state;
  try {
    state = await waitForAnyState(page, 30000);
    console.log('État détecté :', state);
  } catch (err) {
    console.log('Aucun état reconnu. Capture de débogage...');
    fs.mkdirSync('debug', { recursive: true });
    await page.screenshot({ path: 'debug/failure.png', fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    fs.writeFileSync('debug/failure.html', html);
    console.log('URL finale :', page.url());
    throw err;
  }

  if (state === 'choice') {
    console.log('Page de choix détectée, clic sur "Se connecter avec vos identifiants"...');
    await page.getByText('SE CONNECTER AVEC VOS IDENTIFIANTS', { exact: false }).first().click();
    console.log('URL juste après le clic :', page.url());
    try {
      await page.waitForSelector('#identifiant', { timeout: 20000 });
    } catch (err) {
      console.log('Formulaire toujours introuvable après le clic. Capture de débogage...');
      fs.mkdirSync('debug', { recursive: true });
      await page.screenshot({ path: 'debug/failure.png',
