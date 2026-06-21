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

# print_banner — show a welcoming header so users know what is running.
# The ASCII art is output via a heredoc to avoid escaping issues with the
# single-quote and backtick characters present in the figlet-rendered text.
print_banner() {
  echo ""
  printf "${CLR_CYAN}${CLR_BOLD}"
  cat << 'BANNER_EOF'
  ___                   __  __            _ _     _  ___  ____
 / _ \ _ __   ___ _ __ |  \/  | __ _ ___ (_|_) __| |/ _ \/ ___|
| | | | '_ \ / _ \ '_ \| |\/| |/ _` / __|| | |/ _` | | | \___ \
| |_| | |_) |  __/ | | | |  | | (_| \__ \| | | (_| | |_| |___) |
 \___/| .__/ \___|_| |_|_|  |_|\__,_|___// |_|\__,_|\___/|____/
      |_|                              |__/
BANNER_EOF
  printf "${CLR_RESET}"
  echo ""
  print_mosque
  echo ""
  printf "${CLR_GREEN}${CLR_BOLD}        Free, open-source software for your masjid${CLR_RESET}\n"
  printf "${CLR_GREEN}     Prayer times, donations, displays & more — on your own server${CLR_RESET}\n"
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

# print_mosque — a little decorative masjid, shown in the banner and success box.
print_mosque() {
  printf "${CLR_CYAN}"
  cat << 'MOSQUE'
                        .
                       /|\
                      ( | )
                    __'-|-'__
                .-''    |    ''-.
              .'      .-'-.      '.
       __    /       /     \       \    __
      |  |  |       |  .-.  |       |  |  |
      |  |  |       | |   | |       |  |  |
      |  |  |       | |   | |       |  |  |
      |__|__|_______|_|___|_|_______|__|__|
MOSQUE
  printf "${CLR_RESET}"
}

# step — friendly, numbered progress header (set STEP_TOTAL before using).
STEP_TOTAL=6
STEP_NUM=0
step() {
  STEP_NUM=$((STEP_NUM + 1))
  echo ""
  printf "${CLR_CYAN}${CLR_BOLD}  ◆  Step %s of %s${CLR_RESET}  %s\n" "${STEP_NUM}" "${STEP_TOTAL}" "$*"
  printf "${CLR_CYAN}  ──────────────────────────────────────────────${CLR_RESET}\n"
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

      # Mount the host's /proc read-only so system stats (esp. memory) reflect
      # the MACHINE (or LXC, via lxcfs) rather than the bare host underneath.
      - /proc:/host/proc:ro

      # Mount the host cgroup read-only so memory usage matches what Proxmox/the
      # host reports (memory.current minus reclaimable cache) — lxcfs meminfo can
      # disagree significantly inside an LXC.
      - /sys/fs/cgroup:/host/sys/fs/cgroup:ro

    environment:
      # Tell the core where its data lives inside the container
      OPENMASJID_DATA_DIR: /data
      # The port the daemon binds to inside the container
      OPENMASJID_PORT: "${PORT}"
      # Point the stats collector at the mounted host /proc + cgroup.
      HOST_PROC: /host/proc
      HOST_CGROUP: /host/sys/fs/cgroup
      NODE_ENV: production

    healthcheck:
      # The Alpine runtime ships busybox wget — a tiny HTTP check.
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:${PORT}/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

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
  info "Downloading OpenMasjidOS — a one-time download that can take a minute or two on slower internet. Please wait..."

  # Pull explicitly first so progress is visible and errors are clear
  docker pull "${IMAGE}"

  info "Starting OpenMasjidOS up..."

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
# Acknowledgements — credit the people and organisations behind the project.
# Shown at the end of every install / update / repair, right before we print
# the dashboard address. Keep in step with the README "Acknowledgements".
# =============================================================================

print_acknowledgements() {
  echo ""
  printf "${CLR_CYAN}${CLR_BOLD}  ┌─ With gratitude ──────────────────────────────${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}   OpenMasjidOS is built with the help of:\n"
  printf "${CLR_CYAN}  │${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}     Created by  ${CLR_BOLD}Hasan Ismail${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}     With help   ${CLR_BOLD}Qari Ijaz${CLR_RESET} & ${CLR_BOLD}Osman Sayed${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}   Generously sponsored by:\n"
  printf "${CLR_CYAN}  │${CLR_RESET}     ${CLR_BOLD}An-Noor Institute${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}     ${CLR_BOLD}Rihlatul Ilm Foundation${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}     ${CLR_BOLD}AsmaTec Inc.${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}\n"
  printf "${CLR_CYAN}  │${CLR_RESET}   ${CLR_GREEN}May Allah reward everyone who made it possible.${CLR_RESET}\n"
  printf "${CLR_CYAN}${CLR_BOLD}  └───────────────────────────────────────────────${CLR_RESET}\n"
  echo ""
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
  printf '  ║   your admin account to sign in.                      ║\n'
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
# Lifecycle: detect state, show a menu, and run the chosen action
# =============================================================================

# is_installed — true if OpenMasjidOS is already on this machine.
is_installed() {
  [ -f "${DATA_DIR}/docker-compose.yml" ] && return 0
  if command -v docker &>/dev/null; then
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^openmasjid-core$' && return 0
  fi
  return 1
}

# menu_fresh / menu_existing — print a menu to the terminal and echo the chosen
# action to stdout. IMPORTANT: we read from /dev/tty, not stdin — under
# `curl ... | bash` stdin IS the script, so a plain `read` never reaches the
# keyboard. /dev/tty is the actual controlling terminal. With no terminal
# (CI/automation) we fall back to a safe default.
menu_fresh() {
  if [ ! -r /dev/tty ]; then echo "install"; return; fi
  {
    echo ""
    printf "${CLR_CYAN}${CLR_BOLD}  ┌─ Welcome! Let's get you set up ───────────────${CLR_RESET}\n"
    printf "${CLR_CYAN}  │${CLR_RESET}\n"
    printf "${CLR_CYAN}  │${CLR_RESET}   ${CLR_GREEN}${CLR_BOLD}1)${CLR_RESET} Install  ${CLR_BOLD}—${CLR_RESET} set up OpenMasjidOS now\n"
    printf "${CLR_CYAN}  │${CLR_RESET}   ${CLR_GREEN}${CLR_BOLD}2)${CLR_RESET} Exit     ${CLR_BOLD}—${CLR_RESET} do nothing\n"
    printf "${CLR_CYAN}  │${CLR_RESET}\n"
    printf "${CLR_CYAN}${CLR_BOLD}  └───────────────────────────────────────────────${CLR_RESET}\n"
    printf "  Type a number and press Enter ${CLR_BOLD}[1]${CLR_RESET}: "
  } > /dev/tty
  local r=""; read -r r < /dev/tty || r=""
  case "$r" in
    2) echo "exit" ;;
    *) echo "install" ;;
  esac
}

menu_existing() {
  if [ ! -r /dev/tty ]; then echo "update"; return; fi
  {
    echo ""
    printf "${CLR_CYAN}${CLR_BOLD}  ┌─ OpenMasjidOS is already installed ───────────${CLR_RESET}\n"
    printf "${CLR_CYAN}  │${CLR_RESET}   What would you like to do?\n"
    printf "${CLR_CYAN}  │${CLR_RESET}\n"
    printf "${CLR_CYAN}  │${CLR_RESET}   ${CLR_GREEN}${CLR_BOLD}1)${CLR_RESET} Update  ${CLR_BOLD}—${CLR_RESET} get the latest version (keeps your apps & data)\n"
    printf "${CLR_CYAN}  │${CLR_RESET}   ${CLR_GREEN}${CLR_BOLD}2)${CLR_RESET} Repair  ${CLR_BOLD}—${CLR_RESET} fix a broken install and restart\n"
    printf "${CLR_CYAN}  │${CLR_RESET}   ${CLR_GREEN}${CLR_BOLD}3)${CLR_RESET} Remove  ${CLR_BOLD}—${CLR_RESET} uninstall (your apps & data stay safe)\n"
    printf "${CLR_CYAN}  │${CLR_RESET}   ${CLR_GREEN}${CLR_BOLD}4)${CLR_RESET} Quit    ${CLR_BOLD}—${CLR_RESET} do nothing\n"
    printf "${CLR_CYAN}  │${CLR_RESET}\n"
    printf "${CLR_CYAN}${CLR_BOLD}  └───────────────────────────────────────────────${CLR_RESET}\n"
    printf "  Type a number and press Enter ${CLR_BOLD}[1]${CLR_RESET}: "
  } > /dev/tty
  local r=""; read -r r < /dev/tty || r=""
  case "$r" in
    2) echo "repair" ;;
    3) echo "uninstall" ;;
    4) echo "quit" ;;
    *) echo "update" ;;
  esac
}

