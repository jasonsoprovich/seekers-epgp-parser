package main

import "testing"

func TestApp_ItemLink_KnownItem(t *testing.T) {
	a := &App{}
	got := a.ItemLink("Denon's Drums of Declivity", 0)
	want := "\x12028149 Denon's Drums of Declivity\x12"
	if got != want {
		t.Errorf("ItemLink(known item) = %q, want %q", got, want)
	}
}

func TestApp_ItemLink_TypoStillLinks(t *testing.T) {
	a := &App{}
	got := a.ItemLink("Denon's Drums of Declivety", 0) // one-letter typo
	want := "\x12028149 Denon's Drums of Declivity\x12"
	if got != want {
		t.Errorf("ItemLink(typo) = %q, want %q", got, want)
	}
}

func TestApp_ItemLink_UnknownFallsBackToPlainName(t *testing.T) {
	a := &App{}
	const name = "Not A Real Quarm Item"
	if got := a.ItemLink(name, 0); got != name {
		t.Errorf("ItemLink(unknown) = %q, want the plain name %q unchanged", got, name)
	}
}

func TestApp_ItemLink_UsesChosenCopy(t *testing.T) {
	a := &App{}
	// Without an id the name lookup's default is Terris Thule's ring.
	if got, want := a.ItemLink("Carved Bone Ring", 0), "\x12010127 Carved Bone Ring\x12"; got != want {
		t.Errorf("ItemLink(default) = %q, want %q", got, want)
	}
	if got, want := a.ItemLink("Carved Bone Ring", 6441), "\x12006441 Carved Bone Ring\x12"; got != want {
		t.Errorf("ItemLink(6441) = %q, want %q", got, want)
	}
}
