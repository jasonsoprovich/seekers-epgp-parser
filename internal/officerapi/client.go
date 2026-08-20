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
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ServerURL is the one seekers-tracker instance this app talks to — not
// user-configurable, since there's only ever one.
const ServerURL = "https://seekers.fetchinglogic.com"

type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

func New(apiKey string) *Client {
	return &Client{
		baseURL: strings.TrimRight(ServerURL, "/"),
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
		return fmt.Errorf("couldn't reach %s — check your internet connection: %w", c.baseURL, err)
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
	ID                int      `json:"id"`
	Name              string   `json:"name"`
	CharType          string   `json:"charType"`
	MainCharacterID   *int     `json:"mainCharacterId"`
	Status            string   `json:"status"`
	MainCharacterName *string  `json:"mainCharacterName"`
	PriorityRating    *float64 `json:"priorityRating"`
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

// --- POST /api/officer/characters ---

// CreateCharacterRequest resolves a name the site roster has never seen —
// either as a brand-new main (MainCharacterID nil) or as a new alt linked
// to an existing main — for the Attendance/Bids tabs' "no match" rows.
type CreateCharacterRequest struct {
	Name            string `json:"name"`
	MainCharacterID *int   `json:"mainCharacterId,omitempty"`
}

func (c *Client) CreateCharacter(ctx context.Context, req CreateCharacterRequest) (Character, error) {
	var out Character
	err := c.do(ctx, http.MethodPost, "/api/officer/characters", req, &out)
	return out, err
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
	IsWinner      bool   `json:"isWinner"`
}

type BidsRequest struct {
	ItemName string     `json:"itemName"`
	Entries  []BidEntry `json:"entries"`
	Note     string     `json:"note,omitempty"`
}

type BidsResponse struct {
	LootEventID  int      `json:"lootEventId"`
	Inserted     int      `json:"inserted"`
	Unmatched    []string `json:"unmatched"`
	InvalidTiers []string `json:"invalidTiers"`
}

func (c *Client) SubmitBids(ctx context.Context, req BidsRequest) (BidsResponse, error) {
	var out BidsResponse
	err := c.do(ctx, http.MethodPost, "/api/officer/bids", req, &out)
	return out, err
}

// --- POST /api/officer/manual-entry ---

// ManualEntryRequest mirrors seekers-tracker's InsertLedgerEntryInput
// exactly (src/lib/epgp/ledger-entry.ts) — ItemName is only meaningful
// (and only sent) for Kind "gp".
type ManualEntryRequest struct {
	Kind        string  `json:"kind"`
	CharacterID int     `json:"characterId"`
	Activity    string  `json:"activity,omitempty"`
	Tier        string  `json:"tier,omitempty"`
	ItemName    string  `json:"itemName,omitempty"`
	Points      float64 `json:"points"`
	OccurredAt  string  `json:"occurredAt"`
	Note        string  `json:"note"`
}

func (c *Client) SubmitManualEntry(ctx context.Context, req ManualEntryRequest) error {
	return c.do(ctx, http.MethodPost, "/api/officer/manual-entry", req, nil)
}

// --- GET /api/officer/point-values ---

type PointValue struct {
	Activity string  `json:"activity"`
	Points   float64 `json:"points"`
}

func (c *Client) FetchPointValues(ctx context.Context) (ep []PointValue, gp []PointValue, err error) {
	var out struct {
		EP []PointValue `json:"ep"`
		GP []PointValue `json:"gp"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/officer/point-values", nil, &out); err != nil {
		return nil, nil, err
	}
	return out.EP, out.GP, nil
}

// --- GET /api/officer/ledger ---

// LedgerRow covers both EP rows (Activity set, ItemName/Tier empty) and
// GP rows (ItemName/Tier set, Activity empty) — same union the site's own
// /epgp/ledger page renders, just as JSON instead of a table.
type LedgerRow struct {
	ID            int     `json:"id"`
	CharacterName string  `json:"characterName"`
	OccurredAt    string  `json:"occurredAt"`
	Activity      string  `json:"activity,omitempty"`
	ItemName      string  `json:"itemName,omitempty"`
	Tier          string  `json:"tier,omitempty"`
	Points        float64 `json:"points"`
	Note          *string `json:"note"`
	Source        string  `json:"source"`
	EnteredByName *string `json:"enteredByName"`
}

func (c *Client) FetchLedger(ctx context.Context, kind string, query string, page int) (rows []LedgerRow, hasNext bool, err error) {
	params := url.Values{"kind": {kind}, "page": {strconv.Itoa(page)}}
	if query != "" {
		params.Set("q", query)
	}
	var out struct {
		Rows    []LedgerRow `json:"rows"`
		HasNext bool        `json:"hasNext"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/officer/ledger?"+params.Encode(), nil, &out); err != nil {
		return nil, false, err
	}
	return out.Rows, out.HasNext, nil
}

// --- GET /api/officer/totals ---

type TotalsRow struct {
	ID                int      `json:"id"`
	Name              string   `json:"name"`
	CharType          string   `json:"charType"`
	Status            string   `json:"status"`
	MainCharacterName *string  `json:"mainCharacterName"`
	EP                *float64 `json:"ep"`
	GP                *float64 `json:"gp"`
	EPDecay           *float64 `json:"epDecay"`
	GPDecay           *float64 `json:"gpDecay"`
	PriorityRating    *float64 `json:"priorityRating"`
}

func (c *Client) FetchTotals(ctx context.Context, query string) ([]TotalsRow, error) {
	params := url.Values{}
	if query != "" {
		params.Set("q", query)
	}
	path := "/api/officer/totals"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}
	var out struct {
		Totals []TotalsRow `json:"totals"`
	}
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Totals, nil
}