# do_install — first-time guided install.
do_install() {
  echo ""
  echo "  Setting up OpenMasjidOS on this machine. This takes a minute or two —"
  echo "  grab a cup of tea and we'll let you know when it's ready. ☕"

  step "Checking your computer"
  check_root
  detect_os

  step "Making sure Docker is installed (the engine that runs the apps)"
  install_docker

  step "Creating a safe place for your data"
  setup_data_dir

  step "Writing the configuration"
  write_compose_file

  step "Downloading OpenMasjidOS and starting it up"
  pull_and_start

  step "Waiting for everything to be ready"
  wait_for_health

  # Thank the people and sponsors who made this possible, then show the URL.
  print_acknowledgements
  print_success
}

# do_update — pull the latest core and recreate it. NEVER touches installed
# apps (separate compose projects) or their data — see CLAUDE.md golden rule.
do_update() {
  check_root
  install_docker          # idempotent: present → skip
  setup_data_dir          # mkdir -p only
  write_compose_file
  info "Updating to the latest version..."
  docker pull "${IMAGE}"
  docker compose --project-name "${COMPOSE_PROJECT}" --file "${DATA_DIR}/docker-compose.yml" up --detach
  wait_for_health
  echo ""
  info "OpenMasjidOS is up to date. Your installed apps and data were left untouched."
  print_acknowledgements
  echo "  Open it at: http://$(get_server_ip)$( [ "${PORT}" != "80" ] && echo ":${PORT}" )"
  echo ""
}

