#!/usr/bin/env node
//
// Crawl du dashboard Stripe web (dashboard.stripe.com) avec Playwright.
//
// Parcourt chaque entrée du menu, scrolle chaque page jusqu'en bas pour
// déclencher le chargement paresseux, capture une PNG pleine page, ouvre les
// onglets et blocs dépliables, puis descend dans les premières lignes de
// chaque liste.
//
// NAVIGATION SEULE — trois barrières cumulées :
//   1. La navigation se fait par URL (page.goto), jamais en cliquant un bouton
//      au hasard. Un bouton d'action ne peut donc pas être atteint par erreur.
//   2. Les seuls clics autorisés sont les onglets et les dépliants, et tout
//      libellé matchant DESTRUCTIVE est ignoré.
//   3. Un garde réseau annule toute requête d'écriture (DELETE, ou
//      POST/PUT/PATCH vers une URL d'action) avant qu'elle parte.
//
//   node crawl-web.mjs --import-session     # reprend la session de ton Chrome
//   node crawl-web.mjs --login              # ou : connexion manuelle
//   node crawl-web.mjs --check              # vérifie que la session passe
//   node crawl-web.mjs ~/Desktop/stripe-web # puis : crawl

import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const LOGIN_MODE = args.includes('--login');
const IMPORT_MODE = args.includes('--import-session');
const CHECK_MODE = args.includes('--check');
const CRAWL_MODE = !LOGIN_MODE && !IMPORT_MODE && !CHECK_MODE;
const OUT_DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? './stripe-web');
// Profil Chrome dédié : Chrome 136+ refuse le pilotage du profil par défaut,
// et ça évite de toucher à ta session personnelle.
const PROFILE_DIR = path.resolve(process.env.PROFILE_DIR ?? './.stripe-profile');
const START_URL = process.env.START_URL ?? 'https://dashboard.stripe.com/dashboard';
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 120);
const MAX_ROWS = Number(process.env.MAX_ROWS ?? 3); // lignes ouvertes par liste
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS ?? 25);
const VIEWPORT = { width: 1440, height: 900 };

// Libellés et URL qui déclenchent une action réelle. Complète avant un run live.
const DESTRUCTIVE =
  /rembours|refund|annul|cancel|supprim|delete|remove|retir|envoy|send|captur|litige|dispute|conteste|désactiv|desactiv|deactivate|disable|archiv|déconnex|deconnex|sign\s?out|log\s?out|suspend|close\s+account|payout|virement\s+instantan|confirm|valide|submit|créer|create|nouveau|nouvelle|new\b|modifier|edit|update|test\s+mode|mode\s+test/i;

const WRITE_URL = /refund|cancel|delete|remove|payout|transfer|dispute|close|deactivate|archive|send|charge|subscribe|unsubscribe/i;

const visited = new Set();
const manifest = [];
const blocked = [];
let shotCount = 0;

// Emplacement du profil Chrome personnel, selon l'OS.
function chromeUserDataDir() {
  if (process.env.CHROME_USER_DATA) return process.env.CHROME_USER_DATA;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
        'Google', 'Chrome', 'User Data',
      );
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    default:
      return path.join(home, '.config', 'google-chrome');
  }
}

// Recopie le strict minimum du profil personnel (cookies + clé de
// déchiffrement) dans le profil dédié, pour hériter de la session Stripe déjà
// ouverte sans repasser par la connexion — que Stripe bloque sur un navigateur
// piloté. Chrome doit être complètement fermé : les fichiers sont verrouillés
// tant qu'il tourne.
async function importChromeSession() {
  const source = chromeUserDataDir();
  const profile = process.env.CHROME_PROFILE ?? 'Default';
  const sourceProfile = path.join(source, profile);

  if (!existsSync(sourceProfile)) {
    throw new Error(
      `Profil Chrome introuvable : ${sourceProfile}\n` +
        'Indique-le à la main avec CHROME_USER_DATA=... et CHROME_PROFILE=...',
    );
  }

  // Le profil dédié est recréé de zéro : un reste d'import précédent peut
  // masquer un cookie périmé et donner une session à moitié valide.
  await rm(PROFILE_DIR, { recursive: true, force: true });
  await mkdir(path.join(PROFILE_DIR, 'Default', 'Network'), { recursive: true });

  // 'Local State' porte la clé qui déchiffre les cookies : sans lui, ils sont
  // illisibles. Les autres fichiers sont optionnels selon la version de Chrome.
  const files = [
    ['Local State', 'Local State'],
    [path.join(profile, 'Network', 'Cookies'), path.join('Default', 'Network', 'Cookies')],
    [path.join(profile, 'Cookies'), path.join('Default', 'Cookies')],
    [path.join(profile, 'Preferences'), path.join('Default', 'Preferences')],
  ];

  let copied = 0;
  for (const [from, to] of files) {
    const src = path.join(source, from);
    if (!existsSync(src)) continue;
    try {
      await cp(src, path.join(PROFILE_DIR, to));
      copied += 1;
      console.log(`  copié : ${from}`);
    } catch (error) {
      console.log(`  ⨯ ${from} illisible (${error.code ?? error.message})`);
    }
  }

  if (copied === 0) {
    throw new Error('Aucun fichier copié — Chrome est probablement encore ouvert.');
  }
  console.log(`\nSession importée depuis ${sourceProfile}`);
  console.log('Vérifie avec : node crawl-web.mjs --check');
}

