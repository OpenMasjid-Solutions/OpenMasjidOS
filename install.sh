#!/usr/bin/env bash
# =============================================================================
# OpenMasjidOS Installer
# =============================================================================
#
# This script installs OpenMasjidOS on your server — a free, open-source
# platform that lets any masjid run useful software on their own hardware.
#
# What this script does:
#   1. Checks that you are running as root (or with sudo)
#   2. Detects your operating system and CPU architecture
#   3. Installs Docker if it is not already present
#   4. Creates the data directory at /opt/openmasjid
#   5. Writes the core docker-compose.yml
#   6. Pulls the OpenMasjidOS image and starts the service
#   7. Waits for the service to become healthy
#   8. Prints the URL where you can open the dashboard
#
# This script is safe to re-run — it will upgrade an existing install
# without breaking it or losing your data.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/hasan-ismail/OpenMasjidOS/master/install.sh | bash
#
# If you prefer to inspect before running (recommended!):
#   curl -fsSL https://raw.githubusercontent.com/hasan-ismail/OpenMasjidOS/master/install.sh -o install.sh
#   less install.sh      # read it first
#   bash install.sh      # then run it
#
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Constants — change these if you need a non-standard setup
# -----------------------------------------------------------------------------
PORT=80
DATA_DIR=/opt/openmasjid
IMAGE=ghcr.io/hasan-ismail/openmasjid-core:latest
COMPOSE_PROJECT=openmasjid

# Colour codes — we check for terminal support before using them
if [ -t 1 ]; then
  # $'...' syntax makes bash interpret \033 as the real ESC character at
  # assignment time, so both echo and printf output correct ANSI sequences.
  CLR_GREEN=$'\033[0;32m'
  CLR_YELLOW=$'\033[1;33m'
  CLR_RED=$'\033[0;31m'
  CLR_CYAN=$'\033[0;36m'
  CLR_BOLD=$'\033[1m'
  CLR_RESET=$'\033[0m'
else
  CLR_GREEN=""
  CLR_YELLOW=""
  CLR_RED=""
  CLR_CYAN=""
  CLR_BOLD=""
  CLR_RESET=""
fi

# Will be set by detect_os()
OS_ID=""
ARCH=""

# =============================================================================
# Utility functions
# =============================================================================

# print_banner — show a welcoming header so users know what is running
print_banner() {
  echo ""
  printf "${CLR_CYAN}${CLR_BOLD}"
  printf '  ╔═══════════════════════════════════════════════════════╗\n'
  printf '  ║                                                       ║\n'
  printf '  ║            *          *          *                    ║\n'
  printf '  ║           /|\        /|\        /|\                   ║\n'
  printf '  ║          ( | )      ( | )      ( | )                  ║\n'
  printf '  ║          _|_|_   .----------.  _|_|_                  ║\n'
  printf '  ║         |     | /            \ |     |                ║\n'
  printf '  ║         |     |/   .------.   \|     |                ║\n'
  printf '  ║         |     /   /        \   \     |                ║\n'
  printf '  ║         |    |   |   arch   |   |    |                ║\n'
  printf '  ║         |    |   |          |   |    |                ║\n'
  printf '  ║         |____|___|__________|___|____|                ║\n'
  printf '  ║                                                       ║\n'
  printf '  ║              O p e n M a s j i d O S                 ║\n'
  printf '  ║         Free, open-source platform for masjids        ║\n'
  printf '  ║                                                       ║\n'
  printf '  ╚═══════════════════════════════════════════════════════╝\n'
  printf "${CLR_RESET}\n"
  echo ""
}

# info — print a green informational message
info() {
  echo -e "${CLR_GREEN}[✓]${CLR_RESET} $*"
}

# warn — print a yellow warning (non-fatal)
warn() {
  echo -e "${CLR_YELLOW}[!]${CLR_RESET} $*"
}

# error — print a red error message and exit
error() {
  echo -e "${CLR_RED}[✗] Error:${CLR_RESET} $*" >&2
  exit 1
}

# =============================================================================
# Step 1: Check we have the privileges we need
# =============================================================================

check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo ""
    echo -e "${CLR_RED}This installer needs to run as root.${CLR_RESET}"
    echo ""
    echo "  Please re-run with sudo:"
    echo ""
    echo "    sudo bash install.sh"
    echo ""
    echo "  Or if you piped from curl:"
    echo ""
    echo "    curl -fsSL https://raw.githubusercontent.com/hasan-ismail/OpenMasjidOS/master/install.sh | sudo bash"
    echo ""
    exit 1
  fi
  info "Running as root — good."
}

