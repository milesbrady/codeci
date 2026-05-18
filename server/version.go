package main

// Version is the application version, displayed in the UI and exposed via the
// public /api/config/app endpoint. Override at build time with:
//   go build -ldflags "-X main.Version=1.2.3"
var Version = "0.3.26-rc.1"
