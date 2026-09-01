#!/usr/bin/env node
//
// Crawl automatique de l'app Stripe iOS via Appium + XCUITest.
//
// Parcourt chaque onglet, scrolle chaque écran jusqu'en bas, ouvre les lignes
// de liste, et capture une PNG par état. NAVIGATION SEULE : deux barrières
// (allowlist de types + denylist de libellés) empêchent de déclencher une
// action réelle sur le compte.
//
//   appium                                   # terminal 1
//   UDID=... BUNDLE_ID=... node crawl.mjs ~/Desktop/stripe-crawl   # terminal 2

import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { remote } from 'webdriverio';

const OUT_DIR = path.resolve(process.argv[2] ?? './stripe-crawl');
const UDID = process.env.UDID;
const BUNDLE_ID = process.env.BUNDLE_ID;
const IOS_VERSION = process.env.IOS_VERSION ?? '18.0';
const MAX_DEPTH = Number(process.env.MAX_DEPTH ?? 3);
const MAX_SCREENS = Number(process.env.MAX_SCREENS ?? 200);
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS ?? 15);
const DRY_RUN = process.env.DRY_RUN === '1';

if (!UDID || !BUNDLE_ID) {
  console.error('UDID et BUNDLE_ID sont obligatoires. Pour les trouver :');
  console.error('  xcrun xctrace list devices');
  console.error('  xcrun devicectl device info apps --device <UDID> | grep -i stripe');
  process.exit(1);
}

// Barrière 1 : seuls ces types d'éléments sont tapables. Un bouton isolé dans
// une barre d'outils ne l'est pas — c'est souvent là que vivent les actions.
const TAPPABLE_TYPES = new Set([
  'XCUIElementTypeCell',
  'XCUIElementTypeLink',
  'XCUIElementTypeTab',
  'XCUIElementTypeTabBar',
  'XCUIElementTypeDisclosureTriangle',
]);

// Barrière 2 : tout libellé qui matche est ignoré, quel que soit son type.
// Relis et complète cette liste avant un run en production.
const DESTRUCTIVE = new RegExp(
  [
    'rembours', 'refund',
    'annul', 'cancel',
    'supprim', 'delete', 'remove', 'retir',
    'envoy', 'send',
    'pay(er|ment)?\\s+(maintenant|now)', 'charge', 'captur',
    'litige', 'dispute', 'conteste',
    'désactiv', 'desactiv', 'deactivate', 'disable',
    'archiv',
    'déconnex', 'deconnex', 'sign\\s?out', 'log\\s?out',
    'suspend', 'ferme[rz]?\\s+le\\s+compte', 'close\\s+account',
    'transfer', 'payout', 'virement\\s+instantan',
    'confirm', 'valide[rz]?', 'submit', 'appliquer',
  ].join('|'),
  'i',
);

const seen = new Set();
const manifest = [];
let shotCount = 0;

// Signature d'un écran : les libellés visibles, hachés. Sert à ne pas
// re-crawler deux fois le même état.
function screenSignature(source) {
  const labels = [...source.matchAll(/(?:name|label)="([^"]{1,80})"/g)]
    .map((m) => m[1])
    .sort()
    .join('|');
  return createHash('sha1').update(labels).digest('hex').slice(0, 16);
}

function slug(text) {
  return (text || 'ecran')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 48);
}

async function shoot(driver, label, meta) {
  shotCount += 1;
  const file = `${String(shotCount).padStart(4, '0')}-${slug(label)}.png`;
  await driver.saveScreenshot(path.join(OUT_DIR, file));
  manifest.push({ file, label, ...meta });
  console.log(`  [${shotCount}] ${file}`);
  return file;
}