# =============================================================================
# Step 2: Detect operating system and CPU architecture
# =============================================================================

detect_os() {
  info "Detecting your system..."

  # --- Architecture ---
  local raw_arch
  raw_arch="$(uname -m)"

  case "$raw_arch" in
    x86_64)
      ARCH="amd64"
      ;;
    aarch64 | arm64)
      ARCH="arm64"
      ;;
    armv7l | armhf)
      # 32-bit ARM — common on older Raspberry Pi models
      ARCH="armv7"
      ;;
    *)
      echo ""
      echo -e "${CLR_RED}Sorry, your CPU architecture ($raw_arch) is not supported yet.${CLR_RESET}"
      echo ""
      echo "  OpenMasjidOS currently supports:"
      echo "    • amd64  (standard desktop/server PCs)"
      echo "    • arm64  (Raspberry Pi 4/5, Apple Silicon servers)"
      echo ""
      echo "  If you would like support for your architecture, please open an issue at:"
      echo "  https://github.com/hasan-ismail/OpenMasjidOS/issues"
      echo ""
      exit 1
      ;;
  esac

  # --- Operating System ---
  # We read /etc/os-release which is the standard on all modern Linux distros
  if [ ! -f /etc/os-release ]; then
    error "Could not find /etc/os-release. Is this a supported Linux distribution?"
  fi

  # Source it in a subshell-safe way to get ID and ID_LIKE
  local os_id_raw=""
  local os_id_like=""
  os_id_raw="$(. /etc/os-release && echo "${ID:-}")"
  os_id_like="$(. /etc/os-release && echo "${ID_LIKE:-}")"

  case "$os_id_raw" in
    ubuntu)
      OS_ID="ubuntu"
      ;;
    debian)
      OS_ID="debian"
      ;;
    raspbian)
      # Raspberry Pi OS (formerly Raspbian) identifies as raspbian
      OS_ID="raspbian"
      ;;
    fedora)
      OS_ID="fedora"
      ;;
    rhel | centos | rocky | almalinux)
      # RHEL-family — treat like fedora (dnf-based)
      OS_ID="fedora"
      ;;
    *)
      # Fall back to ID_LIKE — e.g. Linux Mint says ID_LIKE="ubuntu"
      case "$os_id_like" in
        *ubuntu* | *debian*)
          OS_ID="debian"
          ;;
        *fedora* | *rhel*)
          OS_ID="fedora"
          ;;
        *)
          echo ""
          echo -e "${CLR_RED}Sorry, your Linux distribution ($os_id_raw) is not supported yet.${CLR_RESET}"
          echo ""
          echo "  OpenMasjidOS currently supports:"
          echo "    • Ubuntu 20.04 / 22.04 / 24.04"
          echo "    • Debian 11 / 12"
          echo "    • Raspberry Pi OS (Bookworm / Bullseye)"
          echo "    • Fedora 38+"
          echo ""
          echo "  If you would like support for your distribution, please open an issue at:"
          echo "  https://github.com/hasan-ismail/OpenMasjidOS/issues"
          echo ""
          exit 1
          ;;
      esac
      ;;
  esac

  info "Detected OS: ${os_id_raw} (${ARCH})"
}

# =============================================================================
# Step 3: Install Docker if needed
# =============================================================================

install_docker() {
  info "Checking for Docker..."

  # Check if the docker CLI exists and the daemon is reachable
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    info "Docker is already installed — skipping installation."
  else
    warn "Docker not found. Installing Docker now (this may take a minute)..."
    echo ""

    case "$OS_ID" in
      ubuntu | debian | raspbian)
        # Use Docker's official convenience script — it is the recommended path
        # for non-interactive installs and handles all the APT repository setup.
        # Users can inspect it at https://get.docker.com
        if command -v curl &>/dev/null; then
          curl -fsSL https://get.docker.com | sh
        elif command -v wget &>/dev/null; then
          wget -qO- https://get.docker.com | sh
        else
          error "Neither curl nor wget is available. Please install one and re-run."
        fi
        ;;
      fedora)
        # On Fedora/RHEL-family we use dnf and the official Docker CE repository
        dnf -y install dnf-plugins-core
        dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
        dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
        ;;
    esac

    info "Docker installed successfully."
  fi

  # --- Ensure the docker compose plugin is present ---
  # 'docker compose' (v2 plugin) is different from the older 'docker-compose' binary.
  # We require the v2 plugin.
  if ! docker compose version &>/dev/null 2>&1; then
    warn "The 'docker compose' plugin is not available. Installing it..."

    case "$OS_ID" in
      ubuntu | debian | raspbian)
        apt-get install -y docker-compose-plugin
        ;;
      fedora)
        dnf -y install docker-compose-plugin
        ;;
    esac
  fi

  info "Docker Compose plugin is available."

  # --- Start and enable the Docker service ---
  if command -v systemctl &>/dev/null; then
    systemctl enable docker --now
    info "Docker service is enabled and running."
  fi

  # --- Add the invoking user to the docker group so they can use Docker
  #     without sudo in future sessions (won't affect root) ---
  local invoking_user="${SUDO_USER:-}"
  if [ -n "$invoking_user" ] && [ "$invoking_user" != "root" ]; then
    if ! groups "$invoking_user" | grep -q '\bdocker\b'; then
      usermod -aG docker "$invoking_user"
      warn "Added '$invoking_user' to the docker group."
      warn "You may need to log out and back in for this to take effect for manual docker commands."
    fi
  fi
}

