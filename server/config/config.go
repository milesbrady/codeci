package config

import (
	"log"
	"os"
	"strconv"
)

type Config struct {
	Port                string
	DatabaseURL         string
	JWTSecret           string
	TOTPEncryptionKey   string
	PipelinesDir        string
	ScriptsDir          string
	AllowedOrigin       string
	GitPAT              string
	DisableTOTP         bool
	SessionTimeoutHours int
	ApplicationName     string
	EntraClientID       string
	EntraTenantID       string
	EntraClientSecret   string
	EntraRedirectURL    string
	TerminalStoragePath string
	TerminalEnabled     bool
}

func Load() *Config {
	cfg := &Config{
		Port:                getEnv("PORT", "8080"),
		DatabaseURL:         getEnv("DATABASE_URL", ""),
		JWTSecret:           getEnv("JWT_SECRET", ""),
		TOTPEncryptionKey:   getEnv("TOTP_ENCRYPTION_KEY", ""),
		PipelinesDir:        getEnv("PIPELINES_DIR", "../pipelines"),
		ScriptsDir:          getEnv("SCRIPTS_DIR", "../user-scripts"),
		AllowedOrigin:       getEnv("ALLOWED_ORIGIN", "http://localhost:5173"),
		GitPAT:              getEnv("GIT_PAT", ""),
		DisableTOTP:         os.Getenv("DISABLE_TOTP") == "true",
		SessionTimeoutHours: getEnvInt("SESSION_TIMEOUT_HOURS", 24),
		ApplicationName:     getEnv("APPLICATION_NAME", ""),
		EntraClientID:       getEnv("ENTRA_CLIENT_ID", ""),
		EntraTenantID:       getEnv("ENTRA_TENANT_ID", ""),
		EntraClientSecret:   getEnv("ENTRA_CLIENT_SECRET", ""),
		EntraRedirectURL:    getEnv("ENTRA_REDIRECT_URL", ""),
		TerminalStoragePath: getEnv("TERMINAL_STORAGE_PATH", "./storage"),
		TerminalEnabled:     getEnv("TERMINAL_ENABLED", "true") != "false",
	}

	if cfg.DatabaseURL == "" {
		log.Fatal("DATABASE_URL environment variable is required")
	}
	if cfg.JWTSecret == "" {
		log.Fatal("JWT_SECRET environment variable is required")
	}
	if !cfg.DisableTOTP && len(cfg.TOTPEncryptionKey) != 32 {
		log.Fatal("TOTP_ENCRYPTION_KEY must be exactly 32 characters (AES-256)")
	}
	if cfg.SessionTimeoutHours < 1 {
		log.Fatal("SESSION_TIMEOUT_HOURS must be >= 1")
	}

	return cfg
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
