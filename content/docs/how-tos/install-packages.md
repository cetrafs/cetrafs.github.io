---
weight: 305
title: "Install from Debian packages"
description: "Build the cetrafs-dkms and cetrafs-tools packages and install them so the module survives kernel upgrades and loads on first mount."
toc: true
---

This guide builds the two cetrafs Debian packages from the source tree and installs them. This is the recommended way to install cetrafs on Debian and Proxmox VE.

| Package | Contents |
|---|---|
| `cetrafs-dkms` | The kernel module source plus DKMS wiring, so `cetrafs.ko` is rebuilt automatically on every kernel upgrade. |
| `cetrafs-tools` | `mkfs.cetra`, `fsck.cetra` and `defrag.cetra`, installed in `/usr/sbin`. |

## Build the packages

On a build host (it can be one of the cluster nodes):

```sh
sudo apt install debhelper dh-dkms build-essential     # build dependencies, once
cd cetrafs
make deb
ls dist/
```

`make deb` writes the packages to `dist/`. It checks that the version in `debian/changelog`, `dkms.conf` and `debian/rules` all match before it builds, and it refuses to build if they disagree, because a mismatch produces a package whose module never builds.

To remove `dist/` and the staging directories:

```sh
make deb-clean
```

{{< callout type="warning" title="A built package is not a tested one" >}}
Package builds skip the test suite, because it needs root, loads the module and takes minutes. Run `make check` yourself before you deploy a build. See [Run the test suites](/docs/how-tos/run-tests/).
{{< /callout >}}

## Install on every node

Copy both `.deb` files to each node, then:

```sh
sudo apt install linux-headers-$(uname -r)              # DKMS needs the headers
sudo apt install ./cetrafs-dkms_*.deb ./cetrafs-tools_*.deb
```

DKMS builds the module for the running kernel during installation.

## Verify

```sh
dkms status cetrafs                  # cetrafs/<version>, <kernel>, <arch>: installed
modinfo cetrafs | head -3
which mkfs.cetra fsck.cetra defrag.cetra
```

You don't need to load the module by hand or add it to `/etc/modules-load.d`. The module declares the `fs-cetrafs` alias, so the first `mount -t cetrafs` loads it, just as with an in-tree filesystem. That includes mounts from `/etc/fstab` at boot and mounts made by a cluster manager.

## After a kernel upgrade

Install the headers for the new kernel at the same time as the kernel itself (on Proxmox, the `proxmox-headers-*` package that matches the kernel). DKMS then rebuilds `cetrafs.ko` automatically. Check with `dkms status cetrafs` before you reboot into the new kernel.

## Related

- [Install with DKMS](/docs/how-tos/install-dkms/) without packaging.
- [Build and install from source](/docs/how-tos/build-from-source/).
