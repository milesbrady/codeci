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

	if err := database.AutoMigrate(&User{}, &ExecutionRun{}, &AppSettings{}, &APIKey{}, &UserFavorite{}, &PipelineTrigger{}); err != nil {
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

	return database, nil
}
