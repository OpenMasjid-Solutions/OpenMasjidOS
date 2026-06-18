# OpenMasjidOS

> A free, open-source operating layer for masjids. Install in one line, manage everything from a beautiful dashboard.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/OpenMasjidOS/OpenMasjidOS/main/install.sh | bash
```

Once installed, open your browser to `http://<server-ip>:8723` and follow the setup wizard.

## What is this?

OpenMasjidOS is self-hosted software that runs on any machine that supports Docker (a cheap mini-PC, a Raspberry Pi, a VPS). It gives your masjid a central dashboard to install and manage apps — prayer-time displays, donation pages, announcement boards, and more — all without any technical knowledge.

Think of it as an "app store for your masjid" that runs entirely on your own hardware.

## Requirements

- Linux (Debian/Ubuntu 20.04+, Raspberry Pi OS, Fedora 36+)
- x86_64 or arm64 architecture
- 1 GB RAM minimum, 2 GB recommended
- Internet connection (for install and app downloads)
- That's it — Docker is installed automatically if missing.

## Development

```bash
make dev     # run backend + frontend with hot reload
make build   # production build
make test    # run all tests
make lint    # run linters
```

## License

MIT — see [LICENSE](LICENSE).
