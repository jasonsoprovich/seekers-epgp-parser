// Package config persists the officer's API key (Settings screen) to a
// small JSON file in the OS user-config dir, so the app doesn't ask for
// it again on every launch. There's exactly one officer per install of
// this desktop app, so this is deliberately global, unencrypted,
// plain-file state — not a per-raid-night thing worth a database, and not
// sensitive enough (a scoped, revocable API key, not a site password) to
// justify OS keychain integration. The server this app talks to is fixed
// (see officerapi.ServerURL) — there's only ever one seekers-tracker
// instance, so it's not a Settings field.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Settings struct {
	APIKey string `json:"apiKey"`
	// LogPath is the log file currently being watched. When GameDir is set
	// and ManualLogPath is false, the app keeps this pointed at whichever
	// character's eqlog is being written to right now (see internal/eqlogs);
	// otherwise it's whatever file the officer picked by hand.
	LogPath string `json:"logPath"`
	// GameDir is the EverQuest install folder (or its Logs subfolder). When
	// set, the app auto-detects the active character's log under it and
	// follows character swaps mid-raid, instead of pinning one file.
	GameDir string `json:"gameDir,omitempty"`
	// ManualLogPath is true when the officer picked a specific log file via
	// "Select Log File" rather than a game folder — the active-character
	// watcher then leaves LogPath alone so it doesn't override their choice.
	// Re-picking a game folder clears this.
	ManualLogPath bool `json:"manualLogPath,omitempty"`
	// Whether the Bids tab watches the log and auto-starts a round when the
	// officer announces "<item> send tells". A pointer so "absent from the
	// file" (nil) reads as ON — the default — while an explicit false from
	// the Settings toggle stays off. Read it through AutoDetectBidsEnabled.
	AutoDetectBids *bool `json:"autoDetectBids,omitempty"`
	// SetupComplete is set once the officer has been through (or dismissed)
	// the first-run setup wizard. The wizard shows on launch while this is
	// false; Settings has a "Run setup again" button that reopens it
	// regardless.
	SetupComplete bool `json:"setupComplete,omitempty"`
}

// AutoDetectBidsEnabled defaults to true when the setting has never been
// written (nil) — see the field comment.
func (s Settings) AutoDetectBidsEnabled() bool {
	return s.AutoDetectBids == nil || *s.AutoDetectBids
}

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "seekers-epgp-parser", "config.json"), nil
}

// Load returns zero-value Settings, not an error, if no config file has
// been saved yet — the Settings screen's natural first-run state.
func Load() (Settings, error) {
	path, err := configPath()
	if err != nil {
		return Settings{}, err
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Settings{}, nil
	}
	if err != nil {
		return Settings{}, err
	}
	var s Settings
	if err := json.Unmarshal(data, &s); err != nil {
		return Settings{}, err
	}
	return s, nil
}

func Save(s Settings) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}
