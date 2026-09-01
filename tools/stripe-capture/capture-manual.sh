#!/usr/bin/env bash
#
# Capture en continu l'écran d'un iPhone branché en USB, en ne conservant que
# les images qui diffèrent de la précédente. Tu navigues à la main dans l'app,
# le script s'occupe des captures.
#
#   ./capture-manual.sh [dossier-de-sortie] [intervalle-secondes]
#
# Dépendances : libimobiledevice (obligatoire), imagemagick (optionnel, pour la
# déduplication visuelle plutôt que par hash exact).

set -euo pipefail

OUT_DIR="${1:-./stripe-captures}"
INTERVAL="${2:-1.5}"
# Seuil de différence en % de pixels au-delà duquel l'écran est jugé nouveau.
THRESHOLD="${THRESHOLD:-0.5}"

if ! command -v idevicescreenshot >/dev/null 2>&1; then
  echo "idevicescreenshot introuvable. Installe-le avec :" >&2
  echo "  brew install libimobiledevice" >&2
  exit 1
fi

HAVE_MAGICK=0
if command -v compare >/dev/null 2>&1 && command -v identify >/dev/null 2>&1; then
  HAVE_MAGICK=1
else
  echo "note: imagemagick absent, déduplication par hash exact uniquement."
  echo "      (brew install imagemagick pour une comparaison visuelle)"
fi

mkdir -p "$OUT_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"; echo; echo "Terminé — $COUNT captures dans $OUT_DIR"' EXIT

CANDIDATE="$TMP_DIR/candidate.png"
PREVIOUS="$TMP_DIR/previous.png"
COUNT=0

# Pourcentage de pixels différents entre deux images. 100 si incomparable.
pixel_delta() {
  local a="$1" b="$2" diff total
  if [ "$(identify -format '%wx%h' "$a")" != "$(identify -format '%wx%h' "$b")" ]; then
    echo "100"
    return
  fi
  diff="$(compare -metric AE "$a" "$b" null: 2>&1 || true)"
  case "$diff" in
    ''|*[!0-9]*) echo "100"; return ;;
  esac
  total="$(identify -format '%[fx:w*h]' "$a")"
  awk -v d="$diff" -v t="$total" 'BEGIN { printf "%.4f", (t > 0 ? d * 100 / t : 100) }'
}

echo "Capture toutes les ${INTERVAL}s vers $OUT_DIR"
echo "Navigue dans l'app sur l'iPhone. Ctrl+C pour arrêter."
echo

while true; do
  if ! idevicescreenshot "$CANDIDATE" >/dev/null 2>&1; then
    printf '\riPhone injoignable — vérifie le câble et le déverrouillage… '
    sleep "$INTERVAL"
    continue
  fi

  is_new=1
  if [ -f "$PREVIOUS" ]; then
    if [ "$HAVE_MAGICK" -eq 1 ]; then
      delta="$(pixel_delta "$CANDIDATE" "$PREVIOUS")"
      awk -v x="$delta" -v t="$THRESHOLD" 'BEGIN { exit !(x < t) }' && is_new=0
    else
      [ "$(shasum -a 256 <"$CANDIDATE" | cut -d' ' -f1)" \
        = "$(shasum -a 256 <"$PREVIOUS" | cut -d' ' -f1)" ] && is_new=0
    fi
  fi

  if [ "$is_new" -eq 1 ]; then
    COUNT=$((COUNT + 1))
    cp "$CANDIDATE" "$(printf '%s/%04d-%s.png' "$OUT_DIR" "$COUNT" "$(date +%H%M%S)")"
    cp "$CANDIDATE" "$PREVIOUS"
  fi

  printf '\r%d captures — dernière il y a %s  ' "$COUNT" "$(date +%H:%M:%S)"
  sleep "$INTERVAL"
done
