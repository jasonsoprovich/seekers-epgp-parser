// Package updatecheck compares the running build's version against
// seekers-epgp-parser's latest GitHub release, so an officer running a
// stale build gets a pointed-at notice instead of silently drifting from
// a site that's moved on. Apply goes further: it downloads that release's
// Windows exe, verifies it against a published SHA-256 checksum, and
// swaps it into place over the running binary (PLAN.md §7, §11 Phase 7).
package updatecheck

import (
	"context"
	_ "crypto/sha256" // registers SHA256 for selfupdate's default checksum verification
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/minio/selfupdate"
)

const releasesURL = "https://api.github.com/repos/jasonsoprovich/seekers-epgp-parser/releases/latest"

// exeAssetName is wails.json's outputfilename plus the .exe extension
// wails build -platform windows/amd64 produces — build-windows.yml
// uploads build/bin/*.exe as-is, so this is the literal release asset
// name. checksumAssetName is the sha256sum sidecar that workflow computes
// alongside it.
const (
	exeAssetName      = "seekers-epgp-parser.exe"
	checksumAssetName = exeAssetName + ".sha256"
)

type Info struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	URL       string `json:"url"`
}

type asset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

type release struct {
	TagName string  `json:"tag_name"`
	HTMLURL string  `json:"html_url"`
	Assets  []asset `json:"assets"`
}

func fetchLatestRelease(ctx context.Context) (release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesURL, nil)
	if err != nil {
		return release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return release{}, fmt.Errorf("couldn't check for updates: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return release{}, fmt.Errorf("update check failed: server returned %d", resp.StatusCode)
	}

	var rel release
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return release{}, err
	}
	return rel, nil
}

// Check compares currentVersion (main.Version, embedded via -ldflags -X
// at build time) against the repo's latest published GitHub release tag.
// An unversioned "dev" build never reports an update available.
func Check(ctx context.Context, currentVersion string) (Info, error) {
	info := Info{Current: currentVersion}
	if currentVersion == "" || currentVersion == "dev" {
		return info, nil
	}

	rel, err := fetchLatestRelease(ctx)
	if err != nil {
		return info, err
	}

	info.Latest = rel.TagName
	info.URL = rel.HTMLURL
	info.Available = rel.TagName != "" && strings.TrimPrefix(rel.TagName, "v") != strings.TrimPrefix(currentVersion, "v")
	return info, nil
}

func findAsset(assets []asset, name string) (asset, bool) {
	for _, a := range assets {
		if a.Name == name {
			return a, true
		}
	}
	return asset{}, false
}

// downloadChecksum fetches the .sha256 sidecar and pulls the hex digest
// out of it — tolerant of both a bare hex string and the "hex  filename"
// shape `sha256sum` writes, since that's what build-windows.yml runs.
func downloadChecksum(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("couldn't download checksum: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("checksum download failed: server returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	fields := strings.Fields(string(body))
	if len(fields) == 0 {
		return nil, fmt.Errorf("empty checksum file")
	}
	checksum, err := hex.DecodeString(fields[0])
	if err != nil {
		return nil, fmt.Errorf("malformed checksum: %w", err)
	}
	return checksum, nil
}

// Apply downloads the latest release's Windows exe, verifies it against
// the matching .sha256 release asset, and swaps it into place over the
// running executable. selfupdate.Apply does the actual rename-and-swap:
// it renames the current exe aside (hidden on Windows, since a running
// exe can't be deleted there) and moves the verified download into its
// place — the process keeps running off its now-detached old file handle
// until the caller relaunches. Never recomputes or trusts an unverified
// checksum: a failed or missing checksum asset aborts before download.
func Apply(ctx context.Context) (Info, error) {
	rel, err := fetchLatestRelease(ctx)
	if err != nil {
		return Info{}, err
	}

	exeAsset, ok := findAsset(rel.Assets, exeAssetName)
	if !ok {
		return Info{}, fmt.Errorf("release %s has no %s asset", rel.TagName, exeAssetName)
	}
	checksumAsset, ok := findAsset(rel.Assets, checksumAssetName)
	if !ok {
		return Info{}, fmt.Errorf("release %s has no %s asset", rel.TagName, checksumAssetName)
	}

	var opts selfupdate.Options
	if err := opts.CheckPermissions(); err != nil {
		return Info{}, fmt.Errorf("can't update in place: %w", err)
	}

	checksum, err := downloadChecksum(ctx, checksumAsset.URL)
	if err != nil {
		return Info{}, err
	}
	opts.Checksum = checksum

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, exeAsset.URL, nil)
	if err != nil {
		return Info{}, err
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return Info{}, fmt.Errorf("couldn't download update: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return Info{}, fmt.Errorf("update download failed: server returned %d", resp.StatusCode)
	}

	if err := selfupdate.Apply(resp.Body, opts); err != nil {
		if rerr := selfupdate.RollbackError(err); rerr != nil {
			return Info{}, fmt.Errorf("update failed and the rollback also failed — reinstall manually from %s: %w", rel.HTMLURL, rerr)
		}
		return Info{}, fmt.Errorf("update failed, rolled back to the previous version: %w", err)
	}

	return Info{Current: rel.TagName, Latest: rel.TagName, URL: rel.HTMLURL}, nil
}
