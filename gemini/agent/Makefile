BIN     := nexus-agent
CMD     := ./cmd/agent
DIST    := ./dist
VERSION ?= v1.0.0
LDFLAGS := -ldflags "-s -w -X main.Version=$(VERSION)"

.PHONY: all build-linux build-darwin build-windows clean tidy

all: build-linux build-darwin build-windows

tidy:
	go mod tidy

build-linux:
	@mkdir -p $(DIST)
	GOOS=linux GOARCH=amd64  go build $(LDFLAGS) -o $(DIST)/$(BIN)-linux-amd64   $(CMD)
	GOOS=linux GOARCH=arm64  go build $(LDFLAGS) -o $(DIST)/$(BIN)-linux-arm64   $(CMD)

build-darwin:
	@mkdir -p $(DIST)
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o $(DIST)/$(BIN)-darwin-arm64  $(CMD)
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o $(DIST)/$(BIN)-darwin-amd64  $(CMD)

build-windows:
	@mkdir -p $(DIST)
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o $(DIST)/$(BIN)-windows-amd64.exe $(CMD)

clean:
	rm -rf $(DIST)
