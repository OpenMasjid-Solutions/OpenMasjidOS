.PHONY: dev build lint test image clean

# Run backend + frontend in development mode with hot reload
dev:
	@echo "Starting OpenMasjidOS in development mode..."
	@cd frontend && npm install --silent
	@cd backend && go mod download
	@(cd frontend && npm run dev &) && (cd backend && go run ./cmd/openmasjid)

# Build production: UI → embed into Go binary → Docker image
build: build-ui build-go

build-ui:
	@echo "Building frontend..."
	cd frontend && npm ci && npm run build

build-go: build-ui
	@echo "Building backend binary..."
	cd backend && CGO_ENABLED=0 go build -ldflags="-w -s" -o ../dist/openmasjid ./cmd/openmasjid

# Build and tag the Docker image
image:
	@echo "Building Docker image..."
	docker build -t openmasjid/core:dev .

# Run all linters
lint:
	@echo "Linting backend..."
	cd backend && golangci-lint run ./...
	@echo "Linting frontend..."
	cd frontend && npm run check && npm run lint

# Run all tests
test:
	@echo "Testing backend..."
	cd backend && go test ./...
	@echo "Testing frontend..."
	cd frontend && npm run test

# Remove build artifacts
clean:
	rm -rf dist/
	rm -rf frontend/build
	rm -rf frontend/.svelte-kit
