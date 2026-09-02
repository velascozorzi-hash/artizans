# Capture des écrans Stripe

Trois outils, du plus simple au plus automatisé. **Commence par le web
(`crawl-web.mjs`)** : c'est le seul entièrement automatique, et le dashboard web
contient tout ce que l'app mobile montre.

| Outil | Cible | Automatique ? | Installation |
|---|---|---|---|
| `crawl-web.mjs` | dashboard.stripe.com | Oui, de bout en bout | Node + Playwright |
| `capture-manual.sh` | App iOS | Non, tu navigues | `brew install libimobiledevice` |
| `crawl-ios.mjs` | App iOS | Oui | Appium + Xcode + WebDriverAgent signé |

```bash
cd tools/stripe-capture
npm install
```

---

## 1. Dashboard web — `crawl-web.mjs`

Parcourt chaque entrée du menu, scrolle chaque page jusqu'en bas (ce qui
déclenche le chargement paresseux), capture une PNG pleine page, ouvre les
onglets et blocs dépliables, puis descend dans les premières lignes de chaque
liste. Écrit `index.json` décrivant tout ce qui a été visité et tout ce qui a
été bloqué.

```bash
npx playwright install chrome       # une fois

node crawl-web.mjs --import-session # reprend la session de ton Chrome
node crawl-web.mjs --check          # vérifie qu'elle passe
node crawl-web.mjs ~/Desktop/stripe-web
```

### Obtenir une session — deux voies

Le script travaille dans un **profil Chrome dédié** (`.stripe-profile/`), séparé
de ta session personnelle. Ce profil doit contenir une session Stripe valide.

**`--import-session` (recommandé).** Recopie les cookies de ton profil Chrome
personnel dans le profil dédié : tu es déjà connecté, donc aucune connexion à
refaire. **Chrome doit être complètement fermé** pendant l'import — les fichiers
de cookies sont verrouillés tant qu'il tourne. Vérifie ensuite avec `--check`.

```bash
# Si ton profil n'est pas le profil par défaut :
CHROME_PROFILE="Profile 1" node crawl-web.mjs --import-session
```

**`--login`.** Ouvre une fenêtre où tu te connectes à la main. Stripe détecte
souvent les navigateurs pilotés et bloque l'envoi du code 2FA (« An unknown
error has occurred », SMS jamais reçu) — d'où `--import-session` en premier
choix.

Un profil séparé est de toute façon obligatoire : Chrome 136+ refuse de piloter
le profil par défaut. Ne commite jamais `.stripe-profile/`, il contient tes
cookies de session.

### Réglages

| Variable | Défaut | Rôle |
|---|---|---|
| `MAX_PAGES` | `120` | Nombre total de captures avant arrêt |
| `MAX_ROWS` | `3` | Lignes de liste ouvertes par page (détail d'un paiement, d'un client…) |
| `MAX_SCROLLS` | `25` | Paliers de scroll max par page |
| `START_URL` | `.../dashboard` | Point de départ |
| `PROFILE_DIR` | `./.stripe-profile` | Profil Chrome à réutiliser |
| `CHROME_PROFILE` | `Default` | Profil personnel à importer (`Profile 1`, …) |
| `CHROME_USER_DATA` | auto | Dossier « User Data » de Chrome, si non standard |

```bash
MAX_PAGES=400 MAX_ROWS=10 node crawl-web.mjs ~/Desktop/stripe-web
```

### Sécurité — navigation seule

Trois barrières cumulées :

1. **La navigation se fait par URL** (`page.goto`), jamais en cliquant un bouton
   au hasard. Un bouton d'action ne peut donc pas être atteint par accident.
2. **Seuls les onglets et dépliants sont cliqués** (`[role=tab]`,
   `[aria-expanded=false]`, `summary`), et tout libellé matchant `DESTRUCTIVE`
   est ignoré.
3. **Un garde réseau annule toute requête d'écriture** avant qu'elle parte :
   tout `DELETE`, et tout `POST`/`PUT`/`PATCH` vers une URL d'action. C'est le
   filet de sécurité si les deux premières barrières laissent passer quelque
   chose.

Tout ce qui est bloqué est loggé dans le terminal et listé dans `index.json`,
section `blocked` — lis-la après le premier run pour voir ce que le crawl a
volontairement évité.

Relis `DESTRUCTIVE` en haut du fichier avant un run en production. Pour un
premier essai sans aucun risque, bascule ton compte en **mode Test** dans le
dashboard avant de lancer.

---

## 2. App iOS, capture semi-automatique — `capture-manual.sh`

Tu navigues à la main, le Mac capture l'écran en continu et ne garde que les
images qui changent. Le script ne fait que **lire** l'écran, il ne pilote jamais
le téléphone.

Sur l'iPhone : branché en USB, déverrouillé, « Se fier à cet ordinateur »
accepté, et Réglages → Écran et luminosité → Verrouillage auto → **Jamais**.

```bash
brew install libimobiledevice imagemagick

idevice_id -l                      # doit afficher un UDID
idevicescreenshot /tmp/test.png    # doit écrire une image

./capture-manual.sh ~/Desktop/stripe-captures
```

`imagemagick` est optionnel : sans lui, la déduplication se fait sur le hash
exact au lieu d'une comparaison visuelle (donc plus d'images quasi identiques).

Sur iOS 17+, `idevicescreenshot` peut échouer faute de tunnel développeur.
Repli natif Mac sans installation : QuickTime → Fichier → Nouvel enregistrement
vidéo → choisis l'iPhone comme source, puis capture la fenêtre.

---

## 3. App iOS, crawl automatique — `crawl-ios.mjs`

Appium pilote réellement l'app : ouvre chaque onglet, scrolle jusqu'en bas,
ouvre les lignes de liste, capture tout. C'est l'option la plus lourde à
installer — n'y va que si le web ne suffit pas.

Prérequis : iOS 16+ avec Réglages → Confidentialité et sécurité → **Mode
développeur** activé (l'iPhone redémarre).

```bash
npm install -g appium
appium driver install xcuitest
```

Première exécution : Appium doit compiler et **signer WebDriverAgent** avec ton
compte Apple (un compte gratuit suffit). Si ça échoue, ouvre
`~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj`
dans Xcode, cible `WebDriverAgentRunner`, onglet **Signing & Capabilities**,
coche *Automatically manage signing* et choisis ton équipe. Puis sur l'iPhone :
Réglages → Général → VPN et gestion de l'appareil → fais confiance à ton
certificat.

```bash
xcrun xctrace list devices                                    # UDID
xcrun devicectl device info apps --device <UDID> | grep -i stripe   # bundle ID

appium                                    # terminal 1
UDID=<udid> BUNDLE_ID=<bundle> IOS_VERSION=18.0 \
  node crawl-ios.mjs ~/Desktop/stripe-crawl                   # terminal 2
```

Fais un premier passage avec `DRY_RUN=1` : il logue tout ce qu'il taperait sans
rien taper.

| Variable | Défaut | Rôle |
|---|---|---|
| `MAX_DEPTH` | `3` | Profondeur de navigation depuis chaque onglet |
| `MAX_SCREENS` | `200` | Garde-fou global |
| `MAX_SCROLLS` | `15` | Scrolls max par écran |
| `DRY_RUN` | `0` | À `1`, logue les taps sans les exécuter |

Même principe de navigation seule que le web, avec deux barrières : une
allowlist de types d'éléments (cellules, onglets, liens, chevrons — pas les
boutons de barre d'outils, où vivent les actions) et la denylist `DESTRUCTIVE`.
