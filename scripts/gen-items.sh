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

# id, Name, droppable (1 if it appears in any lootdrop_entries row, else 0).
# droppable breaks ties among duplicate-named items (897 names collide) in
# favor of an item that can actually drop, over e.g. a merchant-only or
# quest-reward duplicate with the same display name.
sqlite3 -separator $'\t' "$DB" "
SELECT i.id, i.Name,
       CASE WHEN EXISTS (SELECT 1 FROM lootdrop_entries l WHERE l.item_id = i.id) THEN 1 ELSE 0 END
FROM items i
ORDER BY i.id;
" | gzip -9 >"$OUT"

echo "Wrote $OUT ($(wc -c <"$OUT") bytes gzipped)"
