---
weight: 308
title: "Load the module with Secure Boot"
linkTitle: "Secure Boot"
description: "Enroll the DKMS signing key on each node so a kernel with Secure Boot accepts cetrafs.ko, and fix \"Key was rejected by service\"."
toc: true
---

With Secure Boot enabled, the kernel only loads modules signed by a key it trusts. DKMS signs every module it builds, `cetrafs.ko` included, with its own key, `/var/lib/dkms/mok.pub`. Until that key is enrolled in the firmware's MOK (Machine Owner Key) list, the kernel refuses the module:

```text
modprobe: ERROR: could not insert 'cetrafs': Key was rejected by service
```

A `mount -t cetrafs` that loads the module fails the same way, with `unknown filesystem type 'cetrafs'`, and so does adding the storage in the Proxmox web UI. Any module built by DKMS behaves like this; it isn't specific to cetrafs. Enroll the key once per node, and every later DKMS build, for every kernel, is accepted.

## Confirm it is Secure Boot

On the node:

```sh
mokutil --sb-state                              # SecureBoot enabled
dmesg | grep -i -e lockdown -e signature
mokutil --test-key /var/lib/dkms/mok.pub        # is not enrolled
```

## Enroll the DKMS key

On **each** node, at its console, because the second step happens in the firmware before the operating system starts:

1. Ask for the key to be enrolled:

   ```sh
   mokutil --import /var/lib/dkms/mok.pub
   ```

   You choose a one-time password; you need it once, at the next boot.

2. Reboot. At the blue MokManager screen choose **Enroll MOK → Continue → Yes**, enter the password, and reboot again. If nobody answers it in time, the node boots on without enrolling the key; start again from step 1.

3. Check the key and load the module:

   ```sh
   mokutil --test-key /var/lib/dkms/mok.pub     # is already enrolled
   modprobe cetrafs
   ```

If `/var/lib/dkms/mok.pub` doesn't exist, DKMS hasn't built anything yet. It creates the key with its first build: install `cetrafs-dkms` first.

## Modules you build yourself

A module built with `make mod` ([Build and install from source](/docs/how-tos/build-from-source/)) is not signed, and Secure Boot refuses it with `Key was rejected by service` or `Required key not available`. Sign it with the enrolled DKMS key before you load or install it:

```sh
sudo /lib/modules/$(uname -r)/build/scripts/sign-file sha256 \
    /var/lib/dkms/mok.key /var/lib/dkms/mok.pub kmod/cetrafs.ko
```

Sign it again after every rebuild. The [Debian packages](/docs/how-tos/install-packages/) and [DKMS](/docs/how-tos/install-dkms/) do this for you.

## Without enrolling a key

Turning Secure Boot off in the firmware setup also works.

## Related

- [Install from Debian packages](/docs/how-tos/install-packages/).
- [Install on Proxmox VE](/docs/how-tos/install-proxmox/).
- [Troubleshooting](/docs/reference/troubleshooting/#loading-the-module).
