#!/bin/bash
# Free disk space on NOVAAPP01 by removing OLD NovaDesk images and build folders. Every release
# tags a new image (:<version>) plus a :rollback-<time> tag of the previous one, and leaves a
# build folder behind (upgrade-novadesk.sh never deletes either). Modelled on NovaConnect's
# scripts/prune-images.sh, which does the same after each of its releases.
#
# What it frees is mostly the layers only old tags still pin: on 2026-10-08 that was about
# 266 MB (the oldest tag, 0.0.54, and its rollback tag) plus ~120 MB of build folders; the other
# tags share all their layers, so removing them frees almost nothing. The disk itself is mostly
# base images and the OS, so this is housekeeping, not a fix for a full disk.
#
# Always kept: :stable, :base, every :base-pre-* rollback base, the image the running container
# uses, the KEEP_VERSIONS newest version tags (e.g. :0.0.72), the KEEP_ROLLBACKS newest
# :rollback-* tags, and the KEEP_BUILDS newest build folders, so the upgrade script's automatic
# rollback and a manual one to any recent version still work. Release folders, backups and
# STABLE-RELEASE.json are never touched (removed images are rebuildable from the release folders).
# Also removed: leftover fault-injection rig images (:fi-*). NovaConnect and Nuvrion images, volumes
# and containers are not touched.
#
#   bash scripts/prune-images.sh          preview (changes nothing)
#   bash scripts/prune-images.sh --yes    remove
# To run it without a checkout on the server:  ssh host bash -s -- [--yes] < scripts/prune-images.sh
set -euo pipefail
KEEP_VERSIONS=${KEEP_VERSIONS:-5}
KEEP_ROLLBACKS=${KEEP_ROLLBACKS:-5}
KEEP_BUILDS=${KEEP_BUILDS:-3}
REPO=localhost/novadesk
BUILDS=~/novadesk-upgrades/builds

running=$(podman inspect -f '{{.Image}}' novadesk-api 2>/dev/null || true)
tags=$(podman images --format '{{.Tag}}' --filter "reference=$REPO" | grep -v '<none>' | sort -u)
versions=$(echo "$tags" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V || true)
rollbacks=$(echo "$tags" | grep -E '^rollback-' | sort || true)
keep=$( { echo stable; echo base; echo "$tags" | grep -E '^base-pre-' || true;
          echo "$versions" | tail -n "$KEEP_VERSIONS"; echo "$rollbacks" | tail -n "$KEEP_ROLLBACKS"; } | sort -u)

remove=()
while read -r t; do
  [ -z "$t" ] && continue
  grep -qxF "$t" <<<"$keep" && continue
  id=$(podman image inspect -f '{{.Id}}' "$REPO:$t")
  [ -n "$running" ] && [ "$id" = "$running" ] && continue
  remove+=("$t")
done <<<"$tags"
old_builds=()
if [ -d "$BUILDS" ]; then
  while read -r b; do [ -n "$b" ] && old_builds+=("$b"); done < <(ls -1dt "$BUILDS"/v* 2>/dev/null | tail -n +$((KEEP_BUILDS + 1)))
fi

free() { df -h / | awk 'NR==2{print $4" free ("$5" used)"}'; }
echo "cleanup: ${#remove[@]} old NovaDesk image tag(s), ${#old_builds[@]} old build folder(s); disk $(free)"
if [ "${1:-}" != "--yes" ]; then
  [ ${#remove[@]} -gt 0 ] && echo "  would remove image tags: ${remove[*]}"
  [ ${#old_builds[@]} -gt 0 ] && echo "  would remove build folders: $(printf '%s ' "${old_builds[@]##*/}")"
  echo "  keeping: $(echo "$keep" | tr '\n' ' ')and the running image"
  echo "  preview only; run with --yes to remove"; exit 0
fi
for t in "${remove[@]}"; do podman rmi "$REPO:$t" >/dev/null 2>&1 || echo "  kept $t (still in use)"; done
for b in "${old_builds[@]}"; do rm -rf -- "$b"; done
podman image prune -f >/dev/null
echo "cleanup done; disk $(free)"
