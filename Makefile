.PHONY: build run clean test web web-install vet build-go

# Binary name
BINARY=motion-pay

# Build frontend and backend
build: web
	go build -o $(BINARY).exe ./cmd/notion-manager/

# Build backend only (skip frontend)
build-go:
	go build -o $(BINARY).exe ./cmd/notion-manager/

# Run the server
run: build
	./$(BINARY).exe

# Install frontend dependencies
web-install:
	cd web && npm install

# Build frontend and copy to embed directory
web:
	cd web && npm run build
	cmd /c "if exist internal\web\dist rmdir /s /q internal\web\dist"
	cmd /c "xcopy web\dist internal\web\dist\ /E /I /Y /Q"

# Clean build artifacts
clean:
	del /f $(BINARY).exe 2>nul || true
	-rmdir /s /q web\dist 2>nul
	-rmdir /s /q internal\web\dist 2>nul

# Run tests
test:
	go test ./...

# Check code
vet:
	go vet ./...
