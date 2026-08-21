// Package updatecheck compares the running build's version against
// seekers-epgp-parser's latest GitHub release, so an officer running a
// stale build gets a pointed-at notice instead of silently drifting from
// a site that's moved on.
package updatecheck

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const releasesURL = "https://api.github.com/repos/jasonsoprovich/seekers-epgp-parser/releases/latest"

type Info struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	URL       string `json:"url"`
}

// Check compares currentVersion (main.Version, embedded via -ldflags -X
// at build time) against the repo's latest published GitHub release tag.
// An unversioned "dev" build never reports an update available.
func Check(ctx context.Context, currentVersion string) (Info, error) {
	info := Info{Current: currentVersion}
	if currentVersion == "" || currentVersion == "dev" {
		return info, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesURL, nil)
	if err != nil {
		return info, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return info, fmt.Errorf("couldn't check for updates: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return info, fmt.Errorf("update check failed: server returned %d", resp.StatusCode)
	}

	var out struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return info, err
	}

	info.Latest = out.TagName
	info.URL = out.HTMLURL
	info.Available = out.TagName != "" && strings.TrimPrefix(out.TagName, "v") != strings.TrimPrefix(currentVersion, "v")
	return info, nil
}
