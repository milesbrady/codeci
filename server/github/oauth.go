// Package github implements codeci's GitHub integration: a thin REST
// client, an OAuth-App authorization-code flow, HMAC webhook signature
// verification, and a provider interface so a future GitHub-App backend
// can plug in alongside the OAuth-App one.
//
// All callers should go through the Provider interface (provider.go).
// The OAuthAppProvider stores one access token globally on AppSettings
// — the codeci installation acts as a single GitHub identity (the admin
// who connected it).
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// OAuthScopes is the scope set codeci requests during the OAuth flow.
// `repo`           — read & list repos (incl. private) the connected user can see
// `admin:repo_hook` — create / delete webhooks on those repos
var OAuthScopes = []string{"repo", "admin:repo_hook"}

// BuildAuthorizeURL builds the GitHub OAuth authorize URL.
// The caller stores `state` in a signed cookie and verifies the cookie
// in the callback to defend against CSRF.
func BuildAuthorizeURL(clientID, redirectURI, state string) string {
	q := url.Values{}
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", strings.Join(OAuthScopes, " "))
	q.Set("state", state)
	q.Set("allow_signup", "false")
	return "https://github.com/login/oauth/authorize?" + q.Encode()
}

// ExchangeCode trades the temporary `code` returned in the callback for
// an access token. GitHub returns a `token_type=bearer` along with the
// granted scopes; we only need the access token.
func ExchangeCode(ctx context.Context, clientID, clientSecret, code, redirectURI string) (string, error) {
	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://github.com/login/oauth/access_token",
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github token exchange: %d: %s", resp.StatusCode, string(body))
	}

	var out struct {
		AccessToken      string `json:"access_token"`
		Scope            string `json:"scope"`
		TokenType        string `json:"token_type"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("decode token response: %w", err)
	}
	if out.Error != "" {
		return "", fmt.Errorf("github oauth: %s: %s", out.Error, out.ErrorDescription)
	}
	if out.AccessToken == "" {
		return "", errors.New("github oauth: empty access token")
	}
	return out.AccessToken, nil
}

// LookupLogin calls GET /user with the access token and returns the
// connected account's login. Used right after ExchangeCode so codeci
// can display "Connected as @<login>" in Settings.
func LookupLogin(ctx context.Context, accessToken string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("github /user: %d: %s", resp.StatusCode, string(body))
	}
	var out struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.Login == "" {
		return "", errors.New("github /user: empty login")
	}
	return out.Login, nil
}