# =============================================================================
# Step 4: Create the data directory structure
# =============================================================================

setup_data_dir() {
  info "Setting up data directory at ${DATA_DIR}..."

  # Create all subdirectories we need.
  # -p means: create parent dirs as needed and don't fail if they already exist.
  mkdir -p "${DATA_DIR}/config"
  mkdir -p "${DATA_DIR}/apps"
  mkdir -p "${DATA_DIR}/volumes"

  # Restrict permissions — only root should read config (may contain credentials)
  chmod 750 "${DATA_DIR}"
  chmod 750 "${DATA_DIR}/config"

  info "Data directory ready."
}

# =============================================================================
# Step 5: Write (or refresh) the core docker-compose.yml
# =============================================================================

write_compose_file() {
  info "Writing core service configuration..."

  # We always overwrite this file so re-running the installer picks up any
  # changes to the image tag or configuration defaults.
  cat > "${DATA_DIR}/docker-compose.yml" << EOF
# OpenMasjidOS — core service
# Generated by install.sh — safe to re-run; your data lives in ./apps and ./volumes
# Do not edit this file by hand unless you know what you are doing; the installer
# will overwrite it on the next run.

version: "3.9"

services:
  core:
    image: ${IMAGE}
    container_name: openmasjid-core
    restart: unless-stopped

    ports:
      # The dashboard is available on port ${PORT}.
      # Change the left side (e.g. "8080:${PORT}") to use a different external port.
      - "${PORT}:${PORT}"

    volumes:
      # Mount the Docker socket so the core can manage app containers on this host.
      # This is intentional and required; the core never passes this socket to apps
      # unless an app's manifest explicitly requests it and the admin approves.
      - /var/run/docker.sock:/var/run/docker.sock

      # Mount our data directory so config, app state, and volumes persist
      # across core container restarts and upgrades.
      - ${DATA_DIR}:/data

    environment:
      # Tell the core where its data lives inside the container
      OPENMASJID_DATA_DIR: /data
      # The port the Go HTTP server binds to inside the container
      OPENMASJID_PORT: "${PORT}"

    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:${PORT}/api/health"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 15s

    labels:
      # Label the core itself so it is easy to identify
      com.openmasjid.service: "core"
EOF

  info "Configuration written to ${DATA_DIR}/docker-compose.yml"
}

# =============================================================================
# Step 6: Pull the image and start the service
# =============================================================================

pull_and_start() {
  info "Pulling the latest OpenMasjidOS image (this may take a minute on first install)..."

  # Pull explicitly first so progress is visible and errors are clear
  docker pull "${IMAGE}"

  info "Starting OpenMasjidOS..."

  # -p sets the Compose project name so it is consistent regardless of the
  # directory name. --detach runs it in the background.
  docker compose \
    --project-name "${COMPOSE_PROJECT}" \
    --file "${DATA_DIR}/docker-compose.yml" \
    up --detach

  info "Service started."
}

# =============================================================================
# Step 7: Wait for the service to become healthy
# =============================================================================

