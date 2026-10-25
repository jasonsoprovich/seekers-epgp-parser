package main

import (
	"reflect"
	"testing"
)

func TestSharedBankConflicts(t *testing.T) {
	entries := []sharedBankEntry{
		// One login, Shared Bank flagged on two characters: both clash.
		{name: "Darkclaw", fingerprint: "aaa", flagged: true},
		{name: "Darkblood", fingerprint: "aaa", flagged: true},
		// Same login, but not flagged here: never part of a clash.
		{name: "Darkseller", fingerprint: "aaa", flagged: false},
		// Another login, flagged on only one character: fine.
		{name: "Aransur", fingerprint: "bbb", flagged: true},
		{name: "Petra", fingerprint: "bbb", flagged: false},
		// Empty Shared Banks all fingerprint to "" and must never clash.
		{name: "Osui", fingerprint: "", flagged: true},
		{name: "Nariana", fingerprint: "", flagged: true},
	}

	got := sharedBankConflicts(entries)
	want := map[string][]string{
		"Darkblood": {"Darkclaw"},
		"Darkclaw":  {"Darkblood"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sharedBankConflicts = %v, want %v", got, want)
	}
}

func TestSharedBankConflicts_ThreeOnOneLogin(t *testing.T) {
	got := sharedBankConflicts([]sharedBankEntry{
		{name: "C", fingerprint: "x", flagged: true},
		{name: "A", fingerprint: "x", flagged: true},
		{name: "B", fingerprint: "x", flagged: true},
	})
	if !reflect.DeepEqual(got["A"], []string{"B", "C"}) || !reflect.DeepEqual(got["C"], []string{"A", "B"}) {
		t.Fatalf("unexpected conflicts: %v", got)
	}
}
