<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Networking — how the dashboard is reached

## The address

OpenMasjidOS is reached on your local network at:

- **`https://<server-ip>`** — e.g. `https://192.168.1.50`. This is the address the
  installer prints when it finishes.

Note **`https`**, and note there is no port number. The dashboard is served over TLS on
**443**, and port **80** is an HTTP front door that redirects browsers to HTTPS (it also
carries the LAN-only routes that apps use to talk to the platform, which cannot use a
self-signed certificate server-to-server).

### The certificate warning is expected

The certificate is self-signed and generated on first boot — a machine on a private LAN
has no public name, so no certificate authority can issue for it. The first time each
phone or laptop opens the dashboard, the browser will say **"Not secure"**. Click
**Advanced → Proceed** once per device and you will not be asked again.

You can replace the certificate with your own in **Settings → Advanced**. A damaged or
half-restored certificate cannot stop the box booting: it is quarantined and regenerated,
and if no certificate can be made at all the dashboard falls back to plain HTTP rather
than refusing to start.

## Keeping the address from changing

Most home and masjid routers hand out addresses by DHCP, so a server's IP can change
after a reboot or a power cut. The simplest fix, and the one we recommend, is a **DHCP
reservation** (sometimes called "static lease" or "address reservation") in your router's
admin page: find the machine in the client list and tell the router to always give it the
same address. This is safer than configuring a static address on the machine itself,
because the router stays the single source of truth and there is nothing to get out of
step.

### Not yet built: `openmasjidos.local` and installer-managed static IP

`.local` (mDNS) discovery and a guided static-IP step **are planned but not implemented**.
The installer does not install `avahi`, does not change the hostname, and does not write
any network configuration; the management menu has no "Reconfigure network" entry. This
page described both as working features for several releases — they were specified and
never built. `openmasjidos.local` does appear in the dashboard certificate's subject
alternative names, so the name will work the day mDNS is added, but it does not resolve
today.

If you want a name instead of an address now, add an entry to your router's local DNS (if
it has one), or to the `hosts` file on the few devices that need it.

### Doing a static IP by hand

If you would rather set a static address on the machine, use the tool your distribution
actually uses:

- **netplan** (Ubuntu Server): edit `/etc/netplan/*.yaml`, then `sudo netplan apply`.
- **NetworkManager** (`nmcli`):
  `nmcli con mod <name> ipv4.addresses <cidr> ipv4.gateway <gw> ipv4.method manual && nmcli con up <name>`.
- **dhcpcd** (older Raspberry Pi OS): add a `static ip_address=` block to `/etc/dhcpcd.conf`.
- **systemd-networkd**: set `Address=` / `Gateway=` under `[Network]` in
  `/etc/systemd/network/*.network`.

Write down your current IP, gateway and interface first, so you can put them back.

> **On a remote machine, changing the IP will drop your SSH session** — reconnect on the
> new address. **On a cloud or VPS host, do not do this at all**: the provider manages
> addressing, and overriding it can lock you out of your own server. Use the provider's
> control panel to reserve an address instead.

## Ports

| Port | What it is |
|------|-----------|
| **443** | The dashboard, over HTTPS. This is what you open in a browser. |
| **80** | Redirects browsers to HTTPS, and serves the LAN-only app↔platform routes. |

Both are set at the top of `install.sh` (`TLS_PORT` and `PORT`). Changing them means
editing the port mapping in `/opt/openmasjid/docker-compose.yml` and re-running the
installer's **Repair** — but be aware that Repair rewrites that file from the same
constants, so a hand-edited port does not survive it. There is no `--port` flag; if you
need one, it needs adding to the installer properly.

## Remote access

Reaching the dashboard from outside the masjid is deliberately **not** something these
ports do. If you need remote access, use **Settings → Remote access**, which sets up a
Cloudflare Tunnel that publishes **only the apps you choose**, per app, off by default.
The admin dashboard itself is never exposed through it — see [`SECURITY.md`](SECURITY.md).