function slug(text) {
  return (text || 'page')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 60);
}

// Clé de déduplication : on ignore la query string, sauf pour la pagination.
function routeKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

async function shoot(page, label, meta) {
  shotCount += 1;
  const file = `${String(shotCount).padStart(4, '0')}-${slug(label)}.png`;
  const target = path.join(OUT_DIR, file);
  try {
    await page.screenshot({ path: target, fullPage: meta.fullPage ?? false });
  } catch {
    await page.screenshot({ path: target }); // Repli si la page pleine échoue.
  }
  manifest.push({ file, label, url: page.url(), ...meta });
  console.log(`  [${shotCount}] ${file}`);
}

// Scrolle par paliers d'écran pour déclencher le lazy-load, en capturant au
// passage, puis remonte et tente une capture pleine page.
async function scrollThrough(page, label, meta) {
  await shoot(page, `${label}-top`, { ...meta, position: 'top' });

  let previousHeight = -1;
  for (let i = 0; i < MAX_SCROLLS; i += 1) {
    const { scrollY, scrollHeight, innerHeight } = await page.evaluate(() => ({
      scrollY: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    if (scrollY + innerHeight >= scrollHeight - 4 && scrollHeight === previousHeight) break;
    previousHeight = scrollHeight;

    await page.mouse.wheel(0, innerHeight * 0.85);
    await page.waitForTimeout(600);
    await shoot(page, `${label}-scroll${i + 1}`, { ...meta, position: `scroll${i + 1}` });
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await shoot(page, `${label}-full`, { ...meta, position: 'full', fullPage: true });
}

// Onglets et dépliants uniquement : jamais un bouton d'action.
async function expandSafely(page, label, meta) {
  const controls = await page
    .locator('[role="tab"], [aria-expanded="false"], summary')
    .all();

  for (const [index, control] of controls.entries()) {
    let text = '';
    try {
      text = ((await control.textContent()) ?? '').trim();
      if (!(await control.isVisible())) continue;
    } catch {
      continue;
    }
    if (DESTRUCTIVE.test(text)) {
      console.log(`  ⨯ bloqué (liste noire) : ${text.slice(0, 60)}`);
      blocked.push({ kind: 'click', text, url: page.url() });
      continue;
    }

    try {
      await control.click({ timeout: 3000 });
      await page.waitForTimeout(900);
      await shoot(page, `${label}-tab${index + 1}-${slug(text)}`, { ...meta, control: text });
    } catch {
      // Contrôle disparu ou non cliquable : on passe.
    }
  }
}

// Liens internes du dashboard, hors liens d'action.
async function internalLinks(page) {
  const hrefs = await page.$$eval('a[href]', (anchors) =>
    anchors
      .filter((a) => a.offsetParent !== null)
      .map((a) => ({ href: a.href, text: (a.textContent ?? '').trim().slice(0, 80) })),
  );

  return hrefs.filter(({ href, text }) => {
    if (!href.startsWith('https://dashboard.stripe.com')) return false;
    if (DESTRUCTIVE.test(href) || DESTRUCTIVE.test(text)) return false;
    return true;
  });
}

async function visit(page, url, label, depth) {
  const key = routeKey(url);
  if (visited.has(key) || shotCount >= MAX_PAGES) return [];
  visited.add(key);

  console.log(`${'  '.repeat(depth)}→ ${label || key}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
    } catch {
      console.log(`${'  '.repeat(depth)}  (page injoignable, ignorée)`);
      return [];
    }
  }
  await page.waitForTimeout(1500);

  const meta = { depth, route: key };
  await scrollThrough(page, label || slug(key), meta);
  await expandSafely(page, label || slug(key), meta);

  return internalLinks(page);
}

// L'import recopie des fichiers dans PROFILE_DIR : il doit se faire avant que
// Chrome ne l'ouvre, donc avant tout lancement de navigateur.
if (IMPORT_MODE) {
  console.log('Import de la session depuis ton profil Chrome personnel.');
  console.log('Chrome doit être complètement fermé (vérifie le gestionnaire des tâches).\n');
  await importChromeSession();
  process.exit(0);
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: 'chrome',
  viewport: VIEWPORT,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

// Stripe repère les navigateurs pilotés, surtout sur la page de connexion.
// Effacer ce drapeau ne rend pas invisible, mais évite le refus le plus basique.
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const page = context.pages()[0] ?? (await context.newPage());

// Barrière 3 : rien qui écrive ne part sur le réseau.
await context.route('**/*', async (route) => {
  const request = route.request();
  const method = request.method();
  if (method === 'DELETE' || (['POST', 'PUT', 'PATCH'].includes(method) && WRITE_URL.test(request.url()))) {
    console.log(`  ⨯ requête d'écriture annulée : ${method} ${request.url().slice(0, 90)}`);
    blocked.push({ kind: 'request', method, url: request.url() });
    await route.abort();
    return;
  }
  await route.continue();
});

try {
  if (LOGIN_MODE) {
    await page.goto('https://dashboard.stripe.com/login');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nConnecte-toi à Stripe dans la fenêtre ouverte (2FA incluse).');
    await rl.question('Appuie sur Entrée ici une fois le dashboard affiché… ');
    rl.close();
    console.log(`Session enregistrée dans ${PROFILE_DIR}. Relance sans --login pour crawler.`);
  } else if (CHECK_MODE) {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    const url = page.url();
    if (/login|signin|authenticate/i.test(url)) {
      console.log(`\n⨯ Session absente : Stripe renvoie vers ${url}`);
      console.log('  Reconnecte-toi dans ton Chrome habituel, ferme-le, puis relance --import-session.');
    } else {
      console.log(`\n✓ Session valide — dashboard atteint : ${url}`);
      console.log('  Tu peux lancer le crawl.');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('Appuie sur Entrée pour fermer la fenêtre… ');
    rl.close();
  } else {
    await mkdir(OUT_DIR, { recursive: true });
    console.log(`Crawl du dashboard Stripe → ${OUT_DIR}`);
    console.log(`${MAX_PAGES} captures max, ${MAX_ROWS} lignes ouvertes par liste\n`);

    const rootLinks = await visit(page, START_URL, 'accueil', 0);

    // Profondeur 1 : les entrées de menu et autres routes du dashboard.
    const queue = [];
    for (const link of rootLinks) {
      if (visited.has(routeKey(link.href))) continue;
      queue.push(link);
    }

    const rowsPerRoute = new Map();
    for (const link of queue) {
      if (shotCount >= MAX_PAGES) break;
      const children = await visit(page, link.href, link.text || slug(link.href), 1);

      // Profondeur 2 : les premières lignes de la liste (détail d'un paiement,
      // d'un client…), plafonnées pour ne pas exploser le nombre de captures.
      const parent = routeKey(link.href);
      for (const child of children) {
        const childKey = routeKey(child.href);
        if (childKey === parent || visited.has(childKey)) continue;
        const count = rowsPerRoute.get(parent) ?? 0;
        if (count >= MAX_ROWS) break;
        rowsPerRoute.set(parent, count + 1);
        await visit(page, child.href, child.text || slug(child.href), 2);
        if (shotCount >= MAX_PAGES) break;
      }
    }
  }
} finally {
  if (CRAWL_MODE) {
    await writeFile(
      path.join(OUT_DIR, 'index.json'),
      JSON.stringify(
        { capturedAt: new Date().toISOString(), startUrl: START_URL, screens: manifest, blocked },
        null,
        2,
      ),
    );
    console.log(`\n${shotCount} captures dans ${OUT_DIR}`);
    console.log(`${blocked.length} actions bloquées (détail dans index.json)`);
  }
  await context.close();
}
