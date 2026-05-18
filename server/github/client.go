package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const apiBase = "https://api.github.com"

// Repo is the trimmed-down repo shape codeci needs (the UI picker).
type Repo struct {
	FullName      string `json:"full_name"`
	Name          string `json:"name"`
	Owner         string `json:"owner"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	HTMLURL       string `json:"html_url"`
}

// Hook represents a configured webhook on a repo. Only the id is needed
// for delete/update; the rest is informational.
type Hook struct {
	ID     int64    `json:"id"`
	Events []string `json:"events"`
	Active bool     `json:"active"`
	Config struct {
		URL         string `json:"url"`
		ContentType string `json:"content_type"`
	} `json:"config"`
}

// Client is a thin REST wrapper that authenticates with a personal /
// OAuth bearer token. One Client is created per request.
type Client struct {
	token string
	http  *http.Client
}

func NewClient(token string) *Client {
	return &Client{
		token: token,
		http:  &http.Client{Timeout: 20 * time.Second},
	}
}

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, apiBase+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.http.Do(req)
}

// ListRepos returns the connected user's repos (incl. private, sorted by
// pushed_at desc so the most-recently-active appear first).
func (c *Client) ListRepos(ctx context.Context, page int) ([]Repo, error) {
	q := url.Values{}
	q.Set("per_page", "100")
	q.Set("sort", "pushed")
	q.Set("direction", "desc")
	if page > 0 {
		q.Set("page", strconv.Itoa(page))
	}
	resp, err := c.do(ctx, http.MethodGet, "/user/repos?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, decodeError(resp)
	}

	var raw []struct {
		FullName      string `json:"full_name"`
		Name          string `json:"name"`
		Private       bool   `json:"private"`
		DefaultBranch string `json:"default_branch"`
		HTMLURL       string `json:"html_url"`
		Owner         struct {
			Login string `json:"login"`
		} `json:"owner"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	out := make([]Repo, len(raw))
	for i, r := range raw {
		out[i] = Repo{
			FullName:      r.FullName,
			Name:          r.Name,
			Owner:         r.Owner.Login,
			Private:       r.Private,
			DefaultBranch: r.DefaultBranch,
			HTMLURL:       r.HTMLURL,
		}
	}
	return out, nil
}

// ListBranches returns branch names for a repo.
func (c *Client) ListBranches(ctx context.Context, owner, repo string) ([]string, error) {
	resp, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/repos/%s/%s/branches?per_page=100", owner, repo), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, decodeError(resp)
	}
	var raw []struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	out := make([]string, len(raw))
	for i, b := range raw {
		out[i] = b.Name
	}
	return out, nil
}

// CreateHookOpts is the input to CreateHook.
type CreateHookOpts struct {
	URL    string   // public codeci endpoint that will receive deliveries
	Secret string   // HMAC secret GitHub will use to sign payloads
	Events []string // e.g. ["push","pull_request","release"]
	Active bool
}

// CreateHook registers a new webhook on owner/repo and returns its id.
// GitHub deduplicates by URL within a repo; if a hook with this URL
// already exists, GitHub returns 422 — caller may fall back to listing
// + updating.
func (c *Client) CreateHook(ctx context.Context, owner, repo string, opts CreateHookOpts) (int64, error) {
	body := map[string]any{
		"name":   "web",
		"active": opts.Active,
		"events": opts.Events,
		"config": map[string]any{
			"url":          opts.URL,
			"content_type": "json",
			"secret":       opts.Secret,
			"insecure_ssl": "0",
		},
	}
	resp, err := c.do(ctx, http.MethodPost, fmt.Sprintf("/repos/%s/%s/hooks", owner, repo), body)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return 0, decodeError(resp)
	}
	var out Hook
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	return out.ID, nil
}

// UpdateHook PATCHes events/active/secret on an existing hook.
func (c *Client) UpdateHook(ctx context.Context, owner, repo string, hookID int64, opts CreateHookOpts) error {
	body := map[string]any{
		"active": opts.Active,
		"events": opts.Events,
		"config": map[string]any{
			"url":          opts.URL,
			"content_type": "json",
			"secret":       opts.Secret,
			"insecure_ssl": "0",
		},
	}
	resp, err := c.do(ctx, http.MethodPatch, fmt.Sprintf("/repos/%s/%s/hooks/%d", owner, repo, hookID), body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return decodeError(resp)
	}
	return nil
}

// DeleteHook removes a hook by id. 404 is treated as success — the hook
// is already gone, which is what we wanted.
func (c *Client) DeleteHook(ctx context.Context, owner, repo string, hookID int64) error {
	resp, err := c.do(ctx, http.MethodDelete, fmt.Sprintf("/repos/%s/%s/hooks/%d", owner, repo, hookID), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	return decodeError(resp)
}

func decodeError(resp *http.Response) error {
	body, _ := io.ReadAll(resp.Body)
	if len(body) == 0 {
		return fmt.Errorf("github api: %d", resp.StatusCode)
	}
	var out struct {
		Message string `json:"message"`
		Errors  []any  `json:"errors"`
	}
	if err := json.Unmarshal(body, &out); err == nil && out.Message != "" {
		return errors.New("github api: " + out.Message)
	}
	return fmt.Errorf("github api: %d: %s", resp.StatusCode, string(body))
}
