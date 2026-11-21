---
weight: 305
title: "Install from Debian packages"
description: "Install the cetrafs-dkms and cetrafs-tools packages from a GitHub release, or build them yourself, so the module survives kernel upgrades and loads on first mount."
toc: true
---

This is the recommended way to install cetrafs on Debian and Proxmox VE. There are two packages:

| Package | Contents |
|---|---|
| `cetrafs-dkms` | The kernel module source plus DKMS wiring, so `cetrafs.ko` is rebuilt automatically on every kernel upgrade. |
| `cetrafs-tools` | `mkfs.cetra`, `fsck.cetra`, `defrag.cetra` and `growfs.cetra`, installed in `/usr/sbin`. |

Every release of cetrafs publishes both packages on the [GitHub releases page](https://github.com/cetrafs/cetrafs/releases). On Proxmox VE, [Install on Proxmox VE](/docs/how-tos/install-proxmox/) covers the same steps plus the storage plugin.

## Install a released version

On **every** node:

```sh
VER={{< version >}}
URL=https://github.com/cetrafs/cetrafs/releases/download/$VER
wget $URL/cetrafs-dkms_${VER}_all.deb $URL/cetrafs-tools_${VER}_amd64.deb

sudo apt install linux-headers-$(uname -r)       # DKMS needs the headers
sudo apt install ./cetrafs-dkms_${VER}_all.deb ./cetrafs-tools_${VER}_amd64.deb
```

DKMS builds the module for the running kernel during installation.

{{< callout type="note" title="Secure Boot" >}}
With Secure Boot enabled, the kernel refuses the module (`Key was rejected by service`) until the DKMS signing key is enrolled on the node. Do it once per node: see [Load the module with Secure Boot](/docs/how-tos/secure-boot/).
{{< /callout >}}

The packages are built on Debian 13. `cetrafs-dkms` is architecture-independent, because it ships source, but `cetrafs-tools` is published for **amd64** only. On arm64, [build the packages yourself](#build-the-packages-yourself).

The release is tested before it is tagged: the full gate, the two-node suite on real SAN storage, the fuzzers and the crash rig (see [How cetrafs is tested](/docs/concepts/testing/)). The packages themselves are built by CI from the tagged source. Before the first deployment, also [validate your storage stack](/docs/how-tos/validate-storage-stack/): it checks the properties of your SAN that cetrafs relies on.

The packaged module is a release build: it refuses every test-only module parameter.

## Verify

```sh
dkms status cetrafs                  # cetrafs/<version>, <kernel>, <arch>: installed
modinfo cetrafs | head -3
which mkfs.cetra fsck.cetra defrag.cetra growfs.cetra
```

The module's `version` ends in `+src.` and a hash of the source it was built from, so you can tell which release each node runs.

You don't need to load the module by hand or add it to `/etc/modules-load.d`. The module declares the `fs-cetrafs` alias, so the first `mount -t cetrafs` loads it, just as with an in-tree filesystem. That includes mounts from `/etc/fstab` at boot and mounts made by a cluster manager.

## Upgrade

Download the new release and install it the same way, on every node. Before you upgrade, read the release notes: if the on-disk format version changed, the new module can't mount the old volume, and you have to [move the data and reformat](/docs/how-tos/upgrade-reformat/). Upgrading from 0.9.x to 0.10 is such a change.

Keep `cetrafs-dkms` and `cetrafs-tools` at the same version. An older `fsck.cetra` run against a volume from a newer module can misread the format and report corruption that isn't there.

## After a kernel upgrade

Install the headers for the new kernel at the same time as the kernel itself (on Proxmox, the `proxmox-headers-*` package that matches the kernel). DKMS then rebuilds `cetrafs.ko` automatically.

DKMS builds cetrafs only for kernels 7.0 to 7.2, the range its sources were written against, and skips any other kernel. A node that boots a kernel outside that range has no cetrafs. Keep the running kernel pinned (on Proxmox, `proxmox-boot-tool kernel pin <version>`), and move the pin only after `dkms status cetrafs` lists the module as installed for the new kernel.

## Build the packages yourself

To package an unreleased commit, or for an architecture without released packages. On a build host (it can be one of the cluster nodes):

```sh
sudo apt install debhelper dh-dkms build-essential     # build dependencies, once
git clone https://github.com/cetrafs/cetrafs.git
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
Package builds skip the test suite: it needs root, loads the module and takes hours. For an unreleased commit, run `make check` yourself before you deploy it. See [Run the test suites](/docs/how-tos/run-tests/).
{{< /callout >}}

Copy both `.deb` files to each node and install them with `apt install ./<file>.deb`, as above.

## Related

- [Install on Proxmox VE](/docs/how-tos/install-proxmox/), with the storage plugin.
- [Install with DKMS](/docs/how-tos/install-dkms/) without packaging.
- [Build and install from source](/docs/how-tos/build-from-source/).
