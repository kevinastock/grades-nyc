# List available commands.
default:
    @just --list

# Install the locked JavaScript dependencies (requires Node.js and npm).
install:
    npm ci

# Force a fresh CSV download, validate it, and regenerate the JSON.
update:
    npm run update-data

# Rebuild JSON from the cached CSV, downloading it if missing.
data:
    npm run build-data

# Build the data and start the local development server.
dev:
    npm run dev

# Validate data, type-check, and build production assets in dist/.
build:
    npm run build

alias release := build

# Serve the production build locally.
preview:
    npm run preview

# Run tests using small synthetic records; no download is needed.
test:
    npm test

# Convert and validate a supplied CSV without changing the download cache.
convert csv:
    npm run convert-data -- {{quote(csv)}}
