// Package admin implements the recovery CLI invoked via
// `docker exec <container> ./main admin <subcommand>`.
//
// Each subcommand opens its own DB connection, performs the operation, prints
// a confirmation, and exits. The HTTP server is intentionally not booted —
// these commands are designed to run while the main server is also running,
// without interfering with it.
package admin

import (
	"fmt"
	"os"
	"strings"

	"gorm.io/gorm"

	"github.com/codeci/codeci/server/config"
	dbpkg "github.com/codeci/codeci/server/db"
)

func usage() {
	fmt.Println("usage: ./main admin <subcommand>")
	fmt.Println("")
	fmt.Println("Subcommands:")
	fmt.Println("  list-users                              show all users")
	fmt.Println("  reset-totp <username>                   clear TOTP for a user (re-enroll on next login)")
	fmt.Println("  set-entra-enabled <true|false>          toggle Microsoft SSO globally")
	fmt.Println("  create-entra-user <email> [--admin]     bootstrap an Entra-only user")
}

// Run dispatches a subcommand. Returns the process exit code.
func Run(args []string, cfg *config.Config) int {
	if len(args) == 0 {
		usage()
		return 2
	}

	database, err := dbpkg.Init(cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "db init failed: %v\n", err)
		return 1
	}

	switch args[0] {
	case "list-users":
		return listUsers(database)
	case "reset-totp":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "reset-totp requires a username")
			return 2
		}
		return resetTOTP(database, args[1])
	case "set-entra-enabled":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "set-entra-enabled requires true|false")
			return 2
		}
		return setEntraEnabled(database, args[1])
	case "create-entra-user":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "create-entra-user requires an email")
			return 2
		}
		isAdmin := len(args) > 2 && args[2] == "--admin"
		return createEntraUser(database, args[1], isAdmin)
	default:
		usage()
		return 2
	}
}

func listUsers(db *gorm.DB) int {
	var users []dbpkg.User
	if err := db.Order("id asc").Find(&users).Error; err != nil {
		fmt.Fprintf(os.Stderr, "query failed: %v\n", err)
		return 1
	}
	fmt.Printf("%-4s  %-24s  %-32s  %-7s  %-8s  %s\n", "ID", "USERNAME", "EMAIL", "ROLE", "PROVIDER", "TOTP")
	for _, u := range users {
		totp := "off"
		if u.TOTPEnabled {
			totp = "on"
		}
		email := ""
		if u.Email != nil {
			email = *u.Email
		}
		fmt.Printf("%-4d  %-24s  %-32s  %-7s  %-8s  %s\n", u.ID, u.Username, email, u.Role, u.AuthProvider, totp)
	}
	return 0
}

func resetTOTP(db *gorm.DB, username string) int {
	var user dbpkg.User
	if err := db.Where("username = ?", username).First(&user).Error; err != nil {
		fmt.Fprintf(os.Stderr, "user %q not found\n", username)
		return 1
	}
	if err := db.Model(&user).Updates(map[string]any{
		"totp_enabled": false,
		"totp_secret":  "",
	}).Error; err != nil {
		fmt.Fprintf(os.Stderr, "update failed: %v\n", err)
		return 1
	}
	fmt.Printf("TOTP cleared for %q (id=%d). User can sign in with password and re-enroll.\n", user.Username, user.ID)
	return 0
}

func setEntraEnabled(db *gorm.DB, val string) int {
	truthy := strings.EqualFold(val, "true") || val == "1" || strings.EqualFold(val, "on") || strings.EqualFold(val, "yes")
	falsy := strings.EqualFold(val, "false") || val == "0" || strings.EqualFold(val, "off") || strings.EqualFold(val, "no")
	if !truthy && !falsy {
		fmt.Fprintf(os.Stderr, "expected true|false, got %q\n", val)
		return 2
	}
	if err := db.Model(&dbpkg.AppSettings{}).Where("id = ?", 1).Update("entra_enabled", truthy).Error; err != nil {
		fmt.Fprintf(os.Stderr, "update failed: %v\n", err)
		return 1
	}
	fmt.Printf("entra_enabled = %v\n", truthy)
	return 0
}

func createEntraUser(db *gorm.DB, email string, isAdmin bool) int {
	email = strings.ToLower(strings.TrimSpace(email))
	at := strings.Index(email, "@")
	if at <= 0 {
		fmt.Fprintf(os.Stderr, "invalid email %q\n", email)
		return 2
	}
	role := "user"
	if isAdmin {
		role = "admin"
	}
	// Use the local part as the username if no clash; otherwise fall back to full email.
	username := email[:at]
	var existing dbpkg.User
	if err := db.Where("username = ?", username).First(&existing).Error; err == nil {
		username = email
	}

	emailCopy := email
	user := dbpkg.User{
		Username:     username,
		Email:        &emailCopy,
		AuthProvider: "entra",
		Role:         role,
	}
	if err := db.Create(&user).Error; err != nil {
		fmt.Fprintf(os.Stderr, "create failed: %v (email or username may already exist)\n", err)
		return 1
	}
	fmt.Printf("Created Entra user: id=%d username=%q email=%q role=%q\n", user.ID, user.Username, emailCopy, user.Role)
	return 0
}
