# Capture de l'app Stripe sur iPhone (depuis un Mac)

Deux niveaux, du plus simple au plus automatisé. Commence par le **niveau 1** :
il marche en 10 minutes et suffit dans 90 % des cas.

Prérequis communs :

- iPhone branché en USB au Mac, déverrouillé, « Se fier à cet ordinateur » accepté.
- iOS 16+ : Réglages → Confidentialité et sécurité → **Mode développeur** → activé
  (l'iPhone redémarre).

---

## Niveau 1 — Capture semi-automatique (`capture-manual.sh`)

Tu navigues à la main dans l'app, le Mac capture l'écran en continu et ne garde
que les images qui changent. Aucun risque : le script ne touche jamais à
l'iPhone, il ne fait que lire l'écran.

```bash
brew install libimobiledevice imagemagick
./capture-manual.sh ~/Desktop/stripe-captures
```

Puis sur l'iPhone : ouvre Stripe et parcours chaque onglet en scrollant
jusqu'en bas. Le script écrit une PNG à chaque écran distinct et affiche le
compteur en direct. `Ctrl+C` pour arrêter.

`imagemagick` est optionnel — sans lui le script déduplique sur le hash exact
au lieu d'une comparaison visuelle (donc un peu plus d'images quasi identiques).

---

## Niveau 2 — Crawl automatique (`crawl.mjs`)

Appium pilote réellement l'app : il ouvre chaque onglet, scrolle jusqu'en bas de
chaque écran, ouvre les lignes de liste, et capture tout. **Navigation seule** :
une liste noire bloque tout ce qui déclenche une action (rembourser, annuler,
supprimer, envoyer, se déconnecter…).

### Installation

```bash
brew install node
npm install -g appium
appium driver install xcuitest
npm install            # dans ce dossier, installe webdriverio
```

Première exécution : Appium doit compiler et **signer WebDriverAgent** avec ton
compte Apple (un compte gratuit suffit). Si ça échoue, ouvre
`~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj`
dans Xcode, sélectionne la cible `WebDriverAgentRunner`, onglet **Signing &
Capabilities**, coche *Automatically manage signing* et choisis ton équipe.
Puis sur l'iPhone : Réglages → Général → VPN et gestion de l'appareil → fais
confiance à ton certificat développeur.

### Trouver l'UDID et le bundle ID

```bash
xcrun xctrace list devices          # UDID de l'iPhone
xcrun devicectl device info apps --device <UDID> | grep -i stripe
```

### Lancer

```bash
appium                                    # dans un terminal, laisse tourner
UDID=<ton-udid> BUNDLE_ID=<bundle-stripe> IOS_VERSION=18.0 \
  node crawl.mjs ~/Desktop/stripe-crawl   # dans un second terminal
```

Sortie : une PNG par état visité, plus `index.json` qui décrit l'arbre de
navigation parcouru (écran, profondeur, élément tapé, fichier).

### Réglages utiles

| Variable | Défaut | Rôle |
|---|---|---|
| `MAX_DEPTH` | `3` | Profondeur de navigation depuis chaque onglet |
| `MAX_SCREENS` | `200` | Garde-fou global |
| `MAX_SCROLLS` | `15` | Scrolls max par écran avant d'abandonner |
| `DRY_RUN` | `0` | À `1`, log les taps sans les exécuter |

### Sécurité

`crawl.mjs` applique deux barrières cumulées :

1. **Allowlist de types** — seuls les onglets, cellules, liens et chevrons sont
   tapables. Les boutons libres d'une barre d'outils ne le sont pas.
2. **Denylist de libellés** (`DESTRUCTIVE` dans le script) — tout label
   contenant rembours/refund, annul/cancel, supprim/delete, envoy/send,
   déconnex/sign out, etc. est ignoré, quel que soit son type.

Relis et adapte `DESTRUCTIVE` avant le premier run en production. Pour un test
sans aucun risque, bascule d'abord ton compte Stripe en **mode Test** dans
l'app.
