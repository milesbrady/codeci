package db

import (
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func Init(dsn string) (*gorm.DB, error) {
	database, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return nil, err
	}

	if err := database.AutoMigrate(
		&User{}, &ExecutionRun{}, &AppSettings{}, &APIKey{}, &UserFavorite{}, &PipelineTrigger{},
		&Group{}, &UserGroup{}, &GroupPipelineAccess{}, &GroupScriptAccess{},
	); err != nil {
		return nil, err
	}

	// AutoMigrate does not loosen NOT NULL on existing columns. Drop it
	// idempotently so Entra-only users (no password) can be created.
	if err := database.Exec("ALTER TABLE users ALTER COLUMN pass_hash DROP NOT NULL").Error; err != nil {
		return nil, err
	}

	// Ensure at least one admin exists after migration (e.g. upgrading from pre-role schema)
	var adminCount int64
	database.Model(&User{}).Where("role = ?", "admin").Count(&adminCount)
	if adminCount == 0 {
		var firstUser User
		if err := database.Order("id asc").First(&firstUser).Error; err == nil {
			database.Model(&firstUser).Update("role", "admin")
		}
	}

	// Ensure default settings row exists
	var settingsCount int64
	database.Model(&AppSettings{}).Count(&settingsCount)
	if settingsCount == 0 {
		database.Create(&AppSettings{ID: 1, RunnerTimeoutMinutes: 60, PipelineHistoryLimit: 50, ApplicationName: "Codeci"})
	}

	// Pre-existing rows would have pipeline_history_limit = 0 after the
	// column was added — clamp them to the default so pruning doesn't
	// delete all completed runs.
	database.Exec("UPDATE app_settings SET pipeline_history_limit = 50 WHERE pipeline_history_limit IS NULL OR pipeline_history_limit <= 0")

	// Seed the "Everyone" system group on first migration and back-fill it
	// with every existing non-admin user. The operation set mirrors what
	// regular users could do before groups existed (read/run pipelines and
	// scripts, issue their own API keys) — admins bypass groups entirely,
	// so they don't need to be members for any access.
	seedEveryoneGroup(database)

	return database, nil
}

// seedEveryoneGroup is the first-deploy migration that preserves backwards
// compatibility: every pre-existing non-admin user keeps the same access they
// had before groups landed. Re-running is idempotent — the group is matched
// by IsSystem=true and name="Everyone", and users already in it are skipped.
func seedEveryoneGroup(database *gorm.DB) {
	const defaultOps = "pipelines:read,pipelines:run,scripts:read,scripts:run,apikeys:issue_self"

	var g Group
	err := database.Where("is_system = ? AND name = ?", true, "Everyone").First(&g).Error
	if err != nil {
		g = Group{
			Name:         "Everyone",
			Description:  "Default group. Members can read and run all pipelines and scripts.",
			IsSystem:     true,
			PipelineMode: "all",
			ScriptMode:   "all",
			Operations:   defaultOps,
		}
		if err := database.Create(&g).Error; err != nil {
			return
		}
	}

	// Auto-join every non-system, non-admin user that isn't already a
	// member. (Admins technically don't need it, but joining them too keeps
	// the UI's group counts honest and lets an admin demote themselves
	// later without surprise loss of access.)
	var users []User
	database.Where("auth_provider != ?", "system").Find(&users)
	for _, u := range users {
		var existing UserGroup
		err := database.Where("user_id = ? AND group_id = ?", u.ID, g.ID).First(&existing).Error
		if err == nil {
			continue
		}
		database.Create(&UserGroup{UserID: u.ID, GroupID: g.ID})
	}
}
