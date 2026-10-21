---
weight: 315
title: "Build and install from source"
description: "Build the kernel module and tools with make, and install them by hand so the module loads automatically on mount."
toc: true
---

## Prerequisites

```sh
sudo apt install build-essential linux-headers-$(uname -r)
```

The module is built against the headers of **one specific kernel**. The tools are plain C and have no kernel dependency.

## Build

```sh
git clone <repo-url> cetrafs      # the public repository URL is coming soon
cd cetrafs
make              # kernel module + userspace tools
```

Or build each half on its own:

```sh
make userspace    # mkfs.cetra, fsck.cetra, defrag.cetra
make mod          # kmod/cetrafs.ko
```

To build the module for a kernel other than the running one, pass its build tree:

```sh
make mod KDIR=/lib/modules/<version>/build
```

Both the module and the tools build with `-Werror`. If you are bisecting on an unrelated kernel or compiler combination and need to get past a warning, set `CETRAFS_NO_WERROR=1`.

## Install

There is no `make install` target. Copy the tools onto your `PATH` and put the module where `modprobe` can find it:

```sh
sudo install -m 0755 userspace/mkfs.cetra userspace/fsck.cetra userspace/defrag.cetra /usr/local/sbin/
sudo install -D -m 0644 kmod/cetrafs.ko /lib/modules/$(uname -r)/extra/cetrafs.ko
sudo depmod -a
```

That's all. The module declares the `fs-cetrafs` alias, so the first `mount -t cetrafs` loads it, including mounts from `/etc/fstab`. You don't need a `/etc/modules-load.d` entry.

## Load by hand (optional)

To try a fresh build without installing it:

```sh
sudo insmod kmod/cetrafs.ko
grep cetrafs /proc/filesystems
```

If `insmod` fails with an unknown `crc32c` symbol, your kernel has CRC32C as a module. Run `sudo modprobe libcrc32c` and retry. (`modprobe` resolves this by itself; `insmod` doesn't.)

## After a kernel upgrade

A module built for one kernel won't load on another. Rebuild and reinstall after every kernel upgrade, or use [DKMS](/docs/how-tos/install-dkms/) so it happens automatically.

## Validate the build (optional)

```sh
sudo make check
```

This runs the loop-device test suite. It never touches a real device. See [Run the test suites](/docs/how-tos/run-tests/).
