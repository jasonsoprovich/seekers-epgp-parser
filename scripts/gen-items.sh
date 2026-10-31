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

# id, Name, drop level, zones, NPCs.
#
# Drop level is the highest level of any NPC whose loot table holds the item
# (1 for a loot-table row no NPC uses, which the old droppable flag also
# counted), or 0 if nothing drops it. 897 names collide on several ids, and
# the level is the last-resort tiebreak: an item that drops beats a
# merchant-only or quest-reward copy, and among copies that all drop, the one
# from the higher-level NPC wins (Terris Thule's "Carved Bone Ring" 10127,
# level 70, over Crusader Kezzal's 6441, level 50).
#
# Zones and NPCs are filled only for ids whose name collides (every other row
# leaves them empty, which keeps the file small): the long names of the zones
# the dropping NPCs spawn in, and the NPC names, each "|"-joined. They let the
# officer app pick the copy that actually dropped from the officer's recent
# kills and current zone (internal/items.Resolve) before falling back to the
# level.
sqlite3 -separator $'\t' "$DB" <<'SQL' | gzip -9 >"$OUT"
WITH drop_level AS (
  SELECT l.item_id AS id, max(max(coalesce(n.level, 1), 1)) AS lvl
  FROM lootdrop_entries l
  LEFT JOIN loottable_entries lt ON lt.lootdrop_id = l.lootdrop_id
  LEFT JOIN npc_types n ON n.loottable_id = lt.loottable_id
  GROUP BY l.item_id
),
norm AS (
  SELECT id, lower(replace(trim(Name), '`', '''')) AS nm FROM items
),
dup AS (
  SELECT id FROM norm WHERE nm IN (SELECT nm FROM norm GROUP BY nm HAVING count(*) > 1)
),
droppers AS (
  SELECT DISTINCT l.item_id AS id, n.id AS npc_id, n.name AS npc
  FROM dup d
  JOIN lootdrop_entries l ON l.item_id = d.id
  JOIN loottable_entries lt ON lt.lootdrop_id = l.lootdrop_id
  JOIN npc_types n ON n.loottable_id = lt.loottable_id
),
npcs AS (
  SELECT id, group_concat(npc, '|') AS names
  FROM (SELECT DISTINCT id, npc FROM droppers ORDER BY id, npc)
  GROUP BY id
),
zones AS (
  SELECT id, group_concat(zone, '|') AS names
  FROM (
    SELECT DISTINCT dr.id, z.long_name AS zone
    FROM droppers dr
    JOIN spawnentry se ON se.npcID = dr.npc_id
    JOIN spawn2 s2 ON s2.spawngroupID = se.spawngroupID
    JOIN zone z ON z.short_name = s2.zone
    ORDER BY dr.id, z.long_name
  )
  GROUP BY id
)
SELECT i.id, i.Name, coalesce(dl.lvl, 0), coalesce(z.names, ''), coalesce(n.names, '')
FROM items i
LEFT JOIN drop_level dl ON dl.id = i.id
LEFT JOIN zones z ON z.id = i.id
LEFT JOIN npcs n ON n.id = i.id
ORDER BY i.id;
SQL

echo "Wrote $OUT ($(wc -c <"$OUT") bytes gzipped)"