// Scrolle jusqu'en bas en capturant chaque palier, puis remonte.
async function scrollThrough(driver, label, meta) {
  await shoot(driver, `${label}-top`, { ...meta, position: 'top' });

  let previous = null;
  for (let i = 0; i < MAX_SCROLLS; i += 1) {
    try {
      await driver.execute('mobile: scroll', { direction: 'down' });
    } catch {
      break; // Écran non scrollable.
    }
    const source = await driver.getPageSource();
    const signature = screenSignature(source);
    if (signature === previous) break; // Bas de page atteint.
    previous = signature;
    await shoot(driver, `${label}-scroll${i + 1}`, { ...meta, position: `scroll${i + 1}` });
  }

  for (let i = 0; i < MAX_SCROLLS; i += 1) {
    try {
      await driver.execute('mobile: scroll', { direction: 'up' });
    } catch {
      break;
    }
  }
}

async function candidates(driver) {
  const elements = await driver.$$('//*[@visible="true"]');
  const out = [];

  for (const element of elements) {
    let type;
    let label;
    try {
      type = await element.getAttribute('type');
      label =
        (await element.getAttribute('label')) ||
        (await element.getAttribute('name')) ||
        '';
    } catch {
      continue; // Élément disparu entre le listing et la lecture.
    }

    if (!TAPPABLE_TYPES.has(type)) continue;
    if (!label.trim()) continue;
    if (DESTRUCTIVE.test(label)) {
      console.log(`  ⨯ bloqué (liste noire) : ${label}`);
      continue;
    }
    out.push({ element, label, type });
  }
  return out;
}

async function walk(driver, depth, trail) {
  if (depth > MAX_DEPTH || shotCount >= MAX_SCREENS) return;

  const signature = screenSignature(await driver.getPageSource());
  if (seen.has(signature)) return;
  seen.add(signature);

  const label = trail.at(-1) ?? 'accueil';
  console.log(`${'  '.repeat(depth)}→ ${trail.join(' / ') || 'accueil'}`);
  await scrollThrough(driver, label, { depth, trail: [...trail] });

  if (depth === MAX_DEPTH) return;

  // On relit les candidats à chaque itération : après un retour arrière, les
  // références d'éléments de la passe précédente sont périmées.
  const targets = (await candidates(driver)).map((c) => c.label);

  for (const target of targets) {
    if (shotCount >= MAX_SCREENS) return;
    if (DESTRUCTIVE.test(target)) continue;

    const fresh = (await candidates(driver)).find((c) => c.label === target);
    if (!fresh) continue;

    if (DRY_RUN) {
      console.log(`${'  '.repeat(depth)}  (dry-run) tap « ${target} »`);
      continue;
    }

    try {
      await fresh.element.click();
      await driver.pause(1200);
    } catch {
      continue;
    }

    await walk(driver, depth + 1, [...trail, target]);

    try {
      await driver.back();
      await driver.pause(800);
    } catch {
      // Pas de retour arrière possible (onglet racine) : on reste sur place.
    }
  }
}

const driver = await remote({
  hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
  port: Number(process.env.APPIUM_PORT ?? 4723),
  logLevel: 'warn',
  capabilities: {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:deviceName': 'iPhone',
    'appium:platformVersion': IOS_VERSION,
    'appium:udid': UDID,
    'appium:bundleId': BUNDLE_ID,
    'appium:noReset': true,
    'appium:newCommandTimeout': 600,
  },
});

try {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`Crawl de ${BUNDLE_ID} → ${OUT_DIR}`);
  console.log(`Profondeur max ${MAX_DEPTH}, ${MAX_SCREENS} écrans max${DRY_RUN ? ' (DRY RUN)' : ''}\n`);
  await walk(driver, 0, []);
} finally {
  await writeFile(
    path.join(OUT_DIR, 'index.json'),
    JSON.stringify({ bundleId: BUNDLE_ID, capturedAt: new Date().toISOString(), screens: manifest }, null, 2),
  );
  await driver.deleteSession();
  console.log(`\n${shotCount} captures dans ${OUT_DIR} (voir index.json)`);
}
