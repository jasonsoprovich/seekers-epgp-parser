package parse

import (
	"reflect"
	"testing"
	"time"
)

func TestFindLootContext(t *testing.T) {
	raw := "[Sat Oct 31 20:10:00 2026] You have entered The Grey.\n" +
		"[Sat Oct 31 20:20:00 2026] Crusader Kezzal has been slain by Osui!\n" +
		"[Sat Oct 31 20:40:00 2026] You have entered The Lair of Terris Thule.\n" +
		"[Sat Oct 31 20:41:00 2026] You have entered an area where levitation effects do not function.\n" +
		"[Sat Oct 31 20:50:00 2026] a nightmare hound has been slain by Rizi!\n" +
		"[Sat Oct 31 20:59:30 2026] Terris Thule has been slain by Fanadenie!\n" +
		"[Sat Oct 31 20:59:40 2026] You have slain a nightmare hound!\n" +
		"[Sat Oct 31 21:00:05 2026] Darkcall tells the guild, 'Carved Bone Ring send tells'\n" +
		"[Sat Oct 31 21:30:00 2026] An Ancient Construct has been slain by Osui!\n"
	at := time.Date(2026, 10, 31, 21, 0, 5, 0, time.Local)

	got := FindLootContext(raw, at)
	if got.Zone != "The Lair of Terris Thule" {
		t.Errorf("Zone = %q", got.Zone)
	}
	// Most recent first, de-duplicated; nothing from the previous zone, and
	// nothing after the announcement (beyond the small slack).
	want := []string{"a nightmare hound", "Terris Thule"}
	if !reflect.DeepEqual(got.Killed, want) {
		t.Errorf("Killed = %#v, want %#v", got.Killed, want)
	}

	// Earlier in the night, standing in The Grey.
	got = FindLootContext(raw, time.Date(2026, 10, 31, 20, 25, 0, 0, time.Local))
	if got.Zone != "The Grey" || !reflect.DeepEqual(got.Killed, []string{"Crusader Kezzal"}) {
		t.Errorf("earlier context = %+v", got)
	}
}

func TestFindLootContext_EmptyLog(t *testing.T) {
	got := FindLootContext("", time.Now())
	if got.Zone != "" || got.Killed == nil || len(got.Killed) != 0 {
		t.Errorf("got %+v, want empty zone and non-nil empty kills", got)
	}
}
