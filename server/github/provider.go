package github

import (
	"context"
	"errors"

	"gorm.io/gorm"

	"github.com/codeci/codeci/server/auth"
	dbpkg "github.com/codeci/codeci/server/db"
)

// Provider is the small surface the API handler depends on. An
// OAuthAppProvider is the only shipped impl; a GitHubAppProvider can be
// added later without touching handler code.
type Provider interface {
	Name() string                       // "oauth_app" | "github_app"
	Client(ctx context.Context) (*Client, string, error) // returns authed REST client + connected login
	Connected(ctx context.Context) (bool, string, error)
}

// OAuthAppProvider acts as the connected user via a single stored OAuth
// access token on AppSettings. The same token is used for repo listing,
// branch listing, and webhook registration.
type OAuthAppProvider struct {
	db     *gorm.DB
	encKey string
}

func NewOAuthAppProvider(db *gorm.DB, encKey string) *OAuthAppProvider {
	return &OAuthAppProvider{db: db, encKey: encKey}
}

func (p *OAuthAppProvider) Name() string { return "oauth_app" }

func (p *OAuthAppProvider) settings() (*dbpkg.AppSettings, error) {
	var s dbpkg.AppSettings
	if err := p.db.First(&s, 1).Error; err != nil {
		return nil, err
	}
	return &s, nil
}

// LoadToken returns the decrypted GitHub access token from AppSettings.
// Returns ("", nil) when not connected.
func (p *OAuthAppProvider) LoadToken() (string, error) {
	s, err := p.settings()
	if err != nil {
		return "", err
	}
	if s.GitHubAccessToken == "" {
		return "", nil
	}
	return auth.DecryptSecret(s.GitHubAccessToken, p.encKey)
}

// LoadWebhookSecret returns the decrypted shared webhook secret. This is
// what GitHub uses to HMAC-sign delivery payloads.
func (p *OAuthAppProvider) LoadWebhookSecret() (string, error) {
	s, err := p.settings()
	if err != nil {
		return "", err
	}
	if s.GitHubWebhookSecret == "" {
		return "", nil
	}
	return auth.DecryptSecret(s.GitHubWebhookSecret, p.encKey)
}

// LoadClientCreds returns the decrypted (client_id, client_secret) pair
// — used during the OAuth code-exchange step.
func (p *OAuthAppProvider) LoadClientCreds() (string, string, error) {
	s, err := p.settings()
	if err != nil {
		return "", "", err
	}
	if s.GitHubClientID == "" || s.GitHubClientSecret == "" {
		return "", "", errors.New("github oauth app is not configured")
	}
	plain, err := auth.DecryptSecret(s.GitHubClientSecret, p.encKey)
	if err != nil {
		return "", "", err
	}
	return s.GitHubClientID, plain, nil
}

// Connected reports whether a usable access token is stored.
func (p *OAuthAppProvider) Connected(ctx context.Context) (bool, string, error) {
	s, err := p.settings()
	if err != nil {
		return false, "", err
	}
	return s.GitHubAccessToken != "" && s.GitHubEnabled, s.GitHubConnectedLogin, nil
}

// Client returns an authenticated REST client for the connected user.
// Returns an error when no token is stored.
func (p *OAuthAppProvider) Client(ctx context.Context) (*Client, string, error) {
	tok, err := p.LoadToken()
	if err != nil {
		return nil, "", err
	}
	if tok == "" {
		return nil, "", errors.New("github is not connected")
	}
	s, _ := p.settings()
	return NewClient(tok), s.GitHubConnectedLogin, nil
}
