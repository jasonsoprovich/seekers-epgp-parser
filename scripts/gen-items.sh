#!/usr/bin/env bash
# Regenerates internal/items/items.tsv.gz from a Quarm items database.
#
# Every row in quarm.db's `items` table is included — there is no
# expansion filter, so Planes of Power items (which pq-companion's own
# query-time filter hides, see its backend/internal/db/pop_index.go) are
# in the list. That app's exclusion is deliberate for its own UI; this
# app's announcement-detection needs every real item name, so we read the
# raw table instead of going through pq-companion's filtered queries.
#
# Usage:
#   scripts/gen-items.sh [path/to/quarm.db]
#
# Defaults to the sibling pq-companion repo's copy if no path is given.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${1:-$REPO_ROOT/../../pq-companion/backend/data/quarm.db}"
OUT="$REPO_ROOT/internal/items/items.tsv.gz"

if [ ! -f "$DB" ]; then
	echo "quarm.db not found at $DB" >&2
	echo "usage: $0 [path/to/quarm.db]" >&2
	exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
	echo "sqlite3 CLI is required" >&2
	exit 1
fi

echo "Reading items from $DB ..."
count=$(sqlite3 "$DB" "SELECT count(*) FROM items;")
echo "$count rows"

# id, Name, drop level: the highest level of any NPC whose loot table holds
# the item (1 for a loot-table row no NPC uses, which the old droppable flag
# also counted), or 0 if nothing drops it. 897 names collide on several ids, and
# the level breaks those ties: an item that drops beats a merchant-only or
# quest-reward copy, and among copies that all drop, the one from the
# higher-level NPC wins. That is the raid-boss version a guild bids on, e.g.
# "Carved Bone Ring" from Terris Thule (10127, level 70) over Crusader
# Kezzal's (6441, level 50).
sqlite3 -separator $'\t' "$DB" "
WITH drop_level AS (
  SELECT l.item_id AS id, max(max(coalesce(n.level, 1), 1)) AS lvl
  FROM lootdrop_entries l
  LEFT JOIN loottable_entries lt ON lt.lootdrop_id = l.lootdrop_id
  LEFT JOIN npc_types n ON n.loottable_id = lt.loottable_id
  GROUP BY l.item_id
)
SELECT i.id, i.Name, coalesce(d.lvl, 0)
FROM items i LEFT JOIN drop_level d ON d.id = i.id
ORDER BY i.id;
" | gzip -9 >"$OUT"

echo "Wrote $OUT ($(wc -c <"$OUT") bytes gzipped)"
