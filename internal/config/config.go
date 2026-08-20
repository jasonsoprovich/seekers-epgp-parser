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