wait_for_health() {
  info "Waiting for OpenMasjidOS to finish starting up..."

  local max_seconds=60
  local elapsed=0
  local health_url="http://localhost:${PORT}/api/health"

  printf "  "

  while [ "$elapsed" -lt "$max_seconds" ]; do
    # Try to reach the health endpoint; suppress all output from curl/wget
    if command -v curl &>/dev/null; then
      if curl -sf --max-time 3 "$health_url" &>/dev/null; then
        echo ""
        info "OpenMasjidOS is up and healthy!"
        return 0
      fi
    elif command -v wget &>/dev/null; then
      if wget -q --timeout=3 -O /dev/null "$health_url" &>/dev/null; then
        echo ""
        info "OpenMasjidOS is up and healthy!"
        return 0
      fi
    fi

    printf "."
    sleep 2
    elapsed=$((elapsed + 2))
  done

  echo ""
  echo ""
  echo -e "${CLR_YELLOW}OpenMasjidOS is taking longer than expected to start.${CLR_RESET}"
  echo ""
  echo "  This can happen on slower hardware (like a Raspberry Pi) or a slow internet connection."
  echo "  The service may still come up on its own. You can check its status with:"
  echo ""
  echo "    docker logs openmasjid-core"
  echo ""
  echo "  And try opening the dashboard at: http://$(get_server_ip):${PORT}"
  echo ""
  # Exit 0 — we don't want to tear everything down just because startup was slow
  return 0
}

# =============================================================================
# Helper: get the server's primary LAN IP address
# =============================================================================

get_server_ip() {
  local ip=""

  # Try hostname -I first (Linux standard, returns all IPs space-separated)
  if command -v hostname &>/dev/null; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi

  # Fall back to ip route if we got nothing useful
  if [ -z "$ip" ] || [ "$ip" = "127.0.0.1" ]; then
    if command -v ip &>/dev/null; then
      ip="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{print $NF; exit}')"
    fi
  fi

  # If still nothing, show localhost
  if [ -z "$ip" ]; then
    ip="localhost"
  fi

  echo "$ip"
}

# =============================================================================
# Step 8: Print the success message
# =============================================================================

print_success() {
  local server_ip dashboard_url url_len pad
  server_ip="$(get_server_ip)"
  dashboard_url="http://${server_ip}"
  [ "${PORT}" != "80" ] && dashboard_url="${dashboard_url}:${PORT}"
  url_len="${#dashboard_url}"

  # Interior of the box is 53 chars wide (between the two ║ chars).
  # Layout: 3 leading spaces + URL + trailing padding = 53.
  # Guard against an unusually long URL (very rare) by clamping pad to 1.
  pad=$(( 53 - 3 - url_len ))
  [ "$pad" -lt 1 ] && pad=1

  echo ""
  printf "${CLR_GREEN}${CLR_BOLD}"
  printf '  ╔═══════════════════════════════════════════════════════╗\n'
  printf '  ║                                                       ║\n'
  printf '  ║   [=]  OpenMasjidOS is ready!                        ║\n'
  printf '  ║                                                       ║\n'
  printf '  ║   Open your browser and go to:                        ║\n'
  printf '  ║                                                       ║\n'
  # URL line: cyan for the URL, then back to green+bold for the trailing ║.
  # ANSI codes have zero visual width so they don't disturb the box alignment.
  printf "  ║   ${CLR_CYAN}%s${CLR_GREEN}${CLR_BOLD}%${pad}s║\n" "${dashboard_url}" ""
  printf '  ║                                                       ║\n'
  printf '  ╠═══════════════════════════════════════════════════════╣\n'
  printf '  ║                                                       ║\n'
  printf '  ║   First time?                                         ║\n'
  printf '  ║   The setup wizard will guide you through creating    ║\n'
  printf "  ║   your admin account and your masjid's details.       ║\n"
  printf '  ║                                                       ║\n'
  printf '  ╠═══════════════════════════════════════════════════════╣\n'
  printf '  ║                                                       ║\n'
  printf '  ║   Need help or want to report an issue?               ║\n'
  printf '  ║   https://github.com/hasan-ismail/OpenMasjidOS       ║\n'
  printf '  ║                                                       ║\n'
  printf '  ╚═══════════════════════════════════════════════════════╝\n'
  printf "${CLR_RESET}\n"
  echo ""
  printf "  Your data is stored in ${CLR_BOLD}%s${CLR_RESET} and will survive upgrades.\n" "${DATA_DIR}"
  printf "  To update OpenMasjidOS in the future, simply re-run this installer.\n"
  echo ""
}

# =============================================================================
# main — orchestrate everything in the right order
# =============================================================================

main() {
  print_banner

  echo "  This installer will set up OpenMasjidOS on your server."
  echo "  It is safe to re-run — if OpenMasjidOS is already installed, this will"
  echo "  update it to the latest version without touching your data."
  echo ""

  check_root
  detect_os
  install_docker
  setup_data_dir
  write_compose_file
  pull_and_start
  wait_for_health
  print_success
}

# Run!
main
