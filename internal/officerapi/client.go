// Package officerapi is the HTTP client for seekers-tracker's
// /api/officer/* routes — same site the officer's browser uses, called
// here with an x-api-key header (from Settings) instead of a session
// cookie. See seekers-tracker's src/lib/api-key-auth.ts for the other side
// of this contract.
package officerapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

func New(serverURL, apiKey string) *Client {
	return &Client{
		baseURL: strings.TrimRight(serverURL, "/"),
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

// apiError is the {"error": "..."} shape every /api/officer/* route
// returns alongside a non-2xx status.
type apiError struct {
	Error string `json:"error"`
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reqBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reqBody = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return err
	}
	req.Header.Set("x-api-key", c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("couldn't reach %s — check the server URL in Settings: %w", c.baseURL, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if resp.StatusCode >= 300 {
		var apiErr apiError
		if err := json.Unmarshal(respBody, &apiErr); err == nil && apiErr.Error != "" {
			return fmt.Errorf("%s", apiErr.Error)
		}
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}

	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return err
		}
	}
	return nil
}

// --- GET /api/officer/characters ---

type Character struct {
	ID              int    `json:"id"`
	Name            string `json:"name"`
	CharType        string `json:"charType"`
	MainCharacterID *int   `json:"mainCharacterId"`
	Status          string `json:"status"`
}

func (c *Client) FetchCharacters(ctx context.Context) ([]Character, error) {
	var out struct {
		Characters []Character `json:"characters"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/officer/characters", nil, &out); err != nil {
		return nil, err
	}
	return out.Characters, nil
}

// --- GET /api/officer/items ---

func (c *Client) FetchItems(ctx context.Context) ([]string, error) {
	var out struct {
		Items []string `json:"items"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/officer/items", nil, &out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

// --- POST /api/officer/attendance ---

type AttendanceRequest struct {
	Activity       string   `json:"activity"`
	OccurredAt     string   `json:"occurredAt"`
	CharacterNames []string `json:"characterNames"`
	Note           string   `json:"note,omitempty"`
}

type AttendanceResponse struct {
	Inserted  int      `json:"inserted"`
	Unmatched []string `json:"unmatched"`
}

func (c *Client) SubmitAttendance(ctx context.Context, req AttendanceRequest) (AttendanceResponse, error) {
	var out AttendanceResponse
	err := c.do(ctx, http.MethodPost, "/api/officer/attendance", req, &out)
	return out, err
}

// --- POST /api/officer/bids ---

type BidEntry struct {
	CharacterName string `json:"characterName"`
	Tier          string `json:"tier"`
	OccurredAt    string `json:"occurredAt"`
}

type BidsRequest struct {
	ItemName string     `json:"itemName"`
	Entries  []BidEntry `json:"entries"`
	Note     string     `json:"note,omitempty"`
}

type BidsResponse struct {
	Inserted     int      `json:"inserted"`
	Unmatched    []string `json:"unmatched"`
	InvalidTiers []string `json:"invalidTiers"`
}

func (c *Client) SubmitBids(ctx context.Context, req BidsRequest) (BidsResponse, error) {
	var out BidsResponse
	err := c.do(ctx, http.MethodPost, "/api/officer/bids", req, &out)
	return out, err
}
