.PHONY: dev-server dev-web build-server build-web lint setup

dev-server:
	cd server && go run main.go

dev-web:
	cd web && npm run dev

build-server:
	cd server && go build -o ../dist/server main.go

build-web:
	cd web && npm run build

lint:
	cd server && go vet ./...
	cd web && npm run lint

setup:
	cd server && go mod tidy
	cd web && npm install