# do_repair — like update but force-recreates the core and re-fixes config.
# Also only touches the core project.
do_repair() {
  check_root
  install_docker
  setup_data_dir
  write_compose_file
  info "Repairing — re-pulling and recreating the core service..."
  docker pull "${IMAGE}"
  docker compose --project-name "${COMPOSE_PROJECT}" --file "${DATA_DIR}/docker-compose.yml" up --detach --force-recreate
  wait_for_health
  echo ""
  info "Repair complete. Your installed apps and data were left untouched."
  print_acknowledgements
  echo "  Open it at: http://$(get_server_ip)$( [ "${PORT}" != "80" ] && echo ":${PORT}" )"
  echo ""
}

# do_uninstall — remove the core. Installed apps keep running and their data is
# kept UNLESS the user explicitly types DELETE (golden rule).
do_uninstall() {
  check_root
  info "Stopping and removing the OpenMasjidOS core..."
  if [ -f "${DATA_DIR}/docker-compose.yml" ]; then
    docker compose --project-name "${COMPOSE_PROJECT}" --file "${DATA_DIR}/docker-compose.yml" down || true
  else
    docker rm -f openmasjid-core 2>/dev/null || true
  fi
  echo ""
  info "The OpenMasjidOS core has been removed."
  echo "  Your installed apps are still running and your data is intact at ${DATA_DIR}."
  echo "  (Re-run this installer any time to bring the dashboard back — it will find your apps.)"
  echo ""

  local confirm=""
  if [ -r /dev/tty ]; then
    printf "  Also remove ALL installed apps and their data? This cannot be undone.\n  Type %sDELETE%s to confirm, or press Enter to keep everything: " "${CLR_BOLD}" "${CLR_RESET}" > /dev/tty
    read -r confirm < /dev/tty || confirm=""
  fi

  if [ "$confirm" = "DELETE" ]; then
    warn "Removing all installed apps and their data..."
    # Only here — and only after explicit DELETE — do we stop user app projects.
    # Capture first (|| true) so an empty list can't trip `set -e` / pipefail.
    local projects=""
    projects="$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep '^omos-' | sort -u || true)"
    if [ -n "$projects" ]; then
      while read -r proj; do
        [ -n "$proj" ] && docker compose -p "$proj" down -v 2>/dev/null || true
      done <<< "$projects"
    fi
    rm -rf "${DATA_DIR}"
    info "Everything has been removed."
  else
    info "Kept all your apps and data."
  fi

  # A grateful farewell — the same credits shown on install/update/repair.
  print_acknowledgements
  echo "  Thank you for running OpenMasjidOS. You're welcome back any time."
  echo ""
}

# =============================================================================
# main — detect state, branch, run
# =============================================================================

main() {
  print_banner

  # Optional non-interactive override: --install / --update / --repair / --uninstall.
  local action=""
  for arg in "$@"; do
    case "$arg" in
      --install)            action="install" ;;
      --update)             action="update" ;;
      --repair)             action="repair" ;;
      --uninstall|--remove) action="uninstall" ;;
    esac
  done

  # No override → detect state and ask.
  if [ -z "$action" ]; then
    if is_installed; then
      action="$(menu_existing)"
    else
      action="$(menu_fresh)"
    fi
  fi

  case "$action" in
    install)   do_install ;;
    update)    do_update ;;
    repair)    do_repair ;;
    uninstall) do_uninstall ;;
    exit|quit|"") echo "  No changes made."; exit 0 ;;
    *) error "Unknown action: ${action}" ;;
  esac
}

# Run!
main "$@"
