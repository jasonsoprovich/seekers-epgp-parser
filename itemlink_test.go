package main

import "testing"

func TestApp_ItemLink_KnownItem(t *testing.T) {
	a := &App{}
	got := a.ItemLink("Denon's Drums of Declivity")
	want := "\x12028149 Denon's Drums of Declivity\x12"
	if got != want {
		t.Errorf("ItemLink(known item) = %q, want %q", got, want)
	}
}

func TestApp_ItemLink_TypoStillLinks(t *testing.T) {
	a := &App{}
	got := a.ItemLink("Denon's Drums of Declivety") // one-letter typo
	want := "\x12028149 Denon's Drums of Declivity\x12"
	if got != want {
		t.Errorf("ItemLink(typo) = %q, want %q", got, want)
	}
}

func TestApp_ItemLink_UnknownFallsBackToPlainName(t *testing.T) {
	a := &App{}
	const name = "Not A Real Quarm Item"
	if got := a.ItemLink(name); got != name {
		t.Errorf("ItemLink(unknown) = %q, want the plain name %q unchanged", got, name)
	}
}
