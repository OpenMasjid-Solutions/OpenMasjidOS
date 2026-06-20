# OpenMasjidOS

> **Free, open-source software platform for masjids.**
> Install in one command. Manage everything from a beautiful web dashboard. No technical knowledge required.

---

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/hasan-ismail/OpenMasjidOS/master/install.sh | bash
```

After installation, open your browser to **`http://openmasjidos.local`** (or **`http://<your-server-ip>`**) and follow the setup wizard.

---

## Table of Contents

- [What is OpenMasjidOS?](#what-is-openmasjidos)
- [Installation Guide](#installation-guide)
  - [Option A — Raspberry Pi (Ubuntu Server 22.04 LTS)](#option-a--raspberry-pi-ubuntu-server-2204-lts)
  - [Option B — Proxmox VE (LXC Container)](#option-b--proxmox-ve-lxc-container)
  - [Option C — Bare Metal Linux](#option-c--bare-metal-linux)
  - [Option D — Cloud VPS](#option-d--cloud-vps)
- [First Run & Setup Wizard](#first-run--setup-wizard)
- [Updating OpenMasjidOS](#updating-openmasjidos)
- [Data & Backups](#data--backups)
- [App Store & Apps](#app-store--apps)
- [Development](#development)
- [License](#license)

---

## What is OpenMasjidOS?

OpenMasjidOS is a self-hosted platform that runs on your masjid's own hardware — a Raspberry Pi, a spare mini-PC, a VPS, or a Proxmox server. It gives your masjid a central dashboard to install and manage apps without any technical knowledge.

**Think of it as: CasaOS / Umbrel — but built for masjids.**

Apps you can install from the App Store (coming soon):
- 🕌 Prayer Times Display — beautiful countdown clock for screens in the masjid
- 📢 Announcement Board — digital notice board for Jumu'ah reminders and events
- 🤲 Donation Page — self-hosted Sadaqah/Zakat collection page
- 📅 Events Calendar — public calendar for the community
- 📖 Quran Resources — offline Quran display and recitation

All apps run on **your hardware**, under **your control**. No subscriptions. No cloud lock-in. No data sharing.

**How it works:**
1. You install OpenMasjidOS once (takes ~2 minutes).
2. It runs as a Docker service that survives reboots automatically.
3. You browse the App Store, click Install, and the app is running in seconds.
4. Apps read your masjid's profile (name, location, prayer-time method) so they work without re-configuration.

---

## Installation Guide

### Requirements (all options)

| | Minimum | Recommended |
|---|---|---|
| **RAM** | 1 GB | 2 GB |
| **Storage** | 8 GB free | 32 GB |
| **Architecture** | amd64 or arm64 | — |
| **Internet** | Required (for install + app downloads) | — |

Docker is installed automatically if it is not already present.

---

### Option A — Raspberry Pi (Ubuntu Server 22.04 LTS)

This is the recommended setup for most masjids. A Raspberry Pi 4 or 5 with Ubuntu Server 22.04 LTS costs around £50–£80 and runs silently 24/7 on less power than a phone charger.

#### What you need

- **Raspberry Pi 4** (2 GB RAM minimum, 4 GB recommended) or **Raspberry Pi 5**
- MicroSD card — 32 GB or larger, Class 10 / A1 rated (Samsung Endurance or SanDisk Endurance)
  - *Optional but recommended:* USB SSD instead of SD card for much better reliability
- Power supply (official Raspberry Pi USB-C PSU)
- Ethernet cable (strongly recommended — Wi-Fi can drop and interrupt the dashboard)
- A computer to flash the SD card from

#### Step 1 — Flash Ubuntu Server 22.04 LTS

1. Download and install **Raspberry Pi Imager** from [raspberrypi.com/software](https://www.raspberrypi.com/software/) on your laptop/PC.

2. Open Raspberry Pi Imager:
   - **Choose Device** → select your Pi model (Raspberry Pi 4 or 5)
   - **Choose OS** → scroll down to **Other general-purpose OS** → **Ubuntu** → **Ubuntu Server 22.04.x LTS (64-bit)**
   - **Choose Storage** → select your SD card or USB SSD

3. Click the **gear icon ⚙** (or press Ctrl+Shift+X) to open Advanced Settings **before** writing:
   - ✅ Enable **Set hostname** → e.g. `openmasjid`
   - ✅ Enable **SSH** → select **Use password authentication**
   - ✅ Enable **Set username and password** → username: `openmasjid`, choose a strong password
   - ✅ Enable **Configure wireless LAN** only if you have no ethernet (enter your Wi-Fi SSID + password)
   - **Wireless LAN country** → set to your country code (e.g. `GB` for UK, `US` for USA)
   - ✅ Enable **Set locale settings** → set your timezone

4. Click **Save**, then click **Write**. Confirm the warning. Flashing takes 2–5 minutes.

#### Step 2 — First boot

1. Insert the SD card (or plug in the USB SSD) into the Raspberry Pi.
2. Connect the ethernet cable.
3. Power on the Pi.
4. Wait **60–90 seconds** for the first boot to complete (Ubuntu does initial setup automatically).

#### Step 3 — Find your Pi's IP address

**Option A — Check your router:**
Log in to your home/masjid router (usually at `192.168.1.1` or `192.168.0.1`). Look for a connected device named `openmasjid`.

**Option B — Scan the network:**
```bash
# On Linux/Mac
ping openmasjid.local

# Or use nmap
nmap -sn 192.168.1.0/24 | grep -i openmasjid
```

**Option C — Connect a monitor and keyboard** to the Pi. Log in and run:
```bash
ip addr show eth0 | grep 'inet '
```

#### Step 4 — SSH into your Pi

From your laptop/PC:
```bash
ssh openmasjid@<your-pi-ip>
# e.g. ssh openmasjid@192.168.1.45
# or:
ssh openmasjid@openmasjid.local
```

Enter the password you set in Raspberry Pi Imager.

#### Step 5 — Update the system

```bash
sudo apt update && sudo apt upgrade -y
```

This takes 2–5 minutes. When it finishes, optionally reboot:
```bash
sudo reboot
```

Wait 30 seconds, then SSH back in.

#### Step 6 — Install OpenMasjidOS

```bash
curl -fsSL https://raw.githubusercontent.com/hasan-ismail/OpenMasjidOS/master/install.sh | bash
```

The installer will:
- Install Docker and Docker Compose if not already installed
- Pull the OpenMasjidOS image
- Start the service
- Print your access URL

The whole process takes **2–4 minutes** depending on your internet speed.

#### Step 7 — Open the dashboard

On any device on the same network, open a browser and go to:

```
http://<your-pi-ip>
```

e.g. `http://192.168.1.45`

You should see the OpenMasjidOS setup wizard.

#### Step 8 — Set a static IP (strongly recommended)

So the dashboard is always at the same address, assign a **DHCP reservation** in your router:

1. Log in to your router admin panel.
2. Find **DHCP Reservations** (sometimes called **Static Leases** or **Address Reservation**).
3. Add a reservation for your Pi's MAC address with a fixed IP (e.g. `192.168.1.10`).
4. Reboot the Pi.

From now on the dashboard is always at the same address. You can then tell people to go to `http://192.168.1.10` (or whatever IP you chose).

---

### Option B — Proxmox VE (LXC Container)

If your masjid already runs Proxmox VE, the easiest approach is to use the **Proxmox VE Community Helper Scripts** to create a clean Ubuntu 22.04 LXC container, then run the OpenMasjidOS installer inside it.

#### Prerequisites

- Proxmox VE 7.x or 8.x running
- Access to the **Proxmox web UI** and the **Proxmox Shell** (Node → Shell)

#### Step 1 — Open the Proxmox Shell

In the Proxmox web UI, click your **node name** (e.g. `pve`) in the left sidebar, then click **Shell** in the top menu. A terminal window opens running as root on the Proxmox host.

#### Step 2 — Create an Ubuntu 22.04 LXC using the community helper script

Paste this into the Proxmox Shell:

```bash
bash -c "$(wget -qLO - https://github.com/community-scripts/ProxmoxVE/raw/main/ct/ubuntu2204.sh)"
```

The script will ask you a series of questions. Use these settings:

| Prompt | Recommended value |
|---|---|
| **Default Settings?** | No — select Advanced |
| **CT Type** | 1 — Unprivileged |
| **Root Password** | Set a strong password |
| **Container ID** | Accept default or choose a number |
| **Hostname** | `openmasjid` |
| **Disk Size (GB)** | `16` |
| **CPU Cores** | `2` |
| **RAM (MiB)** | `2048` (2 GB) |
| **Bridge** | `vmbr0` |
| **IP Address** | Either `dhcp` or a static IP like `192.168.1.10/24` |
| **Gateway** | Your router IP, e.g. `192.168.1.1` |
| **DNS** | `1.1.1.1` (Cloudflare) or your local DNS |
| **Start after created** | Yes |

The script downloads the Ubuntu 22.04 template and creates the container automatically. This takes 1–3 minutes.

> **Note:** If you prefer the manual approach — in the Proxmox web UI go to your node → **local** storage → **CT Templates** → Download template → search for **ubuntu-22.04** → Download. Then create a new CT from that template.

#### Step 3 — Access the container shell

In the Proxmox web UI, click your new container (`openmasjid`) in the left sidebar, then click **Console**. You are now inside the Ubuntu 22.04 container as root.

Or from the Proxmox host shell:
```bash
pct enter <container-id>
# e.g. pct enter 101
```

#### Step 4 — Update the container

```bash
apt update && apt upgrade -y
```

#### Step 5 — Install OpenMasjidOS

```bash
curl -fsSL https://raw.githubusercontent.com/hasan-ismail/OpenMasjidOS/master/install.sh | bash
```

> **Docker inside LXC:** The installer will configure Docker correctly for LXC. If you see permission errors around `/var/run/docker.sock`, ensure the container has the **keyctl** and **nesting** features enabled. In the Proxmox web UI go to Container → Options → Features → tick **Nesting** and **keyctl**.

#### Step 6 — Open the dashboard

From any browser on your network:
```
http://<container-ip>
```

To find the container IP from within the container:
```bash
ip addr show eth0 | grep 'inet '
```

#### Step 7 — Assign a static IP in Proxmox (recommended)

In the Proxmox web UI, go to the container → **Network** → edit the network interface → set a **Static** IPv4 address (e.g. `192.168.1.10/24`) and gateway. Then restart the container.

---

### Option C — Bare Metal Linux

Run directly on any Linux machine — a mini-PC, an old laptop, or a dedicated server. The installer supports Debian/Ubuntu and Fedora/RHEL family distributions.

#### Supported operating systems

| OS | Versions |
|---|---|
| **Ubuntu Server** | 20.04 LTS, 22.04 LTS, 24.04 LTS |
| **Debian** | 11 (Bullseye), 12 (Bookworm) |
| **Raspberry Pi OS** | Bullseye (64-bit), Bookworm (64-bit) |
| **Fedora** | 36 and newer |
| **Rocky Linux / AlmaLinux** | 8, 9 |

#### Prerequisites

- A user account with `sudo` access (or root)
- Internet connection
- `curl` installed (it is on most systems; if not: `sudo apt install curl` or `sudo dnf install curl`)

#### Install

SSH into your machine and run:

```bash
curl -fsSL https://raw.githubusercontent.com/hasan-ismail/OpenMasjidOS/master/install.sh | bash
```

The script will ask for your `sudo` password if you are not already root. It will:

1. Detect your OS and CPU architecture
2. Install Docker + Docker Compose plugin if not present
3. Create `/opt/openmasjid/` for all data
4. Pull and start the OpenMasjidOS core service
5. Configure it to start automatically on reboot
6. Print your access URL

#### Access

```
http://<machine-ip>
```

To find your machine IP:
```bash
ip addr show | grep 'inet ' | grep -v '127.0.0.1'
```

#### Make it start on boot

The installer handles this automatically — OpenMasjidOS runs as a Docker service with `restart: unless-stopped`, so it starts with Docker on every boot. Docker itself is configured to start on boot during installation.

To verify:
```bash
sudo docker ps
# You should see the openmasjid-core container with status "Up X hours"
```

---

### Option D — Cloud VPS

OpenMasjidOS works on any Linux VPS. Recommended providers for masjids on a budget:

- **Hetzner Cloud** — CPX11 (2 vCPU, 2 GB RAM) from ~€4/month
- **DigitalOcean** — Basic Droplet (1 GB RAM) from $6/month
- **Vultr** — Cloud Compute 1 GB from $6/month
- **Linode/Akamai** — Nanode 1 GB from $5/month

Create a VPS with **Ubuntu 22.04 LTS**, SSH in, and run the one-liner above.

> **Important:** If you host on a VPS, your dashboard is accessible on the public internet. Make sure to:
> 1. Set a strong admin password in the setup wizard.
> 2. Configure your VPS firewall to restrict port 80 to known IPs, or put it behind a reverse proxy with HTTPS.
> 3. Consider using a private network/VPN for masjid-internal access.

---

## First Run & Setup Wizard

The first time you open the dashboard you'll create your **admin account** — choose a username and a password (at least 8 characters). This is the only account that can access the dashboard, and it's protected by a login from then on.

That's the whole setup. You're taken straight to the dashboard, where you can browse the App Store and install your first app.

> **Where do prayer times and location go?** Each app that needs them collects its own masjid details (prayer calculation method, location, etc.) when you install it. The platform itself stays generic, so different apps can use different settings if you ever need that.

---

## Resetting the admin password

Forgot the admin password? You can reset it from the server's terminal — no data is lost. You need terminal access to the machine running OpenMasjidOS, either sitting at it directly or connected over **SSH**:

```bash
# Connect to the server first if you're remote, e.g.:
#   ssh youruser@192.168.1.18

docker exec -it openmasjid-core /openmasjid -passwd
```

You'll be prompted to type a new password (twice). Then return to the dashboard and sign in with it. The "Forgot your password?" link on the login screen shows these same instructions.

For unattended/scripted use you can pass the password directly (it will be visible in your shell history, so prefer the interactive form above):

```bash
docker exec openmasjid-core /openmasjid -passwd 'your-new-password'
```

---

## Updating OpenMasjidOS

To update to the latest version, simply re-run the installer. It is fully idempotent — running it again on an already-installed system will pull the latest image and restart the service without touching your data.

```bash
curl -fsSL https://raw.githubusercontent.com/hasan-ismail/OpenMasjidOS/master/install.sh | bash
```

Or update manually using Docker:

```bash
cd /opt/openmasjid
sudo docker compose pull
sudo docker compose up -d
```

---

## Data & Backups

All data is stored under `/opt/openmasjid/`:

```
/opt/openmasjid/
├── docker-compose.yml   # core service definition
├── config/              # masjid profile, settings, admin credentials
└── apps/
    └── <app-id>/        # per-app persistent data (volumes)
```

**To back up everything:**
```bash
sudo tar -czf openmasjid-backup-$(date +%Y%m%d).tar.gz /opt/openmasjid
```

**To restore on a new machine:**
1. Install OpenMasjidOS on the new machine using the one-liner above.
2. Stop the service: `sudo docker compose -f /opt/openmasjid/docker-compose.yml down`
3. Extract the backup: `sudo tar -xzf openmasjid-backup-YYYYMMDD.tar.gz -C /`
4. Start the service: `sudo docker compose -f /opt/openmasjid/docker-compose.yml up -d`

---

## App Store & Apps

Apps are defined in a separate repository: **[OpenMasjidAPPS](https://github.com/hasan-ismail/OpenMasjidAPPS)** (coming soon).

Each app is a self-contained Docker container described by a manifest file. OpenMasjidOS fetches the app catalog from that repository and handles installation, updates, and removal.

If you want to build an app for your masjid, see [`docs/APP_MANIFEST_SPEC.md`](docs/APP_MANIFEST_SPEC.md) for the specification.

---

## Development

**Requirements:** Node.js 20+, Docker

OpenMasjidOS is a TypeScript monorepo (npm workspaces): a Node + Fastify + tRPC
daemon (`packages/core`) and a React + Vite + Tailwind dashboard (`packages/ui`).

```bash
# Clone
git clone https://github.com/hasan-ismail/OpenMasjidOS.git
cd OpenMasjidOS

# Install all workspaces
npm install

# Run the daemon + UI together with hot reload
npm run dev

# Type-check both packages
npm run lint

# Production build (builds the UI, bundles the daemon)
npm run build

# Build & tag the runtime Docker image
npm run image
```

In production the daemon listens on **port 80** (set by the installer/compose).
In dev it defaults to **8723** (no root needed); the Vite dev server runs on
`http://localhost:5173` and proxies `/trpc` (HTTP + WebSocket) and `/api` to the
daemon automatically — open `http://localhost:5173`.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the system is structured.

---

## License

GNU Affero General Public License v3.0 (AGPL-3.0) — see [LICENSE](LICENSE).

In short: you are free to use, modify, and distribute this software. If you deploy a modified version as a network service (e.g. a hosted offering), you must also publish the modified source code under the same license. This ensures that improvements made by one masjid benefit all masjids.
